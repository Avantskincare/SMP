require("dotenv").config();

const axios = require("axios");
const crypto = require("crypto");

// ======================================================
// CONFIG
// ======================================================

const UNLEASHED_API_URL =
  process.env.UNLEASHED_API_URL ||
  "https://api.unleashedsoftware.com/";

const UNLEASHED_AUTH_ID =
  process.env.UNLEASHED_AUTH_ID;

const UNLEASHED_API_KEY =
  process.env.UNLEASHED_API_KEY;

const RESEND_API_KEY =
  process.env.RESEND_API_KEY;

const REPORT_RECIPIENTS = [
  "alioune@avant-skincare.com",
  "mindaugas@avant-skincare.com"
];

const RESEND_FROM =
  "Customer Service <customerservice@avant-skincare.com>";

// ======================================================
// VALIDATE ENV
// ======================================================

function validateEnvironment() {
  const missing = [];

  if (!UNLEASHED_AUTH_ID) {
    missing.push("UNLEASHED_AUTH_ID");
  }

  if (!UNLEASHED_API_KEY) {
    missing.push("UNLEASHED_API_KEY");
  }

  if (!RESEND_API_KEY) {
    missing.push("RESEND_API_KEY");
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}`
    );
  }
}

// ======================================================
// UNLEASHED AUTH
// ======================================================

function getUnleashedHeaders(queryString = "") {
  const signature = crypto
    .createHmac(
      "sha256",
      UNLEASHED_API_KEY
    )
    .update(queryString)
    .digest("base64");

  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "api-auth-id": UNLEASHED_AUTH_ID,
    "api-auth-signature": signature,
    "client-type": "inhouse/smpweeklyreport"
  };
}

// ======================================================
// DATE HELPERS
// Report period = Monday -> current day
// Uses Europe/London calendar date
// ======================================================

function getLondonToday() {
  const formatter =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "Europe/London",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    );

  const parts =
    formatter.formatToParts(
      new Date()
    );

  const values = {};

  parts.forEach((part) => {
    if (
      part.type === "year" ||
      part.type === "month" ||
      part.type === "day"
    ) {
      values[part.type] =
        Number(part.value);
    }
  });

  return new Date(
    Date.UTC(
      values.year,
      values.month - 1,
      values.day
    )
  );
}

function addDays(date, days) {
  const result =
    new Date(date);

  result.setUTCDate(
    result.getUTCDate() + days
  );

  return result;
}

function formatApiDate(date) {
  return date
    .toISOString()
    .slice(0, 10);
}

function formatDisplayDate(date) {
  return new Intl.DateTimeFormat(
    "en-GB",
    {
      timeZone: "UTC",
      day: "2-digit",
      month: "short",
      year: "numeric"
    }
  ).format(date);
}

function getReportPeriod() {
  const today =
    getLondonToday();

  const dayOfWeek =
    today.getUTCDay();

  // Sunday = 0, Monday = 1
  const daysSinceMonday =
    dayOfWeek === 0
      ? 6
      : dayOfWeek - 1;

  const monday =
    addDays(
      today,
      -daysSinceMonday
    );

  return {
    startDate: monday,
    endDate: today
  };
}

// ======================================================
// ORDER DATE NORMALIZER
// ======================================================

function getOrderDateValue(order) {
  const value =
    order.OrderDate ||
    order.CreatedOn ||
    "";

  if (!value) {
    return null;
  }

  // Standard ISO date
  const isoMatch =
    String(value).match(
      /^(\d{4}-\d{2}-\d{2})/
    );

  if (isoMatch) {
    return isoMatch[1];
  }

  // Microsoft JSON date format fallback
  const msMatch =
    String(value).match(
      /\/Date\((\d+)/
    );

  if (msMatch) {
    return new Date(
      Number(msMatch[1])
    )
      .toISOString()
      .slice(0, 10);
  }

  const parsed =
    new Date(value);

  if (
    !Number.isNaN(
      parsed.getTime()
    )
  ) {
    return parsed
      .toISOString()
      .slice(0, 10);
  }

  return null;
}

// ======================================================
// GET SALES PERSON
// ======================================================

function getRequesterEmail(order) {
  const comments =
    String(
      order.Comments || ""
    );

  const match =
    comments.match(
      /Requester email:\s*([^\s|]+)/i
    );

  return match
    ? match[1]
        .trim()
        .toLowerCase()
    : "";
}

function getRequesterName(order) {
  const comments =
    String(
      order.Comments || ""
    );

  const match =
    comments.match(
      /Requested by:\s*([^|]+)/i
    );

  if (match) {
    return match[1].trim();
  }

  return (
    order.Salesperson?.FullName ||
    order.Salesperson?.Name ||
    order.SalesPerson?.FullName ||
    order.SalesPerson?.Name ||
    "Unknown Sales Person"
  );
}

// ======================================================
// GET PRODUCT SKU
// ======================================================

function getLineSku(line) {
  return String(
    line.Product?.ProductCode ||
    line.ProductCode ||
    line.SKU ||
    ""
  )
    .trim()
    .toUpperCase();
}

function getLineQuantity(line) {
  return Number(
    line.OrderQuantity ??
    line.Quantity ??
    0
  ) || 0;
}

// ======================================================
// GET SMP SALES ORDERS FROM UNLEASHED
// ======================================================

async function getSmpOrders(
  startDate,
  endDate
) {
  /*
   * We expand the API date range by one day on each side
   * and then filter locally.
   *
   * This avoids edge cases caused by Unleashed describing
   * startDate/endDate as "after" and "before".
   */

  const apiStartDate =
    formatApiDate(
      addDays(
        startDate,
        -1
      )
    );

  const apiEndDate =
    formatApiDate(
      addDays(
        endDate,
        1
      )
    );

  const wantedStart =
    formatApiDate(startDate);

  const wantedEnd =
    formatApiDate(endDate);

  const allOrders = [];

  let page = 1;
  let totalPages = 1;

  console.log(
    `Fetching SMP orders for ${wantedStart} to ${wantedEnd}...`
  );

  do {
    const queryString =
      `customerCode=SMP&startDate=${apiStartDate}&endDate=${apiEndDate}&pageSize=1000`;

    const url =
      `${UNLEASHED_API_URL}SalesOrders/${page}?${queryString}`;

    console.log(
      `Fetching Unleashed Sales Orders page ${page}...`
    );

    const response =
      await axios.get(
        url,
        {
          headers:
            getUnleashedHeaders(
              queryString
            )
        }
      );

    const orders =
      response.data?.Items || [];

    orders.forEach((order) => {
      const customerCode =
        String(
          order.Customer
            ?.CustomerCode ||
          order.CustomerCode ||
          ""
        )
          .trim()
          .toUpperCase();

      // Exact customer match only
      if (
        customerCode !== "SMP"
      ) {
        return;
      }

      const orderDate =
        getOrderDateValue(
          order
        );

      if (!orderDate) {
        return;
      }

      // Exact Monday -> report day filtering
      if (
        orderDate >= wantedStart &&
        orderDate <= wantedEnd
      ) {
        allOrders.push(order);
      }
    });

    totalPages =
      Number(
        response.data
          ?.Pagination
          ?.NumberOfPages
      ) || 1;

    console.log(
      `Page ${page}/${totalPages} loaded.`
    );

    page++;

  } while (
    page <= totalPages
  );

  console.log(
    `Found ${allOrders.length} SMP orders for the report period.`
  );

  return allOrders;
}

// ======================================================
// BUILD REPORT DATA
// ======================================================

function buildReportData(orders) {
  const salesPeople =
    new Map();

  let totalUnits = 0;

  orders.forEach((order) => {
    const requesterName =
      getRequesterName(order);

    const requesterEmail =
      getRequesterEmail(order);

    const key =
      requesterEmail ||
      requesterName.toLowerCase();

    if (
      !salesPeople.has(key)
    ) {
      salesPeople.set(
        key,
        {
          name:
            requesterName,

          email:
            requesterEmail,

          orderNumbers:
            new Set(),

          products:
            new Map(),

          totalUnits:
            0
        }
      );
    }

    const salesPerson =
      salesPeople.get(key);

    if (
      order.OrderNumber
    ) {
      salesPerson
        .orderNumbers
        .add(
          order.OrderNumber
        );
    }

    const lines =
      order.SalesOrderLines ||
      order.OrderLines ||
      [];

    lines.forEach((line) => {
      const sku =
        getLineSku(line);

      const quantity =
        getLineQuantity(line);

      if (
        !sku ||
        quantity <= 0
      ) {
        return;
      }

      const existingQuantity =
        salesPerson
          .products
          .get(sku) || 0;

      salesPerson
        .products
        .set(
          sku,
          existingQuantity +
          quantity
        );

      salesPerson.totalUnits +=
        quantity;

      totalUnits +=
        quantity;
    });
  });

  const people =
    Array.from(
      salesPeople.values()
    );

  people.sort(
    (a, b) =>
      a.name.localeCompare(
        b.name
      )
  );

  return {
    people,
    totalOrders:
      orders.length,
    totalUnits
  };
}

// ======================================================
// HTML ESCAPE
// ======================================================

function escapeHtml(value) {
  return String(value || "")
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}

// ======================================================
// BUILD HTML REPORT
// ======================================================

function buildHtmlReport(
  report,
  startDate,
  endDate
) {
  const period =
    `${formatDisplayDate(startDate)} - ${formatDisplayDate(endDate)}`;

  let salesPersonSections =
    "";

  report.people.forEach(
    (person) => {
      const products =
        Array.from(
          person.products.entries()
        )
          .sort(
            ([skuA], [skuB]) =>
              skuA.localeCompare(
                skuB
              )
          );

      let rows = "";

      products.forEach(
        ([sku, quantity]) => {
          rows += `
            <tr>
              <td style="padding:8px 10px;border-bottom:1px solid #eeeeee;">
                ${escapeHtml(sku)}
              </td>
              <td style="padding:8px 10px;border-bottom:1px solid #eeeeee;text-align:right;font-weight:600;">
                ${quantity}
              </td>
            </tr>
          `;
        }
      );

      salesPersonSections += `
        <div style="margin-top:28px;">
          <h3 style="margin:0 0 4px 0;color:#172b4d;">
            ${escapeHtml(person.name)}
          </h3>

          ${
            person.email
              ? `
                <div style="color:#6b778c;font-size:13px;margin-bottom:10px;">
                  ${escapeHtml(person.email)}
                </div>
              `
              : ""
          }

          <div style="font-size:13px;color:#6b778c;margin-bottom:10px;">
            Orders: ${person.orderNumbers.size}
            &nbsp; | &nbsp;
            Total units: ${person.totalUnits}
          </div>

          <table
            style="
              width:100%;
              border-collapse:collapse;
              border:1px solid #eeeeee;
            "
          >
            <thead>
              <tr style="background:#f4f5f7;">
                <th style="padding:8px 10px;text-align:left;">
                  SKU
                </th>
                <th style="padding:8px 10px;text-align:right;">
                  Quantity
                </th>
              </tr>
            </thead>

            <tbody>
              ${
                rows ||
                `
                  <tr>
                    <td colspan="2" style="padding:10px;">
                      No product lines found.
                    </td>
                  </tr>
                `
              }
            </tbody>
          </table>
        </div>
      `;
    }
  );

  if (
    report.people.length === 0
  ) {
    salesPersonSections = `
      <div
        style="
          padding:20px;
          background:#f4f5f7;
          border-radius:6px;
          margin-top:20px;
        "
      >
        No SMP orders were created during this reporting period.
      </div>
    `;
  }

  return `
    <!DOCTYPE html>

    <html>
      <body
        style="
          margin:0;
          padding:20px;
          background:#f4f5f7;
          font-family:Arial,sans-serif;
          color:#172b4d;
        "
      >

        <div
          style="
            max-width:750px;
            margin:0 auto;
            background:#ffffff;
            padding:30px;
            border-radius:8px;
          "
        >

          <h1
            style="
              margin-top:0;
              font-size:24px;
            "
          >
            SMP Weekly Report
          </h1>

          <p
            style="
              color:#6b778c;
              margin-top:0;
            "
          >
            ${escapeHtml(period)}
          </p>

          <div
            style="
              display:block;
              margin:25px 0;
              padding:18px;
              background:#f4f5f7;
              border-radius:6px;
            "
          >
            <strong>
              SMP Orders:
            </strong>
            ${report.totalOrders}

            &nbsp;&nbsp; | &nbsp;&nbsp;

            <strong>
              Total Units:
            </strong>
            ${report.totalUnits}

            &nbsp;&nbsp; | &nbsp;&nbsp;

            <strong>
              Sales Persons:
            </strong>
            ${report.people.length}
          </div>

          ${salesPersonSections}

          <p
            style="
              margin-top:35px;
              color:#8993a4;
              font-size:12px;
            "
          >
            This report was generated automatically from Unleashed SMP sales orders.
          </p>

        </div>

      </body>
    </html>
  `;
}

// ======================================================
// BUILD TEXT REPORT
// ======================================================

function buildTextReport(
  report,
  startDate,
  endDate
) {
  const lines = [];

  lines.push(
    "SMP Weekly Report"
  );

  lines.push(
    `${formatDisplayDate(startDate)} - ${formatDisplayDate(endDate)}`
  );

  lines.push("");

  lines.push(
    `SMP Orders: ${report.totalOrders}`
  );

  lines.push(
    `Total Units: ${report.totalUnits}`
  );

  lines.push(
    `Sales Persons: ${report.people.length}`
  );

  lines.push("");

  if (
    report.people.length === 0
  ) {
    lines.push(
      "No SMP orders were created during this reporting period."
    );

    return lines.join("\n");
  }

  report.people.forEach(
    (person) => {
      lines.push(
        "----------------------------------------"
      );

      lines.push(
        person.name
      );

      if (
        person.email
      ) {
        lines.push(
          person.email
        );
      }

      lines.push(
        `Orders: ${person.orderNumbers.size}`
      );

      lines.push(
        `Total units: ${person.totalUnits}`
      );

      lines.push("");

      const products =
        Array.from(
          person.products.entries()
        )
          .sort(
            ([skuA], [skuB]) =>
              skuA.localeCompare(
                skuB
              )
          );

      products.forEach(
        ([sku, quantity]) => {
          lines.push(
            `${sku}: ${quantity}`
          );
        }
      );

      lines.push("");
    }
  );

  return lines.join("\n");
}

// ======================================================
// SEND REPORT THROUGH RESEND
// ======================================================

async function sendReport(
  report,
  startDate,
  endDate
) {
  const subject =
    `SMP Weekly Report - ${formatDisplayDate(startDate)} to ${formatDisplayDate(endDate)}`;

  const html =
    buildHtmlReport(
      report,
      startDate,
      endDate
    );

  const text =
    buildTextReport(
      report,
      startDate,
      endDate
    );

  console.log(
    `Sending weekly SMP report to ${REPORT_RECIPIENTS.join(", ")}...`
  );

  const response =
    await axios.post(
      "https://api.resend.com/emails",
      {
        from:
          RESEND_FROM,

        to:
          REPORT_RECIPIENTS,

        subject,

        html,

        text
      },
      {
        headers: {
          Authorization:
            `Bearer ${RESEND_API_KEY}`,

          "Content-Type":
            "application/json"
        }
      }
    );

  console.log(
    `Weekly SMP report sent successfully. Resend ID: ${response.data?.id || "unknown"}`
  );

  return response.data;
}

// ======================================================
// RUN REPORT
// ======================================================

async function run() {
  try {
    console.log(
      "Starting SMP weekly report..."
    );

    validateEnvironment();

    const {
      startDate,
      endDate
    } =
      getReportPeriod();

    console.log(
      `Report period: ${formatApiDate(startDate)} to ${formatApiDate(endDate)}`
    );

    const orders =
      await getSmpOrders(
        startDate,
        endDate
      );

    const report =
      buildReportData(
        orders
      );

    console.log(
      `Report summary: ${report.totalOrders} orders, ${report.totalUnits} units, ${report.people.length} Sales Persons.`
    );

    report.people.forEach(
      (person) => {
        console.log(
          `${person.name}: ${person.orderNumbers.size} orders, ${person.totalUnits} units.`
        );
      }
    );

    await sendReport(
      report,
      startDate,
      endDate
    );

    console.log(
      "SMP weekly report completed successfully."
    );

    process.exit(0);

  } catch (error) {
    console.error(
      "SMP weekly report failed."
    );

    if (error.response) {
      console.error(
        "HTTP status:",
        error.response.status
      );

      console.error(
        "API response:",
        JSON.stringify(
          error.response.data,
          null,
          2
        )
      );

      console.error(
        "Request URL:",
        error.config?.url
      );

    } else {
      console.error(
        error.stack ||
        error.message
      );
    }

    process.exit(1);
  }
}

run();