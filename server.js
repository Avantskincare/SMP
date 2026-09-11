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

// Zmienne środowiskowe z .env / Render
const UNLEASHED_API_URL = process.env.UNLEASHED_API_URL || "https://api.unleashedsoftware.com/";
const UNLEASHED_AUTH_ID = process.env.UNLEASHED_AUTH_ID;
const UNLEASHED_API_KEY = process.env.UNLEASHED_API_KEY;

let cachedProducts = [];

// Lista marek ze skanu Unleashed
const UNLEASHED_BRANDS = [
  "Able",
  "Avant",
  "Flanerie",
  "Mix",
  "Sentier",
  "Symbiosis"
];

// Helper do autoryzacji Unleashed (HMAC-SHA256)
function getUnleashedHeaders(queryString = "") {
  const hash = crypto.createHmac("sha256", UNLEASHED_API_KEY).update(queryString).digest("base64");
  return {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "api-auth-id": UNLEASHED_AUTH_ID,
    "api-auth-signature": hash
  };
}

// Pobieranie i chowanie katalogu produktów w pamięci
async function refreshProductCatalog() {
  try {
    console.log("🔄 Pobieranie pełnego katalogu z Unleashed API...");
    let allItems = [];
    let page = 1;
    let totalPages = 1;

    do {
      const queryString = `pageSize=1000&page=${page}`;
      const url = `${UNLEASHED_API_URL}Products?${queryString}`;
      const response = await axios.get(url, { headers: getUnleashedHeaders(queryString) });

      if (response.data && response.data.Items) {
        allItems = allItems.concat(response.data.Items);
        totalPages = response.data.Pagination.NumberOfPages;
      }
      page++;
    } while (page <= totalPages);

    const mapped = allItems.map((p) => ({
      sku: p.ProductCode || "",
      name: p.ProductDescription || "",
      brand: p.ProductGroup?.GroupName || p.Brand || "Avant",
      weight: p.Weight || 0.1,
      hsCode: p.CustomsCode || "33049900",
      price: p.AverageCost || 0.00
    }));

    cachedProducts = mapped;
    fs.writeFileSync(CACHE_FILE, JSON.stringify(mapped, null, 2));
    console.log(`✅ [Catalog Cache] Zapisano w pamięci ${mapped.length} produktów.`);
  } catch (error) {
    console.error("❌ Błąd pobierania katalogu produktów z Unleashed:", error.message);
    if (fs.existsSync(CACHE_FILE)) {
      const rawData = fs.readFileSync(CACHE_FILE, "utf8");
      cachedProducts = JSON.parse(rawData);
      console.log(`⚡ [Disk Cache] Załadowano ${cachedProducts.length} produktów z pliku lokalnego.`);
    }
  }
}

// Inicjalizacja pamięci podręcznej przy starcie
if (fs.existsSync(CACHE_FILE)) {
  try {
    const rawData = fs.readFileSync(CACHE_FILE, "utf8");
    cachedProducts = JSON.parse(rawData);
    console.log(`⚡ [Disk Cache] Załadowano ${cachedProducts.length} produktów z pliku lokalnego.`);
  } catch (e) {
    refreshProductCatalog();
  }
} else {
  refreshProductCatalog();
}

// Interwał odświeżania katalogu co 12 godzin
setInterval(refreshProductCatalog, 12 * 60 * 60 * 1000);

// -------------------------------------------------------------------
// 1. GET /api/products - Zwraca produkty oraz marki dla portalu
// -------------------------------------------------------------------
app.get("/api/products", async (req, res) => {
  if (cachedProducts.length === 0) {
    await refreshProductCatalog();
  }
  res.json({
    products: cachedProducts,
    brands: UNLEASHED_BRANDS
  });
});

// -------------------------------------------------------------------
// 2. POST /api/create-smp-order - Tworzenie zamówienia w Unleashed i Sendcloud
// -------------------------------------------------------------------
app.post("/api/create-smp-order", async (req, res) => {
  try {
    const data = req.body;
    const countryCode = (data.country || "").toUpperCase();

    // Kraje Unii Europejskiej realizowane przez magazyn w Unii (FR_Atypic)
    const euCountries = ["FR", "DE", "PL", "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PT", "RO", "SK", "SI", "ES", "SE"];
    
    const isEU = euCountries.includes(countryCode);
    const warehouseCode = isEU ? "FR_Atypic" : "UK_W1";
    const customerCode = isEU ? "FR_SAMPLES_EUR" : "UK_SAMPLES_GBP";

    // Unikalny numer zamówienia SMP
    const orderNumber = `SMP-${Date.now().toString().slice(-6)}`;

    // Przygotowanie linii zamówienia Unleashed
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
      CustomerRef: data.internalRef || `SMP Order - ${data.requestedBy}`,
      Comments: `Requested by: ${data.requestedBy} (${data.requestedByEmail}) | Team: ${data.team} | Brand: ${data.brand} | Insert: ${data.insertRequired}`,
      Brand: data.brand || "Avant",
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

    // Wysłanie zamówienia do Unleashed API
    console.log(`📤 Tworzenie zamówienia ${orderNumber} w Unleashed (Magazyn: ${warehouseCode})...`);
    const unleashedUrl = `${UNLEASHED_API_URL}SalesOrders/${orderNumber}`;
    const unleashedRes = await axios.post(unleashedUrl, unleashedPayload, {
      headers: getUnleashedHeaders("")
    });

    // Tworzenie paczki w Sendcloud (UK lub FR)
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

// -------------------------------------------------------------------
// 3. POST /api/sendcloud-webhook - Nasłuch na statusy przesyłek
// -------------------------------------------------------------------
app.post("/api/sendcloud-webhook", (req, res) => {
  console.log("📬 Otrzymano Webhook z Sendcloud:", req.body.action || "Notification");
  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log(`🚀 SMP Portal Server running on http://localhost:${PORT}`);
});