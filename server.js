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

// Zmienne środowiskowe
const UNLEASHED_API_URL =
  process.env.UNLEASHED_API_URL ||
  "https://api.unleashedsoftware.com/";

const UNLEASHED_AUTH_ID =
  process.env.UNLEASHED_AUTH_ID;

const UNLEASHED_API_KEY =
  process.env.UNLEASHED_API_KEY;

let cachedProducts = [];
let cachedSalesPersons = [];
let isRefreshing = false;

const UNLEASHED_BRANDS = [
  "Able",
  "Avant",
  "Flanerie",
  "Mix",
  "Sentier",
  "Symbiosis"
];

// Lista dozwolonych adresów e-mail dla Sales Persons
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

// Dedykowana lista prefiksów SKU
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

// Kraje UE
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

// Helper do autoryzacji Unleashed API (HMAC-SHA256)
function getUnleashedHeaders(queryString = "") {
  const hash = crypto
    .createHmac("sha256", UNLEASHED_API_KEY)
    .update(queryString)
    .digest("base64");

  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "api-auth-id": UNLEASHED_AUTH_ID,
    "api-auth-signature": hash
  };
}

// Generator GUID - taki sam schemat jak w działającej integracji Shopify
function generateGUID() {
  const randomBytes = crypto.randomBytes(16);

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

// Pobieranie i zapisywanie katalogu oraz listy SalesPersons
async function refreshProductCatalog() {
  if (isRefreshing) {
    console.log(
      "⏳ Odświeżanie katalogu już trwa w tle, pomijam nakładające się wywołanie."
    );
    return;
  }

  isRefreshing = true;

  try {
    console.log(
      "🔄 Pobieranie katalogu z Unleashed API (unikalne SKU + Sellable + Prefiksy)..."
    );

    const uniqueProductsMap =
      new Map();

    let page = 1;
    let totalPages = 1;

    do {
      const queryString =
        `pageSize=1000&page=${page}&includeObsolete=false`;

      const url =
        `${UNLEASHED_API_URL}Products?${queryString}`;

      const response =
        await axios.get(url, {
          headers:
            getUnleashedHeaders(
              queryString
            )
        });

      if (
        response.data &&
        response.data.Items
      ) {
        response.data.Items.forEach(
          (p) => {
            const sku =
              (
                p.ProductCode ||
                ""
              )
                .trim()
                .toUpperCase();

            const isSellable =
              p.IsSellable ===
              true;

            const isNotObsolete =
              p.IsObsolete !==
              true;

            const matchesPrefix =
              ALLOWED_SKU_PREFIXES.some(
                (prefix) =>
                  sku.startsWith(
                    prefix
                  )
              );

            if (
              isSellable &&
              isNotObsolete &&
              matchesPrefix &&
              sku
            ) {
              if (
                !uniqueProductsMap.has(
                  sku
                )
              ) {
                uniqueProductsMap.set(
                  sku,
                  {
                    sku:
                      p.ProductCode ||
                      "",

                    name:
                      p.ProductDescription ||
                      "",

                    brand:
                      p.ProductGroup
                        ?.GroupName ||
                      p.Brand ||
                      "Avant",

                    weight:
                      p.Weight ||
                      0.1,

                    hsCode:
                      p.CustomsCode ||
                      "33049900",

                    price:
                      p.AverageCost ||
                      0
                  }
                );
              }
            }
          }
        );

        totalPages =
          response.data
            .Pagination
            .NumberOfPages;
      }

      page++;
    } while (
      page <= totalPages
    );

    cachedProducts =
      Array.from(
        uniqueProductsMap.values()
      );

    // Pobieranie i unikalizacja Salespersons
    try {
      const spUrl =
        `${UNLEASHED_API_URL}Salespersons`;

      const spResponse =
        await axios.get(
          spUrl,
          {
            headers:
              getUnleashedHeaders(
                ""
              )
          }
        );

      if (
        spResponse.data &&
        spResponse.data.Items
      ) {
        const emailMap =
          new Map();

        spResponse.data.Items.forEach(
          (sp) => {
            const email =
              (
                sp.Email ||
                ""
              )
                .toLowerCase()
                .trim();

            if (
              ALLOWED_SALES_EMAILS.includes(
                email
              ) &&
              !emailMap.has(
                email
              )
            ) {
              emailMap.set(
                email,
                {
                  // WAŻNE: zapisujemy GUID
                  guid:
                    sp.Guid,

                  fullName:
                    sp.FullName ||
                    `${sp.FirstName || ""} ${sp.LastName || ""}`.trim(),

                  email:
                    email,

                  code:
                    sp.SalespersonCode ||
                    email
                }
              );
            }
          }
        );

        cachedSalesPersons =
          Array.from(
            emailMap.values()
          );
      }
    } catch (spErr) {
      console.error(
        "⚠️ Błąd pobierania Salespersons:",
        spErr.response?.data ||
        spErr.message
      );
    }

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
      `✅ [Catalog Cache] Zapisano ${cachedProducts.length} produktów i ${cachedSalesPersons.length} SalesPersons.`
    );
  } catch (error) {
    console.error(
      "❌ Błąd pobierania danych z Unleashed:",
      error.response?.data ||
      error.message
    );

    if (
      fs.existsSync(
        CACHE_FILE
      )
    ) {
      const rawData =
        JSON.parse(
          fs.readFileSync(
            CACHE_FILE,
            "utf8"
          )
        );

      cachedProducts =
        rawData.products ||
        [];

      cachedSalesPersons =
        rawData.salesPersons ||
        [];
    }
  } finally {
    isRefreshing = false;
  }
}

