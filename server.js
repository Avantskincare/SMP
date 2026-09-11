require("dotenv").config();

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createSendcloudParcel } = require("./sendcloudService");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, "catalog_cache.json");

// ======================================================
// UNLEASHED CONFIG
// ======================================================

const UNLEASHED_API_URL =
  process.env.UNLEASHED_API_URL ||
  "https://api.unleashedsoftware.com/";

const UNLEASHED_AUTH_ID =
  process.env.UNLEASHED_AUTH_ID;

const UNLEASHED_API_KEY =
  process.env.UNLEASHED_API_KEY;

// ======================================================
// CACHE
// ======================================================

let cachedProducts = [];
let cachedSalesPersons = [];
let isRefreshing = false;

// ======================================================
// BRANDS
// ======================================================

const UNLEASHED_BRANDS = [
  "Able",
  "Avant",
  "Flanerie",
  "Mix",
  "Sentier",
  "Symbiosis"
];

// ======================================================
// ALLOWED SALES PERSON EMAILS
// ======================================================

const ALLOWED_SALES_EMAILS = [
  "muhammad@avant-skincare.com",
  "pamela@flanerie-skincare.com",
  "e.ducamp@avant-skincare.com",
  "zilvinas@avant-skincare.com",
  "charlotte.murdock@avant-skincare.com",
  "tayyaba@avant-skincare.com",
  "cara@avant-skincare.com",
  "celine@sentierfragrance.com",
  "matthani@avant-skincare.com",
  "anita@avant-skincare.com"
];

// ======================================================
// ALLOWED PRODUCT SKU PREFIXES
// ======================================================

const ALLOWED_SKU_PREFIXES = [
  "AV",
  "AVK",
  "AVX",
  "AB",
  "ABK",
  "ABX",
  "SY",
  "SYK",
  "SYX",
  "SR",
  "SRK",
  "SRX",
  "FL",
  "FLK",
  "FLX"
];

// ======================================================
// EU COUNTRIES
// ======================================================

const EU_COUNTRIES = [
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK"
];

// ======================================================
// UNLEASHED AUTH
// ======================================================

function getUnleashedHeaders(queryString = "") {
  const signature = crypto
    .createHmac("sha256", UNLEASHED_API_KEY)
    .update(queryString)
    .digest("base64");

  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "api-auth-id": UNLEASHED_AUTH_ID,
    "api-auth-signature": signature,
    "client-type": "inhouse/smpportal"
  };
}

// ======================================================
// GUID GENERATOR
// ======================================================

function generateGUID() {
  const randomBytes = crypto.randomBytes(16);

  randomBytes[6] =
    (randomBytes[6] & 0x0f) | 0x40;

  randomBytes[8] =
    (randomBytes[8] & 0x3f) | 0x80;

  return [...randomBytes]
    .map(
      (b, i) =>
        ([4, 6, 8, 10].includes(i) ? "-" : "") +
        b.toString(16).padStart(2, "0")
    )
    .join("");
}

// ======================================================
// REFRESH PRODUCTS + SALES PERSONS
// ======================================================

