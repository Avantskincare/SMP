require("dotenv").config();

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { createSendcloudParcel } = require("./sendcloudService");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======================================================
// CONFIG
// ======================================================

const UNLEASHED_API_URL = (
  process.env.UNLEASHED_API_URL ||
  "https://api.unleashedsoftware.com/"
).replace(/\/?$/, "/");

const UNLEASHED_API_KEY = process.env.UNLEASHED_API_KEY;
const UNLEASHED_AUTH_ID = process.env.UNLEASHED_AUTH_ID;

const RESEND_API_KEY = process.env.RESEND_API_KEY;

const SENDCLOUD_UK_PUBLIC_KEY = process.env.SENDCLOUD_UK_PUBLIC_KEY;
const SENDCLOUD_UK_SECRET_KEY = process.env.SENDCLOUD_UK_SECRET_KEY;

const SENDCLOUD_FR_PUBLIC_KEY = process.env.SENDCLOUD_FR_PUBLIC_KEY;
const SENDCLOUD_FR_SECRET_KEY = process.env.SENDCLOUD_FR_SECRET_KEY;

const CACHE_FILE = path.join(__dirname, "catalog_cache.json");
const CACHE_REFRESH_MS = 12 * 60 * 60 * 1000;

// ======================================================
// PORTAL CONFIG
// ======================================================

const BRANDS = [
  "Able",
  "Avant",
  "Flanerie",
  "Mix",
  "Sentier",
  "Symbiosis"
];

// Only these product prefixes are shown in Section 3.
// Accessories DO NOT use this filter.
const ALLOWED_PRODUCT_PREFIXES = [
  "BSC",
  "BSCS",
  "LCDP",
  "LIS",
  "MBC",
  "MBS",
  "MCM",
  "MCR",
  "MCS",
  "MINT",
  "MML",
  "MMS",
  "MPW",
  "MS",
  "MSC",
  "MSCS",
  "MSP",
  "MTCS",
  "MTP",
  "PRD",
  "SFP",
  "SM01",
  "SRV",
  "TEMPLATE",
  "TRN"
];

// Optional:
// Add on Render as comma-separated emails:
//
// ALLOWED_SALES_PERSON_EMAILS=person1@avant-skincare.com,person2@avant-skincare.com
//
// If empty, all active Sales Persons returned by Unleashed are shown.
const ALLOWED_SALES_PERSON_EMAILS = String(
  process.env.ALLOWED_SALES_PERSON_EMAILS || ""
)
  .split(",")
  .map(email => email.trim().toLowerCase())
  .filter(Boolean);

// ======================================================
// EU COUNTRIES
// GB is intentionally excluded.
// ======================================================

const EU_COUNTRIES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE",
  "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV",
  "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE"
];

function isEUCountry(countryCode) {
  return EU_COUNTRIES.includes(
    String(countryCode || "")
      .trim()
      .toUpperCase()
  );
}

// ======================================================
// CACHE
// ======================================================

let cachedProducts = [];
let cachedSalesPersons = [];
let isRefreshing = false;

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

function generateGUID() {
  const bytes = crypto.randomBytes(16);

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return [...bytes]
    .map((byte, index) => {
      const dash = [4, 6, 8, 10].includes(index) ? "-" : "";
      return dash + byte.toString(16).padStart(2, "0");
    })
    .join("");
}

// ======================================================
// PRODUCT HELPERS
// ======================================================

function normalizeProduct(product) {
  return {
    guid:
      product.Guid ||
      product.GUID ||
      "",

    sku:
      String(
        product.ProductCode || ""
      ).trim(),

    name:
      String(
        product.ProductDescription ||
        product.ProductCode ||
        ""
      ).trim(),

    weight:
      Number(
        product.Weight || 0
      ) || 0,

    hsCode:
      String(
        product.SupplementaryClassification ||
        product.HSCode ||
        product.HarmonisedSystemCode ||
        ""
      ).trim(),

    barcode:
      String(
        product.Barcode || ""
      ).trim(),

    price:
      Number(
        product.DefaultSellPrice ||
        product.AverageLandPrice ||
        0
      ) || 0,

    isSellable:
      product.IsSellable === true ||
      String(product.IsSellable).toLowerCase() === "true"
  };
}

