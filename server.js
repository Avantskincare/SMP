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
// CONFIG
// ======================================================

const UNLEASHED_API_URL =
  process.env.UNLEASHED_API_URL ||
  "https://api.unleashedsoftware.com/";

const UNLEASHED_AUTH_ID =
  process.env.UNLEASHED_AUTH_ID;

const UNLEASHED_API_KEY =
  process.env.UNLEASHED_API_KEY;

const RESEND_FROM =
  "Customer Service <customerservice@avant-skincare.com>";

// ======================================================
// CACHE
// ======================================================

let cachedProducts = [];
let cachedAllProducts = [];
let cachedSalesPersons = [];

let hasFullCatalogCache = false;
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
// SALES PERSONS
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
// PRODUCT PREFIXES DISPLAYED IN SMP PORTAL
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
// SMP NUMBER SEQUENCE
//
// Existing:
// SMP--0002214
//
// First new:
// SMP--0002215
// ======================================================

let nextSmpNumberInMemory =
  Number(
    process.env.SMP_SEQUENCE_START ||
    2215
  );

let smpSequenceLock =
  Promise.resolve();

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
    "client-type": "inhouse/smpportal"
  };
}

// ======================================================
// GUID
// ======================================================

function generateGUID() {
  const randomBytes =
    crypto.randomBytes(16);

  randomBytes[6] =
    (randomBytes[6] & 0x0f) | 0x40;

  randomBytes[8] =
    (randomBytes[8] & 0x3f) | 0x80;

  return [...randomBytes]
    .map(
      (b, i) =>
        ([4, 6, 8, 10].includes(i)
          ? "-"
          : "") +
        b.toString(16).padStart(2, "0")
    )
    .join("");
}

// ======================================================
// PRODUCT HELPERS
// ======================================================

function normalizeProduct(product) {
  return {
    sku:
      product.ProductCode || "",

    name:
      product.ProductDescription || "",

    brand:
      product.ProductGroup?.GroupName ||
      product.Brand ||
      "",

    weight:
      Number(product.Weight) || 0.1,

    hsCode:
      product.CustomsCode ||
      product.CommerceCode ||
      "33049900",

    price:
      Number(product.AverageCost) || 0
  };
}

function findCachedProduct(sku) {
  const normalizedSku =
    String(sku || "")
      .trim()
      .toUpperCase();

  return (
    cachedAllProducts.find(
      (product) =>
        String(product.sku || "")
          .trim()
          .toUpperCase() === normalizedSku
    ) || null
  );
}

// ======================================================
// ACCESSORY HELPERS
// ======================================================

function parseAccessorySkus(value) {
  if (!value) {
    return [];
  }

  const rawValue =
    Array.isArray(value)
      ? value.join(",")
      : String(value);

  const skus =
    rawValue
      .split(/[\n,;]+/)
      .map(
        (sku) =>
          sku
            .trim()
            .toUpperCase()
      )
      .filter(Boolean);

  return [...new Set(skus)]
    .slice(0, 20);
}

// ======================================================
// DIRECT ACCESSORY LOOKUP
// ======================================================

async function getProductBySkuFromUnleashed(sku) {
  const cleanSku =
    String(sku || "")
      .trim()
      .toUpperCase();

  if (!cleanSku) {
    return null;
  }

  const queryString =
    `productCode=${encodeURIComponent(cleanSku)}&includeObsolete=false&pageSize=50`;

  console.log(
    `Looking up accessory SKU directly in Unleashed: ${cleanSku}`
  );

  const response =
    await axios.get(
      `${UNLEASHED_API_URL}Products?${queryString}`,
      {
        headers:
          getUnleashedHeaders(
            queryString
          )
      }
    );

  const products =
    response.data?.Items || [];

  return (
    products.find(
      (product) =>
        String(
          product.ProductCode || ""
        )
          .trim()
          .toUpperCase() === cleanSku
    ) || null
  );
}

