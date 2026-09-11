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

const UNLEASHED_API_URL = process.env.UNLEASHED_API_URL || "https://api.unleashedsoftware.com/";
const UNLEASHED_AUTH_ID = process.env.UNLEASHED_AUTH_ID;
const UNLEASHED_API_KEY = process.env.UNLEASHED_API_KEY;

let cachedProducts = [];
let cachedSalesPersons = [];
let isRefreshing = false; // Zapobiega nakładaniu się pobierań w pamięci

const UNLEASHED_BRANDS = [
  "Able",
  "Avant",
  "Flanerie",
  "Mix",
  "Sentier",
  "Symbiosis"
];

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

const ALLOWED_SKU_PREFIXES = [
  "AV", "AVK", "AVX",
  "AB", "ABK", "ABX",
  "SY", "SYK", "SYX",
  "SR", "SRK", "SRX",
  "FL", "FLK", "FLX"
];

function getUnleashedHeaders(queryString = "") {
  const hash = crypto.createHmac("sha256", UNLEASHED_API_KEY).update(queryString).digest("base64");
  return {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "api-auth-id": UNLEASHED_AUTH_ID,
    "api-auth-signature": hash
  };
}

async function refreshProductCatalog() {
  if (isRefreshing) {
    console.log("⏳ Odświeżanie katalogu już trwa w tle, pomijam nakładające się wywołanie.");
    return;
  }

  isRefreshing = true;

  try {
    console.log("🔄 Pobieranie katalogu z Unleashed API (optymalizacja pamięci RAM)...");
    
    const uniqueProductsMap = new Map();
    let page = 1;
    let totalPages = 1;

    // Streamowanie stron i bezpośrednie filtrowanie w locie
    do {
      const queryString = `pageSize=1000&page=${page}&includeObsolete=false`;
      const url = `${UNLEASHED_API_URL}Products?${queryString}`;
      const response = await axios.get(url, { headers: getUnleashedHeaders(queryString) });

      if (response.data && response.data.Items) {
        response.data.Items.forEach(p => {
          const sku = (p.ProductCode || "").trim().toUpperCase();
          const isSellable = p.IsSellable === true;
          const isNotObsolete = p.IsObsolete !== true;
          const matchesPrefix = ALLOWED_SKU_PREFIXES.some(prefix => sku.startsWith(prefix));

          if (isSellable && isNotObsolete && matchesPrefix && sku) {
            if (!uniqueProductsMap.has(sku)) {
              uniqueProductsMap.set(sku, {
                sku: p.ProductCode || "",
                name: p.ProductDescription || "",
                brand: p.ProductGroup?.GroupName || p.Brand || "Avant",
                weight: p.Weight || 0.1,
                hsCode: p.CustomsCode || "33049900",
                price: p.AverageCost || 0.00
              });
            }
          }
        });

        totalPages = response.data.Pagination.NumberOfPages;
      }
      page++;
    } while (page <= totalPages);

    cachedProducts = Array.from(uniqueProductsMap.values());

    // Pobieranie SalesPersons
    try {
      const spUrl = `${UNLEASHED_API_URL}Salespersons`;
      const spResponse = await axios.get(spUrl, { headers: getUnleashedHeaders("") });
      if (spResponse.data && spResponse.data.Items) {
        const emailMap = new Map();

        spResponse.data.Items.forEach(sp => {
          const email = (sp.Email || "").toLowerCase().trim();
          if (ALLOWED_SALES_EMAILS.includes(email) && !emailMap.has(email)) {
            emailMap.set(email, {
              fullName: sp.FullName || `${sp.FirstName || ''} ${sp.LastName || ''}`.trim(),
              email: email,
              code: sp.SalespersonCode || email
            });
          }
        });

        cachedSalesPersons = Array.from(emailMap.values());
      }
    } catch (spErr) {
      console.error("⚠️ Błąd pobierania Salespersons:", spErr.message);
    }

    fs.writeFileSync(CACHE_FILE, JSON.stringify({ products: cachedProducts, salesPersons: cachedSalesPersons }, null, 2));
    console.log(`✅ [Catalog Cache] Zapisano w pamięci ${cachedProducts.length} unikalnych produktów.`);
  } catch (error) {
    console.error("❌ Błąd pobierania danych z Unleashed:", error.message);
    if (fs.existsSync(CACHE_FILE)) {
      const rawData = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      cachedProducts = rawData.products || [];
      cachedSalesPersons = rawData.salesPersons || [];
    }
  } finally {
    isRefreshing = false;
  }
}