function isAllowedPortalProduct(product) {
  const sku = String(
    product.ProductCode || ""
  )
    .trim()
    .toUpperCase();

  const isSellable =
    product.IsSellable === true ||
    String(product.IsSellable).toLowerCase() === "true";

  if (!sku || !isSellable) {
    return false;
  }

  return ALLOWED_PRODUCT_PREFIXES.some(prefix =>
    sku.startsWith(
      prefix.toUpperCase()
    )
  );
}

function findCachedProduct(sku) {
  const wantedSku = String(sku || "")
    .trim()
    .toUpperCase();

  return (
    cachedProducts.find(
      product =>
        String(product.sku || "")
          .trim()
          .toUpperCase() === wantedSku
    ) || null
  );
}

// ======================================================
// ACCESSORY SKU PARSER
// ======================================================

function parseAccessorySkus(value) {
  if (!value) {
    return [];
  }

  const skus = String(value)
    .split(/[,;\n]+/)
    .map(sku =>
      sku
        .trim()
        .toUpperCase()
    )
    .filter(Boolean);

  return [...new Set(skus)].slice(0, 20);
}

// ======================================================
// ACCESSORY LOOKUP
//
// IMPORTANT:
// This searches Unleashed directly.
// It does NOT use ALLOWED_PRODUCT_PREFIXES.
// ======================================================

async function getProductBySkuFromUnleashed(sku) {
  const cleanSku = String(sku || "")
    .trim()
    .toUpperCase();

  if (!cleanSku) {
    return null;
  }

  let page = 1;
  let totalPages = 1;

  do {
    const params = new URLSearchParams();

    params.set("productCode", cleanSku);
    params.set("includeObsolete", "false");
    params.set("pageSize", "1000");
    params.set("page", String(page));

    const queryString = params.toString();

    console.log(
      `Looking up accessory SKU in Unleashed: ${cleanSku} (page ${page})`
    );

    const response = await axios.get(
      `${UNLEASHED_API_URL}Products?${queryString}`,
      {
        headers: getUnleashedHeaders(queryString),
        timeout: 15000
      }
    );

    const products =
      response.data?.Items || [];

    const exactProduct =
      products.find(product =>
        String(product.ProductCode || "")
          .trim()
          .toUpperCase() === cleanSku
      );

    if (exactProduct) {
      return exactProduct;
    }

    totalPages =
      Number(
        response.data?.Pagination?.NumberOfPages
      ) || 1;

    page++;

  } while (page <= totalPages);

  return null;
}

// ======================================================
// REFRESH PORTAL PRODUCT CACHE
//
// This cache is ONLY for the normal Section 3 dropdown.
// Accessories do not use this cache.
// ======================================================