async function refreshProductCatalog() {
  if (isRefreshing) {
    console.log(
      "Catalog refresh is already running. Skipping duplicate refresh."
    );

    return;
  }

  isRefreshing = true;

  try {
    console.log(
      "Refreshing Unleashed product catalog..."
    );

    const uniqueProductsMap = new Map();

    let page = 1;
    let totalPages = 1;

    do {
      const queryString =
        `pageSize=1000&page=${page}&includeObsolete=false`;

      const url =
        `${UNLEASHED_API_URL}Products?${queryString}`;

      const response = await axios.get(
        url,
        {
          headers:
            getUnleashedHeaders(queryString)
        }
      );

      const items =
        response.data?.Items || [];

      items.forEach((p) => {
        const sku =
          String(
            p.ProductCode || ""
          )
            .trim()
            .toUpperCase();

        const matchesPrefix =
          ALLOWED_SKU_PREFIXES.some(
            (prefix) =>
              sku.startsWith(prefix)
          );

        if (
          sku &&
          p.IsSellable === true &&
          p.IsObsolete !== true &&
          matchesPrefix
        ) {
          if (
            !uniqueProductsMap.has(sku)
          ) {
            uniqueProductsMap.set(
              sku,
              {
                sku:
                  p.ProductCode || "",

                name:
                  p.ProductDescription || "",

                brand:
                  p.ProductGroup?.GroupName ||
                  p.Brand ||
                  "Avant",

                weight:
                  Number(p.Weight) || 0.1,

                hsCode:
                  p.CustomsCode ||
                  "33049900",

                price:
                  Number(p.AverageCost) || 0
              }
            );
          }
        }
      });

      totalPages =
        Number(
          response.data?.Pagination
            ?.NumberOfPages
        ) || 1;

      page++;

    } while (page <= totalPages);

    cachedProducts =
      Array.from(
        uniqueProductsMap.values()
      );

    // ==================================================
    // SALES PERSONS
    // ==================================================

    console.log(
      "Refreshing Unleashed Sales Persons..."
    );

    try {
      const spUrl =
        `${UNLEASHED_API_URL}Salespersons`;

      const spResponse =
        await axios.get(
          spUrl,
          {
            headers:
              getUnleashedHeaders("")
          }
        );

      const emailMap =
        new Map();

      const salesPersons =
        spResponse.data?.Items || [];

      salesPersons.forEach((sp) => {
        const email =
          String(
            sp.Email || ""
          )
            .toLowerCase()
            .trim();

        if (
          email &&
          ALLOWED_SALES_EMAILS.includes(email) &&
          !emailMap.has(email)
        ) {
          emailMap.set(
            email,
            {
              guid:
                sp.Guid,

              fullName:
                sp.FullName ||
                `${sp.FirstName || ""} ${sp.LastName || ""}`.trim(),

              email,

              code:
                sp.SalespersonCode ||
                email
            }
          );
        }
      });

      cachedSalesPersons =
        Array.from(
          emailMap.values()
        );

    } catch (error) {
      console.error(
        "Failed to refresh Sales Persons:",
        error.response?.data ||
        error.message
      );
    }

    // ==================================================
    // SAVE CACHE
    // ==================================================

    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify(
        {
          products:
            cachedProducts,

          salesPersons:
            cachedSalesPersons
        },
        null,
        2
      )
    );

    console.log(
      `Catalog refreshed successfully: ${cachedProducts.length} products, ${cachedSalesPersons.length} Sales Persons.`
    );

  } catch (error) {
    console.error(
      "Failed to refresh Unleashed catalog:",
      error.response?.data ||
      error.message
    );

    if (fs.existsSync(CACHE_FILE)) {
      try {
        const cachedData =
          JSON.parse(
            fs.readFileSync(
              CACHE_FILE,
              "utf8"
            )
          );

        cachedProducts =
          cachedData.products || [];

        cachedSalesPersons =
          cachedData.salesPersons || [];

        console.log(
          "Loaded existing catalog cache from disk."
        );

      } catch (cacheError) {
        console.error(
          "Failed to load disk cache:",
          cacheError.message
        );
      }
    }

  } finally {
    isRefreshing = false;
  }
}

// ======================================================
// LOAD CACHE AT STARTUP
// ======================================================

if (fs.existsSync(CACHE_FILE)) {
  try {
    const cachedData =
      JSON.parse(
        fs.readFileSync(
          CACHE_FILE,
          "utf8"
        )
      );

    cachedProducts =
      cachedData.products || [];

    cachedSalesPersons =
      cachedData.salesPersons || [];

    console.log(
      `Disk cache loaded: ${cachedProducts.length} products, ${cachedSalesPersons.length} Sales Persons.`
    );

    refreshProductCatalog();

  } catch (error) {
    console.error(
      "Failed to read catalog cache. Refreshing from Unleashed."
    );

    refreshProductCatalog();
  }

} else {
  refreshProductCatalog();
}

// Refresh every 12 hours
setInterval(
  refreshProductCatalog,
  12 * 60 * 60 * 1000
);

// ======================================================
// PRODUCTS API
// ======================================================

app.get(
  "/api/products",
  async (req, res) => {
    try {
      if (
        cachedProducts.length === 0 &&
        !isRefreshing
      ) {
        await refreshProductCatalog();
      }

      res.json({
        products:
          cachedProducts,

        brands:
          UNLEASHED_BRANDS,

        salesPersons:
          cachedSalesPersons
      });

    } catch (error) {
      console.error(
        "Failed to return product catalog:",
        error.message
      );

      res.status(500).json({
        success: false,
        error:
          "Unable to load product catalog."
      });
    }
  }
);

// ======================================================
// CREATE SMP ORDER
// ======================================================