// ======================================================
// REFRESH PRODUCT CATALOG
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

    const publicProductsMap =
      new Map();

    const allProductsMap =
      new Map();

    let page = 1;
    let totalPages = 1;

    do {
      const queryString =
        `pageSize=1000&page=${page}&includeObsolete=false`;

      const url =
        `${UNLEASHED_API_URL}Products?${queryString}`;

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

      const items =
        response.data?.Items || [];

      items.forEach((product) => {
        const normalized =
          normalizeProduct(product);

        const sku =
          String(
            normalized.sku || ""
          )
            .trim()
            .toUpperCase();

        if (!sku) {
          return;
        }

        if (
          !allProductsMap.has(sku)
        ) {
          allProductsMap.set(
            sku,
            normalized
          );
        }

        const matchesPrefix =
          ALLOWED_SKU_PREFIXES.some(
            (prefix) =>
              sku.startsWith(prefix)
          );

        if (
          product.IsSellable === true &&
          product.IsObsolete !== true &&
          matchesPrefix
        ) {
          if (
            !publicProductsMap.has(sku)
          ) {
            publicProductsMap.set(
              sku,
              normalized
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
        publicProductsMap.values()
      );

    cachedAllProducts =
      Array.from(
        allProductsMap.values()
      );

    hasFullCatalogCache = true;

    // ==================================================
    // SALES PERSONS
    // ==================================================

    console.log(
      "Refreshing Unleashed Sales Persons..."
    );

    try {
      const response =
        await axios.get(
          `${UNLEASHED_API_URL}Salespersons`,
          {
            headers:
              getUnleashedHeaders("")
          }
        );

      const emailMap =
        new Map();

      const salesPersons =
        response.data?.Items || [];

      salesPersons.forEach((sp) => {
        const email =
          String(
            sp.Email || ""
          )
            .trim()
            .toLowerCase();

        if (
          email &&
          ALLOWED_SALES_EMAILS.includes(
            email
          ) &&
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

          allProducts:
            cachedAllProducts,

          salesPersons:
            cachedSalesPersons
        },
        null,
        2
      )
    );

    console.log(
      `Catalog refreshed successfully: ${cachedProducts.length} portal products, ${cachedAllProducts.length} total products, ${cachedSalesPersons.length} Sales Persons.`
    );

  } catch (error) {
    console.error(
      "Failed to refresh Unleashed catalog:",
      error.response?.data ||
      error.message
    );

  } finally {
    isRefreshing = false;
  }
}

// ======================================================
// LOAD CACHE
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

    if (
      Array.isArray(
        cachedData.allProducts
      )
    ) {
      cachedAllProducts =
        cachedData.allProducts;

      hasFullCatalogCache = true;

    } else {
      cachedAllProducts =
        cachedProducts;

      hasFullCatalogCache = false;
    }

    console.log(
      `Disk cache loaded: ${cachedProducts.length} portal products, ${cachedAllProducts.length} cached products, ${cachedSalesPersons.length} Sales Persons.`
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

      return res.json({
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

      return res
        .status(500)
        .json({
          success: false,
          error:
            "Unable to load product catalog."
        });
    }
  }
);

// ======================================================
// EXTRACT ORDER NUMBER
// ======================================================

function extractOrderNumber(data) {
  if (!data) {
    return null;
  }

  if (data.OrderNumber) {
    return data.OrderNumber;
  }

  if (
    Array.isArray(data.Items) &&
    data.Items.length > 0 &&
    data.Items[0]?.OrderNumber
  ) {
    return data.Items[0]
      .OrderNumber;
  }

  return null;
}

// ======================================================
// CHECK WHETHER SMP ORDER NUMBER EXISTS
// ======================================================

async function smpOrderNumberExists(
  orderNumber
) {
  const queryString =
    `orderNumber=${encodeURIComponent(orderNumber)}`;

  const response =
    await axios.get(
      `${UNLEASHED_API_URL}SalesOrders?${queryString}`,
      {
        headers:
          getUnleashedHeaders(
            queryString
          )
      }
    );

  if (
    Array.isArray(
      response.data?.Items
    )
  ) {
    return response.data.Items.some(
      (order) =>
        String(
          order.OrderNumber || ""
        )
          .trim()
          .toUpperCase() ===
        String(orderNumber)
          .trim()
          .toUpperCase()
    );
  }

  return (
    String(
      response.data?.OrderNumber || ""
    )
      .trim()
      .toUpperCase() ===
    String(orderNumber)
      .trim()
      .toUpperCase()
  );
}

// ======================================================
// ALLOCATE NEXT SMP NUMBER
// ======================================================

async function allocateNextSmpOrderNumber() {
  while (true) {
    const candidate =
      `SMP--${String(
        nextSmpNumberInMemory
      ).padStart(7, "0")}`;

    console.log(
      `Checking SMP order number: ${candidate}`
    );

    const exists =
      await smpOrderNumberExists(
        candidate
      );

    if (!exists) {
      nextSmpNumberInMemory++;

      console.log(
        `Next SMP order number: ${candidate}`
      );

      return candidate;
    }

    console.log(
      `${candidate} already exists. Checking next number...`
    );

    nextSmpNumberInMemory++;
  }
}

// ======================================================
// GET NEXT SMP ORDER NUMBER
// ======================================================

function getNextSmpOrderNumber() {
  const allocation =
    smpSequenceLock.then(
      () =>
        allocateNextSmpOrderNumber()
    );

  smpSequenceLock =
    allocation.catch(
      () => {}
    );

  return allocation;
}

// ======================================================
// GET UNLEASHED ORDER BY GUID
// ======================================================

async function getUnleashedOrderByGuid(
  orderGuid
) {
  const response =
    await axios.get(
      `${UNLEASHED_API_URL}SalesOrders/${orderGuid}`,
      {
        headers:
          getUnleashedHeaders("")
      }
    );

  return response.data;
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

      if (!data.requiredShipmentDate) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Required Shipment Date is required."
          });
      }

      const shipmentDateValue =
        String(
          data.requiredShipmentDate
        ).trim();

      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(
          shipmentDateValue
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Required Shipment Date is invalid."
          });
      }

      const requiredShipmentDate =
        new Date(
          `${shipmentDateValue}T00:00:00.000Z`
        );

      if (
        Number.isNaN(
          requiredShipmentDate.getTime()
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Required Shipment Date is invalid."
          });
      }

      const requiredShipmentDateISO =
        requiredShipmentDate.toISOString();

      const invalidMainItem =
        data.items.find(
          (item) =>
            !String(
              item.sku || ""
            ).trim()
        );

      if (invalidMainItem) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Every product must have a valid SKU."
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

      } else if (
        countryCode === "GB"
      ) {
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
          .trim()
          .toLowerCase();

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

      if (
        !selectedSalesPerson.guid
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              `Sales Person ${selectedSalesPerson.email} does not have an Unleashed GUID.`
          });
      }

      // ==================================================
      // ACCESSORIES
      // ==================================================

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
              (sku) =>
                getProductBySkuFromUnleashed(
                  sku
                )
            )
          );

        const unknownAccessories =
          accessorySkus.filter(
            (sku, index) =>
              !accessoryProducts[index]
          );

        if (
          unknownAccessories.length > 0
        ) {
          return res
            .status(400)
            .json({
              success: false,
              error:
                `Accessory SKU not found in Unleashed: ${unknownAccessories.join(", ")}`
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
                productName:
                  normalized.name ||
                  `Accessory ${accessorySkus[index]}`,

                sku:
                  normalized.sku ||
                  accessorySkus[index],

                quantity:
                  1,

                weight:
                  normalized.weight ||
                  0.1,

                hsCode:
                  normalized.hsCode ||
                  "33049900",

                price:
                  normalized.price ||
                  0,

                isAccessory:
                  true
              };
            }
          );

        console.log(
          `Accessory lookup successful: ${accessoryItems.map((item) => item.sku).join(", ")}`
        );
      }

      // ==================================================
      // NORMAL PRODUCTS
      // ==================================================

      const normalItems =
        data.items.map(
          (item) => {
            const product =
              findCachedProduct(
                item.sku
              );

            return {
              productName:
                item.productName ||
                product?.name ||
                item.sku,

              sku:
                String(
                  item.sku
                ).trim(),

              quantity:
                Math.max(
                  1,
                  Number(
                    item.quantity
                  ) || 1
                ),

              weight:
                product?.weight ||
                0.1,

              hsCode:
                product?.hsCode ||
                "33049900",

              price:
                product?.price ||
                0,

              isAccessory:
                false
            };
          }
        );

      const allOrderItems = [
        ...normalItems,
        ...accessoryItems
      ];

      // ==================================================
      // GUID / DATE / ORDER NUMBER
      // ==================================================

      const orderGuid =
        generateGUID();

      const now =
        new Date()
          .toISOString();

      const orderNumber =
        await getNextSmpOrderNumber();

      console.log(
        `Using SMP order number: ${orderNumber}`
      );

      console.log(
        `Required Shipment Date: ${shipmentDateValue}`
      );

      // ==================================================
      // SALES ORDER LINES
      // ==================================================

      const salesOrderLines =
        allOrderItems.map(
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
              data.brand,

            Comments:
              item.isAccessory
                ? "SMP accessory"
                : ""
          })
        );

      // ==================================================
      // ORDER COMMENT
      // ==================================================

      const userComment =
        String(
          data.orderComment || ""
        )
          .replace(
            /\s+/g,
            " "
          )
          .trim();

      const comments = [
        `Requested by: ${selectedSalesPerson.fullName}`,
        `Requester email: ${selectedSalesPerson.email}`,
        `Brand: ${data.brand}`,
        `Black Box Required: ${data.blackBoxRequired || "N/A"}`,
        `Recipient email: ${data.recipientEmail || "N/A"}`,
        `Phone: ${data.phone || "N/A"}`,

        data.partnerCompany
          ? `Company: ${data.partnerCompany}`
          : null,

        accessorySkus.length > 0
          ? `Accessories: ${accessorySkus.join(", ")}`
          : null,

        userComment
          ? `SMP Comment: ${userComment}`
          : null
      ]
        .filter(Boolean)
        .join(" | ")
        .slice(0, 2048);

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
          requiredShipmentDateISO,

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
          data.recipientName ||
          "",

        DeliveryStreetAddress:
          data.streetAddress ||
          "",

        DeliveryStreetAddress2:
          data.streetAddress2 ||
          "",

        DeliverySuburb:
          "",

        DeliveryCity:
          data.city ||
          "",

        DeliveryRegion:
          data.region ||
          "",

        DeliveryPostCode:
          data.postCode ||
          "",

        DeliveryCountry:
          countryCode,

        SubTotal:
          0,

        TaxRate:
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
        "Creating SMP order in Unleashed..."
      );

      console.log(
        `Order Number: ${orderNumber}`
      );

      console.log(
        `Customer Reference: ${orderNumber}`
      );

      console.log(
        `Required Shipment Date: ${shipmentDateValue}`
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

      if (
        accessorySkus.length > 0
      ) {
        console.log(
          `Accessories: ${accessorySkus.join(", ")}`
        );
      }

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

      // ==================================================
      // VERIFY ORDER NUMBER
      // ==================================================

      let createdOrderNumber =
        extractOrderNumber(
          unleashedRes.data
        ) || orderNumber;

      if (
        !extractOrderNumber(
          unleashedRes.data
        )
      ) {
        try {
          const createdOrder =
            await getUnleashedOrderByGuid(
              orderGuid
            );

          createdOrderNumber =
            extractOrderNumber(
              createdOrder
            ) || orderNumber;

        } catch (readBackError) {
          console.log(
            `Order read-back failed. Using requested order number ${orderNumber}.`
          );
        }
      }

      console.log(
        `Order ${createdOrderNumber} created successfully in Unleashed.`
      );

      // ==================================================
      // CREATE SENDCLOUD PARCEL
      // ==================================================

      console.log(
        `Creating Sendcloud parcel for ${createdOrderNumber} (${countryCode})...`
      );

      const sendcloudData = {
        ...data,

        items:
          allOrderItems
      };

      const sendcloudResult =
        await createSendcloudParcel(
          sendcloudData,
          createdOrderNumber
        );

      console.log(
        "Sendcloud result:",
        JSON.stringify(
          sendcloudResult,
          null,
          2
        )
      );

      if (
        sendcloudResult.success
      ) {
        console.log(
          `Sendcloud parcel created successfully for ${createdOrderNumber}.`
        );

      } else {
        console.error(
          `Unleashed order ${createdOrderNumber} was created, but Sendcloud parcel creation failed:`,
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

        orderNumber:
          createdOrderNumber,

        orderGuid,

        customerAssigned:
          customerCode,

        customerReference:
          orderNumber,

        requiredShipmentDate:
          shipmentDateValue,

        warehouseAssigned:
          warehouseCode,

        currencyAssigned:
          currencyCode,

        brand:
          data.brand,

        accessories:
          accessorySkus,

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
            error.response?.data
              ?.Description ||
            error.response?.data ||
            error.message
        });
    }
  }
);