async function refreshProductCatalog() {
  if (isRefreshing) {
    return;
  }

  isRefreshing = true;

  try {
    console.log(
      "Refreshing SMP product catalog from Unleashed..."
    );

    const filteredProducts = [];

    let page = 1;
    let totalPages = 1;

    do {
      const params = new URLSearchParams();

      params.set("pageSize", "1000");
      params.set("page", String(page));
      params.set("includeObsolete", "false");

      const queryString =
        params.toString();

      const response =
        await axios.get(
          `${UNLEASHED_API_URL}Products?${queryString}`,
          {
            headers:
              getUnleashedHeaders(
                queryString
              ),

            timeout: 30000
          }
        );

      const products =
        response.data?.Items || [];

      for (const product of products) {
        if (
          isAllowedPortalProduct(
            product
          )
        ) {
          filteredProducts.push(
            normalizeProduct(product)
          );
        }
      }

      totalPages =
        Number(
          response.data
            ?.Pagination
            ?.NumberOfPages
        ) || 1;

      console.log(
        `Product page ${page}/${totalPages} loaded.`
      );

      page++;

    } while (page <= totalPages);

    filteredProducts.sort(
      (a, b) =>
        a.name.localeCompare(b.name)
    );

    // ================================================
    // SALES PERSONS
    // ================================================

    const salesQuery = "";

    const salesResponse =
      await axios.get(
        `${UNLEASHED_API_URL}Salespersons`,
        {
          headers:
            getUnleashedHeaders(
              salesQuery
            ),

          timeout: 15000
        }
      );

    const rawSalesPersons =
      salesResponse.data?.Items || [];

    let salesPersons =
      rawSalesPersons
        .map(person => ({
          guid:
            person.Guid ||
            person.GUID ||
            "",

          fullName:
            String(
              person.FullName ||
              person.Name ||
              [
                person.FirstName,
                person.LastName
              ]
                .filter(Boolean)
                .join(" ") ||
              ""
            ).trim(),

          email:
            String(
              person.Email ||
              person.EmailAddress ||
              ""
            )
              .trim()
              .toLowerCase()
        }))
        .filter(
          person =>
            person.guid &&
            person.email
        );

    if (
      ALLOWED_SALES_PERSON_EMAILS.length > 0
    ) {
      salesPersons =
        salesPersons.filter(
          person =>
            ALLOWED_SALES_PERSON_EMAILS.includes(
              person.email
            )
        );
    }

    salesPersons.sort(
      (a, b) =>
        a.fullName.localeCompare(
          b.fullName
        )
    );

    cachedProducts =
      filteredProducts;

    cachedSalesPersons =
      salesPersons;

    const cacheData = {
      products:
        cachedProducts,

      salesPersons:
        cachedSalesPersons,

      updatedAt:
        new Date().toISOString()
    };

    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify(
        cacheData,
        null,
        2
      )
    );

    console.log(
      `Catalog refreshed: ${cachedProducts.length} filtered products and ${cachedSalesPersons.length} Sales Persons.`
    );

  } catch (error) {
    console.error(
      "Failed to refresh catalog:",
      error.response?.data ||
      error.message
    );

  } finally {
    isRefreshing = false;
  }
}

// ======================================================
// LOAD CACHE ON STARTUP
// ======================================================

try {
  if (
    fs.existsSync(
      CACHE_FILE
    )
  ) {
    const cache =
      JSON.parse(
        fs.readFileSync(
          CACHE_FILE,
          "utf8"
        )
      );

    cachedProducts =
      Array.isArray(cache.products)
        ? cache.products
        : [];

    cachedSalesPersons =
      Array.isArray(cache.salesPersons)
        ? cache.salesPersons
        : [];

    console.log(
      `Loaded catalog cache: ${cachedProducts.length} products and ${cachedSalesPersons.length} Sales Persons.`
    );
  }
} catch (error) {
  console.error(
    "Failed to load catalog cache:",
    error.message
  );
}

// Refresh immediately in background
refreshProductCatalog();

setInterval(
  refreshProductCatalog,
  CACHE_REFRESH_MS
);

// ======================================================
// PRODUCTS API
//
// Frontend gets ONLY filtered Section 3 products.
// ======================================================

app.get(
  "/api/products",
  (req, res) => {
    res.json({
      products:
        cachedProducts,

      brands:
        BRANDS,

      salesPersons:
        cachedSalesPersons
    });
  }
);

// ======================================================
// ORDER NUMBER HELPERS
// ======================================================

function extractOrderNumber(data) {
  if (!data) {
    return "";
  }

  if (
    typeof data.OrderNumber === "string"
  ) {
    return data.OrderNumber;
  }

  if (
    typeof data.orderNumber === "string"
  ) {
    return data.orderNumber;
  }

  if (
    Array.isArray(data.Items) &&
    data.Items.length > 0
  ) {
    return (
      data.Items[0]?.OrderNumber ||
      data.Items[0]?.orderNumber ||
      ""
    );
  }

  if (data.Item) {
    return (
      data.Item.OrderNumber ||
      data.Item.orderNumber ||
      ""
    );
  }

  return "";
}

async function getUnleashedOrderByGuid(guid) {
  const response =
    await axios.get(
      `${UNLEASHED_API_URL}SalesOrders/${guid}`,
      {
        headers:
          getUnleashedHeaders(""),

        timeout: 15000
      }
    );

  return response.data;
}

// ======================================================
// COUNTRY ROUTING
// ======================================================