app.post(
  "/api/create-smp-order",
  async (req, res) => {
    try {
      const data = req.body;

      // ==================================================
      // BASIC VALIDATION
      // ==================================================

      if (
        !Array.isArray(data.items) ||
        data.items.length === 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "At least one product is required."
          });
      }

      if (!data.brand) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Brand is required."
          });
      }

      if (!data.country) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Country is required."
          });
      }

      // ==================================================
      // COUNTRY ROUTING
      // ==================================================

      const countryCode =
        String(
          data.country || ""
        )
          .trim()
          .toUpperCase();

      const isEU =
        EU_COUNTRIES.includes(
          countryCode
        );

      let warehouseCode;
      let currencyCode;

      const customerCode =
        "SMP";

      if (countryCode === "US") {
        warehouseCode =
          "UK_W1";

        currencyCode =
          "USD";

      } else if (countryCode === "GB") {
        warehouseCode =
          "UK_W1";

        currencyCode =
          "GBP";

      } else if (isEU) {
        warehouseCode =
          "FR_Atypic";

        currencyCode =
          "EUR";

      } else {
        warehouseCode =
          "UK_W1";

        currencyCode =
          "GBP";
      }

      console.log(
        `Routing ${countryCode}: Customer=${customerCode}, Warehouse=${warehouseCode}, Currency=${currencyCode}`
      );

      // ==================================================
      // SALES PERSON
      // ==================================================

      const requestedSalesEmail =
        String(
          data.requestedByEmail ||
          data.salesPerson ||
          ""
        )
          .toLowerCase()
          .trim();

      const selectedSalesPerson =
        cachedSalesPersons.find(
          (sp) =>
            sp.email ===
            requestedSalesEmail
        );

      if (!selectedSalesPerson) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              `Sales Person not found: ${requestedSalesEmail}`
          });
      }

      if (!selectedSalesPerson.guid) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              `Sales Person ${selectedSalesPerson.email} does not have an Unleashed GUID.`
          });
      }

      // ==================================================
      // ORDER NUMBER / GUID
      // ==================================================

      const orderGuid =
        generateGUID();

      const orderNumber =
        `SMP-${Date.now()
          .toString()
          .slice(-6)}`;

      const now =
        new Date().toISOString();

      // ==================================================
      // ORDER LINES
      // ==================================================

      const salesOrderLines =
        data.items.map(
          (item, index) => ({
            Guid:
              generateGUID(),

            LineNumber:
              index + 1,

            Product: {
              ProductCode:
                String(
                  item.sku
                ).trim()
            },

            OrderQuantity:
              Number(
                item.quantity
              ) || 1,

            UnitPrice:
              0,

            LineTotal:
              0,

            LineTax:
              0,

            DiscountRate:
              0,

            TaxCode:
              "NONE",

            TaxRate:
              0,

            SalesOrderGroup:
              data.brand
          })
        );

      // ==================================================
      // COMMENTS
      // ==================================================

      const comments = [
        `Requested by: ${selectedSalesPerson.fullName}`,
        `Requester email: ${selectedSalesPerson.email}`,
        `Brand: ${data.brand}`,
        `Black Box Required: ${data.blackBoxRequired || "N/A"}`,
        `Recipient email: ${data.recipientEmail || "N/A"}`,
        `Phone: ${data.phone || "N/A"}`,
        data.partnerCompany
          ? `Company: ${data.partnerCompany}`
          : null
      ]
        .filter(Boolean)
        .join(" | ");

      // ==================================================
      // UNLEASHED PAYLOAD
      // ==================================================

      const unleashedPayload = {
        Guid:
          orderGuid,

        OrderNumber:
          orderNumber,

        OrderDate:
          now,

        RequiredDate:
          now,

        OrderStatus:
          "Parked",

        Customer: {
          CustomerCode:
            customerCode
        },

        CustomerRef:
          orderNumber,

        Brand:
          data.brand,

        SalesOrderGroup:
          data.brand,

        Salesperson: {
          Guid:
            selectedSalesPerson.guid
        },

        Warehouse: {
          WarehouseCode:
            warehouseCode
        },

        Currency: {
          CurrencyCode:
            currencyCode
        },

        DeliveryName:
          data.recipientName || "",

        DeliveryStreetAddress:
          data.streetAddress || "",

        DeliveryStreetAddress2:
          data.streetAddress2 || "",

        DeliverySuburb:
          "",

        DeliveryCity:
          data.city || "",

        DeliveryRegion:
          data.region || "",

        DeliveryPostCode:
          data.postCode || "",

        DeliveryCountry:
          countryCode,

        SubTotal:
          0,

        TaxTotal:
          0,

        Total:
          0,

        Tax: {
          TaxCode:
            "NONE",

          TaxRate:
            0
        },

        ExchangeRate:
          1,

        Comments:
          comments,

        SalesOrderLines:
          salesOrderLines
      };

      // ==================================================
      // CREATE UNLEASHED ORDER
      // ==================================================

      console.log(
        `Creating SMP order ${orderNumber} in Unleashed...`
      );

      console.log(
        `Sales Person: ${selectedSalesPerson.fullName} (${selectedSalesPerson.email})`
      );

      console.log(
        `Brand: ${data.brand}`
      );

      console.log(
        `Warehouse: ${warehouseCode}`
      );

      console.log(
        `Currency: ${currencyCode}`
      );

      const unleashedUrl =
        `${UNLEASHED_API_URL}SalesOrders/${orderGuid}`;

      const unleashedRes =
        await axios.post(
          unleashedUrl,
          JSON.stringify(
            unleashedPayload
          ),
          {
            headers:
              getUnleashedHeaders("")
          }
        );

      console.log(
        `Order ${orderNumber} created successfully in Unleashed.`
      );

      // ==================================================
      // CREATE SENDCLOUD PARCEL
      // ==================================================

      console.log(
        `Creating Sendcloud parcel for ${orderNumber} (${countryCode})...`
      );

      const sendcloudResult =
        await createSendcloudParcel(
          data,
          orderNumber
        );

      console.log(
        "Sendcloud result:",
        JSON.stringify(
          sendcloudResult,
          null,
          2
        )
      );

      if (sendcloudResult.success) {
        console.log(
          `Sendcloud parcel created successfully for ${orderNumber}.`
        );

      } else {
        console.error(
          `Unleashed order ${orderNumber} was created, but Sendcloud parcel creation failed:`,
          sendcloudResult.error ||
          sendcloudResult.reason ||
          "Unknown Sendcloud error"
        );
      }

      // ==================================================
      // RESPONSE
      // ==================================================

      return res.json({
        success:
          true,

        orderNumber,

        orderGuid,

        customerAssigned:
          customerCode,

        warehouseAssigned:
          warehouseCode,

        currencyAssigned:
          currencyCode,

        brand:
          data.brand,

        salesPerson: {
          name:
            selectedSalesPerson.fullName,

          email:
            selectedSalesPerson.email
        },

        unleashedResponse:
          unleashedRes.data,

        sendcloudSuccess:
          Boolean(
            sendcloudResult.success
          ),

        sendcloudParcelId:
          sendcloudResult.parcel?.id ||
          null,

        sendcloudError:
          sendcloudResult.success
            ? null
            : (
                sendcloudResult.error ||
                sendcloudResult.reason ||
                null
              )
      });

    } catch (error) {
      console.error(
        "SMP order processing failed."
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

        console.error(
          "Request body:",
          error.config?.data
        );

      } else {
        console.error(
          error.stack ||
          error.message
        );
      }

      return res
        .status(500)
        .json({
          success:
            false,

          error:
            error.response?.data?.Description ||
            error.response?.data ||
            error.message
        });
    }
  }
);