// Ładowanie z dysku przy starcie
if (fs.existsSync(CACHE_FILE)) {
  try {
    const rawData = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    cachedProducts = rawData.products || [];
    cachedSalesPersons = rawData.salesPersons || [];
    console.log(`⚡ [Disk Cache] Załadowano ${cachedProducts.length} produktów i ${cachedSalesPersons.length} SalesPersons.`);
  } catch (e) {
    refreshProductCatalog();
  }
} else {
  refreshProductCatalog();
}

setInterval(refreshProductCatalog, 12 * 60 * 60 * 1000);

app.get("/api/products", async (req, res) => {
  if (cachedProducts.length === 0 && !isRefreshing) {
    await refreshProductCatalog();
  }
  res.json({
    products: cachedProducts,
    brands: UNLEASHED_BRANDS,
    salesPersons: cachedSalesPersons
  });
});

app.post("/api/create-smp-order", async (req, res) => {
  try {
    const data = req.body;
    const countryCode = (data.country || "").toUpperCase();

    const euCountries = ["FR", "DE", "PL", "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PT", "RO", "SK", "SI", "ES", "SE"];
    const isEU = euCountries.includes(countryCode);
    const warehouseCode = isEU ? "FR_Atypic" : "UK_W1";
    const customerCode = isEU ? "FR_SAMPLES_EUR" : "UK_SAMPLES_GBP";

    const orderNumber = `SMP-${Date.now().toString().slice(-6)}`;

    const salesOrderLines = data.items.map((item, index) => ({
      LineNumber: index + 1,
      Product: { ProductCode: item.sku },
      OrderQuantity: item.quantity,
      UnitPrice: 0.00,
      LineTotal: 0.00
    }));

    const unleashedPayload = {
      OrderNumber: orderNumber,
      OrderDate: new Date().toISOString().split("T")[0],
      OrderStatus: "Parked",
      Customer: { CustomerCode: customerCode },
      Warehouse: { WarehouseCode: warehouseCode },
      CustomerRef: `SMP Order - ${data.requestedBy}`,
      Comments: `Requested by: ${data.requestedBy} (${data.requestedByEmail}) | Brand: ${data.brand} | Black Box Required: ${data.blackBoxRequired}`,
      Brand: data.brand || "Avant",
      SalesPerson: data.salesPerson ? { Email: data.salesPerson, FullName: data.requestedBy } : undefined,
      DeliveryName: data.recipientName,
      DeliveryCompany: data.partnerCompany || "",
      DeliveryStreetAddress: data.streetAddress,
      DeliveryStreetAddress2: data.streetAddress2 || "",
      DeliverySuburb: data.city,
      DeliveryCity: data.city,
      DeliveryRegion: data.region || "",
      DeliveryPostCode: data.postCode,
      DeliveryCountry: countryCode,
      DeliveryContact: data.phone,
      SalesOrderLines: salesOrderLines
    };

    console.log(`📤 Tworzenie zamówienia ${orderNumber} w Unleashed (SalesPerson: ${data.salesPerson})...`);
    const unleashedUrl = `${UNLEASHED_API_URL}SalesOrders/${orderNumber}`;
    const unleashedRes = await axios.post(unleashedUrl, unleashedPayload, {
      headers: getUnleashedHeaders("")
    });

    console.log(`📦 Rejestracja paczki w Sendcloud dla kraju ${countryCode}...`);
    const sendcloudResult = await createSendcloudParcel(data, orderNumber);

    res.json({
      success: true,
      orderNumber: orderNumber,
      warehouseAssigned: warehouseCode,
      unleashedResponse: unleashedRes.data,
      sendcloudParcelId: sendcloudResult.parcel ? sendcloudResult.parcel.id : null
    });

  } catch (error) {
    console.error("❌ Błąd przetwarzania zamówienia SMP:", error.response ? error.response.data : error.message);
    res.status(500).json({
      success: false,
      error: error.response ? JSON.stringify(error.response.data) : error.message
    });
  }
});

app.post("/api/sendcloud-webhook", (req, res) => {
  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log(`🚀 Serwer uruchomiony na porcie ${PORT}`);
});