function getRouting(countryCode) {
  const country =
    String(countryCode || "")
      .trim()
      .toUpperCase();

  if (country === "US") {
    return {
      warehouse:
        "UK_W1",

      currency:
        "USD"
    };
  }

  if (country === "GB") {
    return {
      warehouse:
        "UK_W1",

      currency:
        "GBP"
    };
  }

  if (
    isEUCountry(country)
  ) {
    return {
      warehouse:
        "FR_Atypic",

      currency:
        "EUR"
    };
  }

  return {
    warehouse:
      "UK_W1",

    currency:
      "GBP"
  };
}

// ======================================================
// CREATE SMP ORDER
// ======================================================

app.post(
  "/api/create-smp-order",
  async (req, res) => {
    try {
      const data =
        req.body || {};

      // ================================================
      // BASIC VALIDATION
      // ================================================

      if (
        !Array.isArray(data.items) ||
        data.items.length === 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            "At least one product is required."
        });
      }

      if (
        !BRANDS.includes(
          data.brand
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid brand."
        });
      }

      const country =
        String(
          data.country || ""
        )
          .trim()
          .toUpperCase();

      if (!country) {
        return res.status(400).json({
          success: false,
          error:
            "Destination country is required."
        });
      }

      // ================================================
      // SALES PERSON
      // ================================================

      const selectedSalesPerson =
        cachedSalesPersons.find(
          person =>
            person.email ===
            String(
              data.salesPerson ||
              data.requestedByEmail ||
              ""
            )
              .trim()
              .toLowerCase()
        );

      if (!selectedSalesPerson) {
        return res.status(400).json({
          success: false,
          error:
            "Selected Sales Person was not found."
        });
      }

      // ================================================
      // NORMAL SAMPLE PRODUCTS
      //
      // These MUST exist in the filtered Section 3 cache.
      // ================================================

      const normalItems = [];

      for (
        const item of data.items
      ) {
        const sku =
          String(item.sku || "")
            .trim()
            .toUpperCase();

        const quantity =
          Math.max(
            1,
            parseInt(
              item.quantity,
              10
            ) || 1
          );

        if (!sku) {
          return res.status(400).json({
            success: false,
            error:
              "A selected product is missing its SKU."
          });
        }

        const cachedProduct =
          findCachedProduct(sku);

        if (!cachedProduct) {
          return res.status(400).json({
            success: false,
            error:
              `Product SKU is not available in the SMP product list: ${sku}`
          });
        }

        normalItems.push({
          sku:
            cachedProduct.sku,

          productName:
            cachedProduct.name,

          quantity,

          weight:
            cachedProduct.weight || 0,

          hsCode:
            cachedProduct.hsCode || "",

          price:
            0,

          isAccessory:
            false
        });
      }

      // ================================================
      // ACCESSORIES
      //
      // NOT searched in cachedProducts.
      // Each SKU is searched directly in full Unleashed.
      // Multiple lookups run in parallel.
      // ================================================

      const accessorySkus =
        parseAccessorySkus(
          data.accessorySkus
        );

      let accessoryItems = [];

      if (
        accessorySkus.length > 0
      ) {
        console.log(
          `Looking up ${accessorySkus.length} accessory SKU(s) directly in Unleashed...`
        );

        const accessoryProducts =
          await Promise.all(
            accessorySkus.map(
              sku =>
                getProductBySkuFromUnleashed(
                  sku
                )
            )
          );

        const missingAccessories =
          accessorySkus.filter(
            (sku, index) =>
              !accessoryProducts[index]
          );

        if (
          missingAccessories.length > 0
        ) {
          return res.status(400).json({
            success: false,
            error:
              `Accessory SKU not found in Unleashed: ${missingAccessories.join(", ")}`
          });
        }

        accessoryItems =
          accessoryProducts.map(
            (product, index) => {
              const normalized =
                normalizeProduct(
                  product
                );

              return {
                sku:
                  normalized.sku ||
                  accessorySkus[index],

                productName:
                  normalized.name ||
                  accessorySkus[index],

                quantity:
                  1,

                weight:
                  normalized.weight || 0,

                hsCode:
                  normalized.hsCode || "",

                price:
                  0,

                isAccessory:
                  true
              };
            }
          );

        console.log(
          `Accessory lookup successful: ${accessoryItems.map(item => item.sku).join(", ")}`
        );
      }

      const allOrderItems = [
        ...normalItems,
        ...accessoryItems
      ];

      // ================================================
      // ROUTING
      // ================================================

      const routing =
        getRouting(country);

      const warehouse =
        routing.warehouse;

      const currency =
        routing.currency;

      // ================================================
      // UNLEASHED SALES ORDER LINES
      // ================================================

      const salesOrderLines =
        allOrderItems.map(
          (item, index) => ({
            Guid:
              generateGUID(),

            LineNumber:
              index + 1,

            Product: {
              ProductCode:
                item.sku,

              ProductDescription:
                item.productName
            },

            OrderQuantity:
              item.quantity,

            UnitPrice:
              0,

            LineTotal:
              0,

            LineTax:
              0,

            TaxRate:
              0,

            DiscountRate:
              0,

            Comments:
              item.isAccessory
                ? "SMP accessory"
                : "SMP sample"
          })
        );

      // ================================================
      // COMMENTS
      // ================================================

      const commentParts = [
        `Requested by: ${data.requestedBy || selectedSalesPerson.fullName}`,
        `Requester email: ${data.requestedByEmail || selectedSalesPerson.email}`,
        `Brand: ${data.brand}`,
        `Black Box Required: ${data.blackBoxRequired || "No"}`,
        `Recipient email: ${data.recipientEmail || ""}`,
        `Phone: ${data.phone || ""}`,
        `Company: ${data.partnerCompany || ""}`
      ];

      if (
        accessorySkus.length > 0
      ) {
        commentParts.push(
          `Accessories: ${accessorySkus.join(", ")}`
        );
      }

      const orderComment =
        String(
          data.orderComment || ""
        )
          .trim()
          .replace(/\s+/g, " ");

      if (orderComment) {
        commentParts.push(
          `SMP Comment: ${orderComment}`
        );
      }

      const comments =
        commentParts
          .join(" | ")
          .slice(0, 2048);

      // ================================================
      // UNLEASHED ORDER
      //
      // OrderNumber intentionally omitted.
      // Unleashed generates the next number from its
      // configured Sales Order numbering sequence.
      // ================================================

      const orderGuid =
        generateGUID();

      const now =
        new Date();

      const unleashedOrder = {
        Guid:
          orderGuid,

        OrderStatus:
          "Parked",

        Customer: {
          CustomerCode:
            "SMP"
        },

        CustomerRef:
          data.partnerCompany ||
          "SMP Portal",

        Brand:
          data.brand,

        SalesOrderGroup:
          data.brand,

        Salesperson: {
          Guid:
            selectedSalesPerson.guid
        },

        DeliveryName:
          data.recipientName || "",

        DeliveryStreetAddress:
          data.streetAddress || "",

        DeliveryStreetAddress2:
          data.streetAddress2 || "",

        DeliveryCity:
          data.city || "",

        DeliveryRegion:
          data.region || "",

        DeliveryCountry:
          country,

        DeliveryPostCode:
          data.postCode || "",

        Warehouse: {
          WarehouseCode:
            warehouse
        },

        Currency: {
          CurrencyCode:
            currency
        },

        ExchangeRate:
          1,

        Tax: {
          TaxCode:
            "NONE",

          TaxRate:
            0
        },

        SubTotal:
          0,

        TaxRate:
          0,

        TaxTotal:
          0,

        Total:
          0,

        OrderDate:
          now.toISOString(),

        SalesOrderLines:
          salesOrderLines,

        Comments:
          comments
      };

      console.log(
        `Creating SMP order in Unleashed for ${selectedSalesPerson.fullName}...`
      );

      const unleashedResponse =
        await axios.post(
          `${UNLEASHED_API_URL}SalesOrders/${orderGuid}`,
          unleashedOrder,
          {
            headers:
              getUnleashedHeaders(
                ""
              ),

            timeout:
              30000
          }
        );

      // ================================================
      // GET UNLEASHED-GENERATED ORDER NUMBER
      // ================================================

      let orderNumber =
        extractOrderNumber(
          unleashedResponse.data
        );

      if (!orderNumber) {
        console.log(
          "Order number was not present in POST response. Fetching order by GUID..."
        );

        const createdOrder =
          await getUnleashedOrderByGuid(
            orderGuid
          );

        orderNumber =
          extractOrderNumber(
            createdOrder
          );
      }

      if (!orderNumber) {
        throw new Error(
          "Unleashed created the order but did not return an OrderNumber."
        );
      }

      console.log(
        `Unleashed SMP order created: ${orderNumber}`
      );

      // ================================================
      // SENDCLOUD
      // ================================================

      let sendcloudSuccess =
        false;

      let sendcloudParcelId =
        null;

      let sendcloudError =
        null;

      try {
        const sendcloudData = {
          ...data,

          country,

          items:
            allOrderItems
        };

        const sendcloudResult =
          await createSendcloudParcel(
            sendcloudData,
            orderNumber
          );

        sendcloudSuccess =
          true;

        sendcloudParcelId =
          sendcloudResult?.id ||
          sendcloudResult?.parcel?.id ||
          null;

        console.log(
          `Sendcloud parcel created for ${orderNumber}.`
        );

      } catch (error) {
        sendcloudError =
          error.response?.data ||
          error.message;

        console.error(
          `Sendcloud creation failed for ${orderNumber}:`,
          JSON.stringify(
            sendcloudError
          )
        );
      }

      return res.json({
        success:
          true,

        orderNumber,

        warehouseAssigned:
          warehouse,

        currencyAssigned:
          currency,

        sendcloudSuccess,

        sendcloudParcelId,

        sendcloudError:
          sendcloudSuccess
            ? null
            : sendcloudError
      });

    } catch (error) {
      console.error(
        "Failed to create SMP order:"
      );

      if (
        error.response
      ) {
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
      } else {
        console.error(
          error.stack ||
          error.message
        );
      }

      return res.status(500).json({
        success:
          false,

        error:
          error.response?.data ||
          error.message ||
          "Failed to create SMP order."
      });
    }
  }
);