// ======================================================
// GET SMP ORDER FROM UNLEASHED
// ======================================================

async function getSmpOrderFromUnleashed(orderNumber) {
  const queryString =
    `orderNumber=${encodeURIComponent(orderNumber)}`;

  const url =
    `${UNLEASHED_API_URL}SalesOrders?${queryString}`;

  console.log(
    `Looking up Unleashed order ${orderNumber}...`
  );

  const response =
    await axios.get(
      url,
      {
        headers:
          getUnleashedHeaders(queryString)
      }
    );

  if (
    Array.isArray(response.data?.Items) &&
    response.data.Items.length > 0
  ) {
    return response.data.Items[0];
  }

  if (
    response.data?.OrderNumber ===
    orderNumber
  ) {
    return response.data;
  }

  return null;
}

// ======================================================
// EXTRACT REQUESTER EMAIL
// ======================================================

function getRequesterEmailFromComments(comments) {
  if (!comments) {
    return null;
  }

  const match =
    String(comments).match(
      /Requester email:\s*([^\s|]+)/i
    );

  if (!match) {
    return null;
  }

  return match[1]
    .trim()
    .toLowerCase();
}

// ======================================================
// HTML ESCAPE
// ======================================================

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ======================================================
// SEND TRACKING EMAIL VIA RESEND
// ======================================================