// Inicjalizacja przy starcie
if (
  fs.existsSync(
    CACHE_FILE
  )
) {
  try {
    const rawData =
      JSON.parse(
        fs.readFileSync(
          CACHE_FILE,
          "utf8"
        )
      );

    cachedProducts =
      rawData.products ||
      [];

    cachedSalesPersons =
      rawData.salesPersons ||
      [];

    console.log(
      `⚡ [Disk Cache] Załadowano ${cachedProducts.length} produktów i ${cachedSalesPersons.length} SalesPersons.`
    );
  } catch (e) {
    refreshProductCatalog();
  }
} else {
  refreshProductCatalog();
}

setInterval(
  refreshProductCatalog,
  12 * 60 * 60 * 1000
);

// Endpoint do pobierania katalogu
app.get(
  "/api/products",
  async (req, res) => {
    if (
      cachedProducts.length ===
        0 &&
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

      const countryCode =
        (
          data.country ||
          ""
        )
          .trim()
          .toUpperCase();

     const isEU = EU_COUNTRIES.includes(countryCode);

let warehouseCode;
let currencyCode;

// CUSTOMER ZAWSZE SMP
const customerCode = "SMP";

if (countryCode === "US") {
  // USA
  warehouseCode = "UK_W1";
  currencyCode = "USD";

} else if (countryCode === "GB") {
  // UNITED KINGDOM
  warehouseCode = "UK_W1";
  currencyCode = "GBP";

} else if (isEU) {
  // EUROPEAN UNION
  warehouseCode = "FR_Atypic";
  currencyCode = "EUR";

} else {
  // REST OF WORLD
  warehouseCode = "UK_W1";
  currencyCode = "GBP";
}
console.log(
  `🌍 Routing: ${countryCode} → Customer: ${customerCode} | Warehouse: ${warehouseCode} | Currency: ${currencyCode}`
);
      // ------------------------------------------
      // SALES PERSON LOOKUP
      // ------------------------------------------

      const selectedSalesPerson =
        cachedSalesPersons.find(
          (sp) =>
            sp.email ===
            (
              data.requestedByEmail ||
              data.salesPerson ||
              ""
            )
              .toLowerCase()
              .trim()
        );

      if (
        !selectedSalesPerson
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              `Sales Person not found: ${data.requestedByEmail || data.salesPerson}`
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
              `Sales Person ${selectedSalesPerson.email} has no GUID. Usuń catalog_cache.json i zrestartuj serwer.`
          });
      }

      // ------------------------------------------
      // ORDER IDs
      // ------------------------------------------

      const orderGuid =
        generateGUID();

      const orderNumber =
        `SMP-${Date.now()
          .toString()
          .slice(-6)}`;

      // ------------------------------------------
      // ORDER LINES
      // SMP zawsze darmowe
      // ------------------------------------------

      const salesOrderLines =
        data.items.map(
          (
            item,
            index
          ) => ({
            Guid:
              generateGUID(),

            LineNumber:
              index + 1,

            Product: {
              ProductCode:
                item.sku
            },

            OrderQuantity:
              Number(
                item.quantity
              ) || 1,

            UnitPrice: 0,

            LineTotal: 0,

            LineTax: 0,

            DiscountRate: 0,

            TaxCode:
              "NONE",

            TaxRate: 0,

            SalesOrderGroup:
              data.brand
          })
        );

      // ------------------------------------------
      // PAYLOAD
      // ------------------------------------------

      const unleashedPayload = {
        Guid:
          orderGuid,

        OrderNumber:
          orderNumber,

        OrderDate:
          new Date().toISOString(),

        RequiredDate:
          new Date().toISOString(),

        OrderStatus:
          "Parked",

        Customer: {
          CustomerCode:
            customerCode
        },

        Warehouse: {
          WarehouseCode:
            warehouseCode
        },

        Currency: {
          CurrencyCode:
            currencyCode
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

        Comments:
          `Requested by: ${data.requestedBy} (${data.requestedByEmail}) | ` +
          `Brand: ${data.brand} | ` +
          `Black Box Required: ${data.blackBoxRequired} | ` +
          `Recipient Email: ${data.recipientEmail} | ` +
          `Phone: ${data.phone}`,

        // UWAGA:
        // Nie wysyłamy DeliveryContact,
        // bo to nie jest pole na numer telefonu.

        DeliveryName:
          data.recipientName,

        DeliveryStreetAddress:
          data.streetAddress,

        DeliveryStreetAddress2:
          data.streetAddress2 ||
          "",

        DeliverySuburb:
          "",

        DeliveryCity:
          data.city,

        DeliveryRegion:
          data.region ||
          "",

        DeliveryPostCode:
          data.postCode,

        DeliveryCountry:
          countryCode,

        // SMP = FREE
        SubTotal: 0,
        TaxTotal: 0,
        Total: 0,

        Tax: {
          TaxCode:
            "NONE",
          TaxRate: 0
        },

        ExchangeRate: 1,

        SalesOrderLines:
          salesOrderLines
      };

      console.log(
        `🚀 Tworzenie zamówienia ${orderNumber} w Unleashed...`
      );

      console.log(
        `👤 Sales Person: ${selectedSalesPerson.fullName} (${selectedSalesPerson.email})`
      );

      console.log(
        `🏷 Brand: ${data.brand}`
      );

      console.log(
        `🏬 Warehouse: ${warehouseCode}`
      );

      console.log(
        "📤 Unleashed payload:"
      );

      console.log(
        JSON.stringify(
          unleashedPayload,
          null,
          2
        )
      );

      // ------------------------------------------
      // POST TAK SAMO JAK W DZIAŁAJĄCEJ
      // INTEGRACJI SHOPIFY
      // ------------------------------------------

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
              getUnleashedHeaders(
                ""
              )
          }
        );

      console.log(
        `✅ Zamówienie ${orderNumber} utworzone w Unleashed.`
      );

      // ------------------------------------------
      // SENDCLOUD
      // ------------------------------------------

      console.log(
        `📦 Rejestracja paczki w Sendcloud dla kraju ${countryCode}...`
      );

      const sendcloudResult =
        await createSendcloudParcel(
          data,
          orderNumber
        );

      if (
        !sendcloudResult.success
      ) {
        console.error(
          "⚠️ Unleashed order utworzony, ale Sendcloud zwrócił błąd:",
          sendcloudResult.error ||
          sendcloudResult.reason
        );
      }

      res.json({
        success: true,

        orderNumber:
          orderNumber,

        orderGuid:
          orderGuid,

        warehouseAssigned:
          warehouseCode,

        unleashedResponse:
          unleashedRes.data,

        sendcloudParcelId:
          sendcloudResult.parcel
            ? sendcloudResult
                .parcel.id
            : null,

        sendcloudSuccess:
          sendcloudResult.success
      });
    } catch (error) {
      console.error(
        "❌ Błąd przetwarzania zamówienia SMP:"
      );

      if (
        error.response
      ) {
        console.error(
          "Status:",
          error.response.status
        );

        console.error(
          "Response:",
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
          error.message
        );
      }

      res.status(500).json({
        success: false,

        error:
          error.response
            ? JSON.stringify(
                error.response
                  .data
              )
            : error.message
      });
    }
  }
);

// Sendcloud webhook
app.post(
  "/api/sendcloud-webhook",
  (req, res) => {
    res
      .status(200)
      .send("OK");
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `🚀 Serwer uruchomiony na porcie ${PORT}`
    );
  }
);