// ======================================================
// GET SMP ORDER FROM UNLEASHED BY ORDER NUMBER
// ======================================================

async function getSmpOrderFromUnleashed(
  orderNumber
) {
  const params =
    new URLSearchParams();

  params.set(
    "orderNumber",
    orderNumber
  );

  params.set(
    "pageSize",
    "50"
  );

  const queryString =
    params.toString();

  const response =
    await axios.get(
      `${UNLEASHED_API_URL}SalesOrders?${queryString}`,
      {
        headers:
          getUnleashedHeaders(
            queryString
          ),

        timeout:
          15000
      }
    );

  const orders =
    response.data?.Items || [];

  return (
    orders.find(
      order =>
        String(
          order.OrderNumber || ""
        )
          .trim()
          .toUpperCase() ===
        String(orderNumber)
          .trim()
          .toUpperCase()
    ) ||
    orders[0] ||
    null
  );
}

// ======================================================
// REQUESTER EMAIL FROM UNLEASHED COMMENTS
// ======================================================

function getRequesterEmailFromComments(
  comments
) {
  const match =
    String(comments || "")
      .match(
        /Requester email:\s*([^\s|]+)/i
      );

  return match
    ? match[1]
        .trim()
        .toLowerCase()
    : "";
}

// ======================================================
// HTML ESCAPE
// ======================================================