async function sendTrackingEmailToSalesPerson({
  requesterEmail,
  orderNumber,
  recipientName,
  trackingNumber,
  trackingUrl,
  carrier,
  status
}) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error(
      "RESEND_API_KEY is not configured."
    );
  }

  if (!requesterEmail) {
    throw new Error(
      "Requester email is missing."
    );
  }

  const safeOrderNumber =
    orderNumber ||
    "SMP Order";

  const safeStatus =
    status ||
    "Tracking updated";

  const safeTrackingNumber =
    trackingNumber ||
    "Not available yet";

  const safeCarrier =
    carrier ||
    "Not available";

  const safeRecipient =
    recipientName ||
    "Not available";

  const trackingButton =
    trackingUrl
      ? `
        <p style="margin: 25px 0;">
          <a
            href="${escapeHtml(trackingUrl)}"
            style="
              background: #111111;
              color: #ffffff;
              padding: 12px 22px;
              text-decoration: none;
              border-radius: 4px;
              display: inline-block;
            "
          >
            Track shipment
          </a>
        </p>
      `
      : "";

  const html = `
    <div
      style="
        font-family: Arial, sans-serif;
        max-width: 600px;
        margin: 0 auto;
        color: #222222;
        line-height: 1.6;
      "
    >
      <h2>
        SMP Tracking Update
      </h2>

      <p>
        There is a new tracking update for your SMP order.
      </p>

      <table
        style="
          width: 100%;
          border-collapse: collapse;
        "
      >
        <tr>
          <td style="padding: 6px 0;">
            <strong>Order:</strong>
          </td>

          <td style="padding: 6px 0;">
            ${escapeHtml(safeOrderNumber)}
          </td>
        </tr>

        <tr>
          <td style="padding: 6px 0;">
            <strong>Recipient:</strong>
          </td>

          <td style="padding: 6px 0;">
            ${escapeHtml(safeRecipient)}
          </td>
        </tr>

        <tr>
          <td style="padding: 6px 0;">
            <strong>Status:</strong>
          </td>

          <td style="padding: 6px 0;">
            ${escapeHtml(safeStatus)}
          </td>
        </tr>

        <tr>
          <td style="padding: 6px 0;">
            <strong>Carrier:</strong>
          </td>

          <td style="padding: 6px 0;">
            ${escapeHtml(safeCarrier)}
          </td>
        </tr>

        <tr>
          <td style="padding: 6px 0;">
            <strong>Tracking number:</strong>
          </td>

          <td style="padding: 6px 0;">
            ${escapeHtml(safeTrackingNumber)}
          </td>
        </tr>
      </table>

      ${trackingButton}

      <p
        style="
          margin-top: 30px;
          font-size: 12px;
          color: #777777;
        "
      >
        This is an automatic SMP tracking notification.
      </p>
    </div>
  `;

  const text = `
SMP Tracking Update

Order: ${safeOrderNumber}
Recipient: ${safeRecipient}
Status: ${safeStatus}
Carrier: ${safeCarrier}
Tracking number: ${safeTrackingNumber}
Tracking link: ${trackingUrl || "Not available"}
  `.trim();

  console.log(
    `Sending tracking email for ${safeOrderNumber} to ${requesterEmail}...`
  );

  const response =
    await axios.post(
      "https://api.resend.com/emails",
      {
        from:
          "Customer Service <customerservice@avant-skincare.com>",

        to: [
          requesterEmail
        ],

        subject:
          `Tracking update - ${safeOrderNumber} - ${safeStatus}`,

        html,

        text
      },
      {
        headers: {
          Authorization:
            `Bearer ${process.env.RESEND_API_KEY}`,

          "Content-Type":
            "application/json"
        }
      }
    );

  console.log(
    `Tracking email sent successfully to ${requesterEmail}. Resend ID: ${response.data?.id || "unknown"}`
  );

  return response.data;
}

// ======================================================
// NORMALIZE SENDCLOUD WEBHOOK DATA
// ======================================================