// ======================================================
// GET SMP ORDER FROM UNLEASHED
// ======================================================

async function getSmpOrderFromUnleashed(
  orderNumber
) {
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
          getUnleashedHeaders(
            queryString
          )
      }
    );

  if (
    Array.isArray(
      response.data?.Items
    ) &&
    response.data.Items.length > 0
  ) {
    return response.data
      .Items[0];
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

function getRequesterEmailFromComments(
  comments
) {
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
// SENDCLOUD AUTH
// ======================================================

function getSendcloudAuthHeader(
  countryCode
) {
  const normalizedCountry =
    String(
      countryCode || ""
    )
      .trim()
      .toUpperCase();

  const useFranceAccount =
    EU_COUNTRIES.includes(
      normalizedCountry
    );

  const publicKey =
    useFranceAccount
      ? process.env
          .SENDCLOUD_FR_PUBLIC_KEY
      : process.env
          .SENDCLOUD_UK_PUBLIC_KEY;

  const secretKey =
    useFranceAccount
      ? process.env
          .SENDCLOUD_FR_SECRET_KEY
      : process.env
          .SENDCLOUD_UK_SECRET_KEY;

  if (
    !publicKey ||
    !secretKey
  ) {
    throw new Error(
      `Sendcloud credentials are missing for ${useFranceAccount ? "FR" : "UK"} account.`
    );
  }

  const token =
    Buffer
      .from(
        `${publicKey}:${secretKey}`
      )
      .toString("base64");

  return `Basic ${token}`;
}

// ======================================================
// GET TRACKING INFO FROM SENDCLOUD
// ======================================================

async function getSendcloudTrackingInfo(
  trackingNumber,
  countryCode
) {
  try {
    const response =
      await axios.get(
        `https://panel.sendcloud.sc/api/v2/tracking/${encodeURIComponent(trackingNumber)}`,
        {
          headers: {
            Accept:
              "application/json",

            Authorization:
              getSendcloudAuthHeader(
                countryCode
              )
          }
        }
      );

    return response.data;

  } catch (error) {
    console.error(
      `Unable to retrieve Sendcloud tracking details for ${trackingNumber}:`,
      error.response?.data ||
      error.message
    );

    return null;
  }
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
  if (
    !process.env.RESEND_API_KEY
  ) {
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
    "Not available";

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
      <h2>SMP Tracking Update</h2>

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
          RESEND_FROM,

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
// NORMALIZE SENDCLOUD WEBHOOK
// ======================================================

function extractSendcloudWebhookData(
  body
) {
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
    parcel?.sendcloud_tracking_url ||
    body?.tracking_url ||
    null;

  const recipientName =
    parcel?.name ||
    parcel?.recipient_name ||
    parcel?.recipientName ||
    null;

  let status = null;

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

  let carrier = null;

  if (
    typeof parcel?.carrier ===
    "string"
  ) {
    carrier =
      parcel.carrier;

  } else {
    carrier =
      parcel?.shipment?.name ||
      parcel?.carrier?.name ||
      parcel?.carrier?.code ||
      null;
  }

  const countryCode =
    parcel?.country?.iso_2 ||
    parcel?.country_code ||
    parcel?.country ||
    null;

  return {
    parcel,
    orderNumber,
    trackingNumber,
    trackingUrl,
    recipientName,
    status,
    carrier,
    countryCode
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
        "Sendcloud webhook received:"
      );

      console.log(
        JSON.stringify(
          req.body,
          null,
          2
        )
      );

      if (
        req.body?.action &&
        req.body.action !==
          "parcel_status_changed"
      ) {
        console.log(
          `Ignoring Sendcloud webhook action: ${req.body.action}`
        );

        return res
          .status(200)
          .send("IGNORED");
      }

      const webhookData =
        extractSendcloudWebhookData(
          req.body
        );

      const {
        orderNumber,
        trackingNumber,
        recipientName,
        status,
        carrier,
        countryCode
      } = webhookData;

      let {
        trackingUrl
      } = webhookData;

      if (!orderNumber) {
        console.log(
          "Webhook does not contain an order number. Skipping."
        );

        return res
          .status(200)
          .send("IGNORED");
      }

      const normalizedOrderNumber =
        String(orderNumber)
          .toUpperCase();

      if (
        !normalizedOrderNumber.startsWith(
          "SMP-"
        ) &&
        !normalizedOrderNumber.startsWith(
          "SSMP-"
        )
      ) {
        console.log(
          `Order ${orderNumber} is not an SMP order. Skipping.`
        );

        return res
          .status(200)
          .send("IGNORED");
      }

      if (!trackingNumber) {
        console.log(
          `Order ${orderNumber} does not have a tracking number yet. No Sales Person email will be sent.`
        );

        return res
          .status(200)
          .send("NO TRACKING YET");
      }

      console.log(
        `Processing tracking update for ${orderNumber}.`
      );

      console.log(
        `Tracking number: ${trackingNumber}`
      );

      console.log(
        `Status: ${status || "Not available"}`
      );

      console.log(
        `Carrier: ${carrier || "Not available"}`
      );

      if (
        !trackingUrl &&
        countryCode
      ) {
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
          null;
      }

      const unleashedOrder =
        await getSmpOrderFromUnleashed(
          orderNumber
        );

      if (!unleashedOrder) {
        console.error(
          `Unable to find Unleashed order ${orderNumber}.`
        );

        return res
          .status(500)
          .send(
            "UNLEASHED ORDER NOT FOUND"
          );
      }

      console.log(
        `Unleashed order ${orderNumber} found.`
      );

      const requesterEmail =
        getRequesterEmailFromComments(
          unleashedOrder.Comments
        );

      if (!requesterEmail) {
        console.error(
          `Requester email was not found in comments for ${orderNumber}.`
        );

        return res
          .status(500)
          .send(
            "REQUESTER EMAIL NOT FOUND"
          );
      }

      console.log(
        `Requester email for ${orderNumber}: ${requesterEmail}`
      );

      await sendTrackingEmailToSalesPerson({
        requesterEmail,

        orderNumber,

        recipientName:
          recipientName ||
          unleashedOrder
            .DeliveryName,

        trackingNumber,

        trackingUrl,

        carrier,

        status
      });

      return res
        .status(200)
        .send("OK");

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

      return res
        .status(500)
        .send(
          "WEBHOOK PROCESSING FAILED"
        );
    }
  }
);

// ======================================================
// HEALTH CHECK
// ======================================================

app.get(
  "/api/health",
  (req, res) => {
    return res.json({
      success:
        true,

      products:
        cachedProducts.length,

      allProducts:
        cachedAllProducts.length,

      salesPersons:
        cachedSalesPersons.length,

      refreshing:
        isRefreshing,

      fullCatalogCache:
        hasFullCatalogCache,

      nextSmpNumberInMemory:
        nextSmpNumberInMemory,

      resendConfigured:
        Boolean(
          process.env.RESEND_API_KEY
        ),

      sendcloudUKConfigured:
        Boolean(
          process.env
            .SENDCLOUD_UK_PUBLIC_KEY &&
          process.env
            .SENDCLOUD_UK_SECRET_KEY
        ),

      sendcloudFRConfigured:
        Boolean(
          process.env
            .SENDCLOUD_FR_PUBLIC_KEY &&
          process.env
            .SENDCLOUD_FR_SECRET_KEY
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
      `Products in portal cache: ${cachedProducts.length}`
    );

    console.log(
      `Sales Persons in cache: ${cachedSalesPersons.length}`
    );

    console.log(
      `SMP sequence starts checking from: SMP--${String(nextSmpNumberInMemory).padStart(7, "0")}`
    );

    console.log(
      `Resend configured: ${Boolean(process.env.RESEND_API_KEY)}`
    );

    console.log(
      `Sendcloud UK configured: ${Boolean(process.env.SENDCLOUD_UK_PUBLIC_KEY && process.env.SENDCLOUD_UK_SECRET_KEY)}`
    );

    console.log(
      `Sendcloud FR configured: ${Boolean(process.env.SENDCLOUD_FR_PUBLIC_KEY && process.env.SENDCLOUD_FR_SECRET_KEY)}`
    );
  }
);