function escapeHtml(value) {
  return String(
    value || ""
  )
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
// SENDCLOUD AUTH FOR TRACKING LOOKUP
// ======================================================

function getSendcloudAuthHeader(
  countryCode
) {
  const useFrance =
    isEUCountry(
      countryCode
    );

  const publicKey =
    useFrance
      ? SENDCLOUD_FR_PUBLIC_KEY
      : SENDCLOUD_UK_PUBLIC_KEY;

  const secretKey =
    useFrance
      ? SENDCLOUD_FR_SECRET_KEY
      : SENDCLOUD_UK_SECRET_KEY;

  if (
    !publicKey ||
    !secretKey
  ) {
    return null;
  }

  return (
    "Basic " +
    Buffer.from(
      `${publicKey}:${secretKey}`
    ).toString(
      "base64"
    )
  );
}

// ======================================================
// SENDCLOUD TRACKING LOOKUP
// ======================================================

async function getSendcloudTrackingInfo(
  trackingNumber,
  countryCode
) {
  const authHeader =
    getSendcloudAuthHeader(
      countryCode
    );

  if (!authHeader) {
    console.log(
      "Sendcloud tracking lookup skipped because credentials are not configured."
    );

    return null;
  }

  try {
    const response =
      await axios.get(
        `https://panel.sendcloud.sc/api/v2/tracking/${encodeURIComponent(trackingNumber)}`,
        {
          headers: {
            Authorization:
              authHeader,

            Accept:
              "application/json"
          },

          timeout:
            15000
        }
      );

    return response.data;

  } catch (error) {
    console.error(
      `Failed to retrieve Sendcloud tracking information for ${trackingNumber}:`,
      error.response?.data ||
      error.message
    );

    return null;
  }
}

// ======================================================
// SEND TRACKING EMAIL TO SALES PERSON
// ======================================================

async function sendTrackingEmailToSalesPerson({
  requesterEmail,
  orderNumber,
  recipientName,
  status,
  carrier,
  trackingNumber,
  trackingUrl
}) {
  if (
    !RESEND_API_KEY
  ) {
    throw new Error(
      "RESEND_API_KEY is not configured."
    );
  }

  const safeOrder =
    escapeHtml(
      orderNumber
    );

  const safeRecipient =
    escapeHtml(
      recipientName ||
      "Recipient"
    );

  const safeStatus =
    escapeHtml(
      status ||
      "Tracking update"
    );

  const safeCarrier =
    escapeHtml(
      carrier ||
      ""
    );

  const safeTracking =
    escapeHtml(
      trackingNumber ||
      ""
    );

  const button =
    trackingUrl
      ? `
        <p style="margin-top:24px;">
          <a
            href="${escapeHtml(trackingUrl)}"
            style="
              display:inline-block;
              background:#0052cc;
              color:#ffffff;
              text-decoration:none;
              padding:12px 20px;
              border-radius:4px;
              font-weight:600;
            "
          >
            Track shipment
          </a>
        </p>
      `
      : "";

  const html = `
    <div style="font-family:Arial,sans-serif;color:#172b4d;line-height:1.6;">
      <h2>SMP Tracking Update</h2>

      <p>
        Tracking information is now available for SMP order
        <strong>${safeOrder}</strong>.
      </p>

      <p>
        <strong>Recipient:</strong> ${safeRecipient}<br>
        <strong>Status:</strong> ${safeStatus}<br>
        ${
          safeCarrier
            ? `<strong>Carrier:</strong> ${safeCarrier}<br>`
            : ""
        }
        <strong>Tracking number:</strong> ${safeTracking}
      </p>

      ${button}
    </div>
  `;

  const subject =
    `Tracking update - ${orderNumber} - ${status || "Shipment update"}`;

  const response =
    await axios.post(
      "https://api.resend.com/emails",
      {
        from:
          "Customer Service <customerservice@avant-skincare.com>",

        to: [
          requesterEmail
        ],

        subject,

        html
      },
      {
        headers: {
          Authorization:
            `Bearer ${RESEND_API_KEY}`,

          "Content-Type":
            "application/json"
        },

        timeout:
          15000
      }
    );

  console.log(
    `Tracking email sent to ${requesterEmail} for ${orderNumber}.`
  );

  return response.data;
}

// ======================================================
// SENDCLOUD WEBHOOK DATA PARSER
// ======================================================

function extractSendcloudWebhookData(
  body
) {
  const parcel =
    body?.parcel ||
    body?.data?.parcel ||
    body?.data ||
    {};

  const statusObject =
    parcel.status ||
    {};

  const country =
    parcel.country ||
    {};

  const shipment =
    parcel.shipment ||
    {};

  const orderNumber =
    String(
      parcel.order_number ||
      parcel.orderNumber ||
      body?.order_number ||
      ""
    ).trim();

  const trackingNumber =
    String(
      parcel.tracking_number ||
      parcel.trackingNumber ||
      body?.tracking_number ||
      ""
    ).trim();

  const status =
    String(
      statusObject.message ||
      parcel.status_message ||
      parcel.status ||
      body?.status ||
      "Shipment update"
    ).trim();

  const carrier =
    String(
      shipment.name ||
      parcel.carrier?.name ||
      parcel.carrier_code ||
      ""
    ).trim();

  const recipientName =
    String(
      parcel.name ||
      ""
    ).trim();

  const countryCode =
    String(
      country.iso_2 ||
      parcel.country_code ||
      ""
    )
      .trim()
      .toUpperCase();

  const trackingUrl =
    String(
      parcel.tracking_url ||
      parcel.trackingUrl ||
      ""
    ).trim();

  return {
    orderNumber,
    trackingNumber,
    status,
    carrier,
    recipientName,
    countryCode,
    trackingUrl
  };
}

// ======================================================
// SENDCLOUD WEBHOOK
// ======================================================

app.post(
  "/api/sendcloud-webhook",
  async (req, res) => {
    try {
      console.log(
        "Sendcloud webhook received:",
        JSON.stringify(
          req.body
        )
      );

      const action =
        req.body?.action ||
        "";

      if (
        action !==
        "parcel_status_changed"
      ) {
        return res.status(200).json({
          success:
            true,

          message:
            "Webhook ignored."
        });
      }

      const webhookData =
        extractSendcloudWebhookData(
          req.body
        );

      const {
        orderNumber,
        trackingNumber,
        status,
        carrier,
        recipientName,
        countryCode
      } = webhookData;

      if (
        !orderNumber ||
        (
          !orderNumber.startsWith(
            "SMP-"
          ) &&
          !orderNumber.startsWith(
            "SSMP-"
          )
        )
      ) {
        return res.status(200).json({
          success:
            true,

          message:
            "Not an SMP order."
        });
      }

      // Do not email the Sales Person until a tracking number exists.
      if (
        !trackingNumber
      ) {
        console.log(
          `Sendcloud update for ${orderNumber} has no tracking number yet.`
        );

        return res.status(200).json({
          success:
            true,

          message:
            "NO TRACKING YET"
        });
      }

      let trackingUrl =
        webhookData.trackingUrl;

      if (!trackingUrl) {
        const trackingInfo =
          await getSendcloudTrackingInfo(
            trackingNumber,
            countryCode
          );

        trackingUrl =
          trackingInfo
            ?.sendcloud_tracking_url ||
          trackingInfo
            ?.carrier_tracking_url ||
          "";
      }

      const unleashedOrder =
        await getSmpOrderFromUnleashed(
          orderNumber
        );

      if (!unleashedOrder) {
        throw new Error(
          `Unable to find ${orderNumber} in Unleashed.`
        );
      }

      const requesterEmail =
        getRequesterEmailFromComments(
          unleashedOrder.Comments
        );

      if (!requesterEmail) {
        throw new Error(
          `Requester email was not found in Unleashed comments for ${orderNumber}.`
        );
      }

      await sendTrackingEmailToSalesPerson({
        requesterEmail,
        orderNumber,
        recipientName:
          recipientName ||
          unleashedOrder.DeliveryName ||
          "",

        status,
        carrier,
        trackingNumber,
        trackingUrl
      });

      return res.status(200).json({
        success:
          true
      });

    } catch (error) {
      console.error(
        "Sendcloud webhook processing failed:",
        error.response?.data ||
        error.message
      );

      return res.status(500).json({
        success:
          false,

        error:
          error.message ||
          "Webhook processing failed."
      });
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

      service:
        "SMP Portal",

      productsCached:
        cachedProducts.length,

      salesPersonsCached:
        cachedSalesPersons.length,

      unleashedConfigured:
        Boolean(
          UNLEASHED_API_KEY &&
          UNLEASHED_AUTH_ID
        ),

      resendConfigured:
        Boolean(
          RESEND_API_KEY
        ),

      sendcloudUKConfigured:
        Boolean(
          SENDCLOUD_UK_PUBLIC_KEY &&
          SENDCLOUD_UK_SECRET_KEY
        ),

      sendcloudFRConfigured:
        Boolean(
          SENDCLOUD_FR_PUBLIC_KEY &&
          SENDCLOUD_FR_SECRET_KEY
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
      `SMP Portal running on port ${PORT}.`
    );

    console.log(
      `Filtered product cache contains ${cachedProducts.length} products.`
    );

    console.log(
      `Sales Person cache contains ${cachedSalesPersons.length} people.`
    );
  }
);