function extractSendcloudWebhookData(body) {
  const parcel =
    body?.parcel ||
    body?.data?.parcel ||
    body?.data ||
    body;

  const orderNumber =
    parcel?.order_number ||
    parcel?.orderNumber ||
    body?.order_number ||
    body?.orderNumber ||
    null;

  const trackingNumber =
    parcel?.tracking_number ||
    parcel?.trackingNumber ||
    body?.tracking_number ||
    null;

  const trackingUrl =
    parcel?.tracking_url ||
    parcel?.trackingUrl ||
    body?.tracking_url ||
    null;

  const recipientName =
    parcel?.name ||
    parcel?.recipient_name ||
    parcel?.recipientName ||
    null;

  let status =
    null;

  if (
    typeof parcel?.status ===
    "string"
  ) {
    status =
      parcel.status;

  } else {
    status =
      parcel?.status?.message ||
      parcel?.status?.name ||
      parcel?.status?.description ||
      body?.status?.message ||
      body?.status?.name ||
      null;
  }

  let carrier =
    null;

  if (
    typeof parcel?.carrier ===
    "string"
  ) {
    carrier =
      parcel.carrier;

  } else {
    carrier =
      parcel?.carrier?.name ||
      parcel?.carrier?.code ||
      parcel?.shipment?.carrier ||
      parcel?.shipment?.name ||
      null;
  }

  return {
    parcel,
    orderNumber,
    trackingNumber,
    trackingUrl,
    recipientName,
    status,
    carrier
  };
}

// ======================================================
// SENDCLOUD WEBHOOK
// ======================================================

app.post(
  "/api/sendcloud-webhook",
  async (req, res) => {
    // Always acknowledge Sendcloud immediately
    res
      .status(200)
      .send("OK");

    try {
      console.log(
        "Sendcloud webhook received:"
      );

      console.log(
        JSON.stringify(
          req.body,
          null,
          2
        )
      );

      const webhookData =
        extractSendcloudWebhookData(
          req.body
        );

      const {
        orderNumber,
        trackingNumber,
        trackingUrl,
        recipientName,
        status,
        carrier
      } = webhookData;

      // Ignore webhook events without an order number
      if (!orderNumber) {
        console.log(
          "Webhook does not contain an order number. Skipping."
        );

        return;
      }

      // Only process SMP orders
      if (
        !String(orderNumber)
          .toUpperCase()
          .startsWith("SMP-")
      ) {
        console.log(
          `Order ${orderNumber} is not an SMP order. Skipping.`
        );

        return;
      }

      console.log(
        `Processing tracking update for ${orderNumber}.`
      );

      console.log(
        `Tracking number: ${trackingNumber || "Not available"}`
      );

      console.log(
        `Tracking URL: ${trackingUrl || "Not available"}`
      );

      console.log(
        `Status: ${status || "Not available"}`
      );

      console.log(
        `Carrier: ${carrier || "Not available"}`
      );

      // ==================================================
      // FIND ORDER IN UNLEASHED
      // ==================================================

      const unleashedOrder =
        await getSmpOrderFromUnleashed(
          orderNumber
        );

      if (!unleashedOrder) {
        console.error(
          `Unable to find Unleashed order ${orderNumber}.`
        );

        return;
      }

      console.log(
        `Unleashed order ${orderNumber} found.`
      );

      // ==================================================
      // GET REQUESTER EMAIL
      // ==================================================

      const requesterEmail =
        getRequesterEmailFromComments(
          unleashedOrder.Comments
        );

      if (!requesterEmail) {
        console.error(
          `Requester email was not found in comments for ${orderNumber}.`
        );

        console.log(
          `Order comments: ${unleashedOrder.Comments || "None"}`
        );

        return;
      }

      console.log(
        `Requester email for ${orderNumber}: ${requesterEmail}`
      );

      // ==================================================
      // SEND EMAIL TO SALES PERSON
      // ==================================================

      await sendTrackingEmailToSalesPerson({
        requesterEmail,

        orderNumber,

        recipientName:
          recipientName ||
          unleashedOrder.DeliveryName,

        trackingNumber,

        trackingUrl,

        carrier,

        status
      });

    } catch (error) {
      console.error(
        "Failed to process Sendcloud webhook."
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
    }
  }
);

// ======================================================
// HEALTH CHECK
// ======================================================

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success:
        true,

      products:
        cachedProducts.length,

      salesPersons:
        cachedSalesPersons.length,

      refreshing:
        isRefreshing,

      resendConfigured:
        Boolean(
          process.env.RESEND_API_KEY
        )
    });
  }
);

// ======================================================
// START SERVER
// ======================================================

app.listen(
  PORT,
  () => {
    console.log(
      `SMP Portal server started on port ${PORT}.`
    );

    console.log(
      `Products in cache: ${cachedProducts.length}`
    );

    console.log(
      `Sales Persons in cache: ${cachedSalesPersons.length}`
    );

    console.log(
      `Resend configured: ${Boolean(process.env.RESEND_API_KEY)}`
    );
  }
);