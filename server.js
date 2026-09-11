require("dotenv").config(); // Wczytuje zmienne z pliku .env na samym starcie

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { createSendcloudParcel } = require("./sendcloudService");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// API Configurations (pobierane z pliku .env)
const API_URL = process.env.UNLEASHED_API_URL || "https://api.unleashedsoftware.com/";
const API_AUTH_ID = process.env.UNLEASHED_AUTH_ID;
const API_KEY = process.env.UNLEASHED_API_KEY;

const LOCAL_CACHE_FILE = path.join(__dirname, "catalog_cache.json");

// Lista krajów Unii Europejskiej (kierowanie do magazynu FR_Atypic i konta Sendcloud FR)
const EU_COUNTRIES = [
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI",
  "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT",
  "NL", "PL", "PT", "RO", "SE", "SI", "SK"
];

// Helper: Sygnatura HMAC SHA256 dla Unleashed API
const getSignature = (queryString = "") => {
  return crypto.createHmac("sha256", API_KEY).update(queryString).digest("base64");
};

// Helper: Identyfikator GUID
const generateGUID = () => crypto.randomUUID();

// Helper: Pauza dla limitów API (Rate Limiting)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Logika przydziału magazynu: UE -> FR_Atypic, Reszta Świata -> UK_W1
const determineWarehouse = (countryCode) => {
  const code = (countryCode || "").toUpperCase().trim();
  return EU_COUNTRIES.includes(code) ? "FR_Atypic" : "UK_W1";
};

// -------------------------------------------------------------------
// Pamięć podręczna produktów (RAM + Plik lokalny)
// -------------------------------------------------------------------
let cachedProducts = [];

if (fs.existsSync(LOCAL_CACHE_FILE)) {
  try {
    const raw = fs.readFileSync(LOCAL_CACHE_FILE, "utf-8");
    cachedProducts = JSON.parse(raw);
    console.log(`⚡ [Disk Cache] Załadowano ${cachedProducts.length} produktów z pliku lokalnego.`);
  } catch (e) {
    console.error("❌ Błąd odczytu pliku cache katalogu:", e.message);
  }
}

// Pobieranie pełnego katalogu z Unleashed API (razem z wagą, HS Code i cenami)
async function refreshProductCatalog() {
  try {
    let allProducts = [];
    let page = 1;
    let hasMorePages = true;

    console.log("🔄 Pobieranie pełnego katalogu z Unleashed API...");

    while (hasMorePages) {
      const queryString = `page=${page}&pageSize=1000`;
      const signature = getSignature(queryString);

      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "api-auth-id": API_AUTH_ID,
        "api-auth-signature": signature,
        "client-type": "inhouse/smp-portal",
      };

      const response = await axios.get(`${API_URL}Products/${page}?${queryString}`, { headers });
      const items = response.data?.Items || [];
      const pagination = response.data?.Pagination;

      const mapped = items.map((p) => ({
        sku: p.ProductCode || "",
        name: p.ProductDescription || "",
        weight: p.Weight || 0.1,               // Waga z Unleashed w kg
        hsCode: p.CustomsCode || "33049900",    // Kod HS z Unleashed LUB domyślny kosmetyczny
        price: p.AverageCost || 0.00,           // Wartość szacunkowa
      }));

      allProducts = allProducts.concat(mapped);

      if (pagination && page < pagination.NumberOfPages) {
        page++;
        await sleep(350);
      } else {
        hasMorePages = false;
      }
    }

    cachedProducts = allProducts;
    fs.writeFileSync(LOCAL_CACHE_FILE, JSON.stringify(cachedProducts));
    console.log(`✅ [Catalog Cache] Zapisano w pamięci ${cachedProducts.length} produktów (z wagami i HS Code).`);
  } catch (error) {
    console.error("❌ Błąd pobierania katalogu produktów z Unleashed:", error.response?.data || error.message);
  }
}

// Pobranie katalogu w tle przy starcie serwera
refreshProductCatalog();

// -------------------------------------------------------------------
// 1. Sendcloud Webhook Endpoint (GET & POST) - Weryfikacja dla ngrok
// -------------------------------------------------------------------
app.route("/api/sendcloud-webhook")
  .get((req, res) => {
    res.setHeader("ngrok-skip-browser-warning", "true");
    res.status(200).send("Sendcloud Webhook Active");
  })
  .post((req, res) => {
    res.setHeader("ngrok-skip-browser-warning", "true");
    console.log("📩 Otrzymano Webhook z Sendcloud:", req.body?.action);
    res.status(200).json({ received: true });
  });

// -------------------------------------------------------------------
// 2. GET /api/products - Pobieranie listy produktów dla interfejsu
// -------------------------------------------------------------------
app.get("/api/products", async (req, res) => {
  if (cachedProducts.length === 0) {
    await refreshProductCatalog();
  }
  res.json(cachedProducts);
});

// -------------------------------------------------------------------
// 3. POST /api/create-smp-order - Tworzenie zamówienia (Unleashed + Sendcloud)
// -------------------------------------------------------------------
app.post("/api/create-smp-order", async (req, res) => {
  try {
    const {
      team,
      requestedBy,
      requestedByEmail,
      internalRef,
      requiredDeliveryDate,
      insertRequired,
      partnerCompany,
      brand,
      items, // Tablica pozycji [{ sku, productName, quantity }]
      recipientName,
      recipientEmail,
      streetAddress,
      streetAddress2,
      city,
      region,
      postCode,
      country,
      phone,
    } = req.body;

    const orderGUID = generateGUID();
    const warehouseCode = determineWarehouse(country);
    const orderNumber = `SMP--${Date.now().toString().slice(-6)}`;

    // Uzupełnienie pozycji o dane wagi i HS Code z pamięci podręcznej katalogu
    const enrichedItems = (items || []).map((item) => {
      const match = cachedProducts.find((p) => p.sku.toLowerCase() === (item.sku || "").toLowerCase());
      return {
        ...item,
        weight: match?.weight || 0.1,
        hsCode: match?.hsCode || "33049900",
        price: match?.price || 0.00,
      };
    });

    // Budowanie linii zamówienia dla Unleashed
    const salesOrderLines = enrichedItems.map((item, idx) => ({
      Guid: generateGUID(),
      LineNumber: idx + 1,
      OrderQuantity: parseInt(item.quantity, 10) || 1,
      UnitPrice: 0, // Próbki SMP mają wartość 0 w Unleashed
      Product: {
        ProductCode: item.sku,
        ProductDescription: item.productName,
      },
      SalesOrderGroup: brand,
    }));

    // Struktura zamówienia Unleashed
    const salesOrder = {
      Guid: orderGUID,
      OrderStatus: "Parked",
      Customer: { CustomerCode: "SMP" },
      OrderNumber: orderNumber,
      Brand: brand,
      CustomerRef: internalRef || `Requested by ${requestedBy}`,
      DeliveryName: recipientName,
      DeliveryStreetAddress: streetAddress,
      DeliveryStreetAddress2: streetAddress2 || "",
      DeliveryCity: city || "",
      DeliveryRegion: region || "",
      DeliveryCountry: country,
      DeliveryPostCode: postCode,
      RequiredDate: requiredDeliveryDate ? new Date(requiredDeliveryDate).toISOString() : null,
      SalesOrderLines: salesOrderLines,
      SalesOrderGroup: brand,
      Tax: { TaxCode: "NONE", TaxRate: 0.0 },
      Warehouse: { WarehouseCode: warehouseCode },
      Currency: { CurrencyCode: "GBP" },
      Comments: `Team: ${team} | Requested By: ${requestedBy} (${requestedByEmail || 'N/A'}) | Partner/Company: ${partnerCompany || "N/A"} | Insert Required: ${insertRequired} | Phone: ${phone}`,
    };

    const signature = getSignature("");
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "api-auth-id": API_AUTH_ID,
      "api-auth-signature": signature,
      "client-type": "inhouse/smp-portal",
    };

    // 1. Zapis zamówienia w Unleashed
    const response = await axios.post(
      `${API_URL}SalesOrders/${orderGUID}`,
      JSON.stringify(salesOrder),
      { headers }
    );

    console.log(`✅ Zamówienie ${orderNumber} zapisane w Unleashed! Magazyn: ${warehouseCode}`);

    // 2. Automatyczna rejestracja paczki i produktów w Sendcloud
    let sendcloudResult = null;
    try {
      sendcloudResult = await createSendcloudParcel({ ...req.body, items: enrichedItems }, orderNumber);
    } catch (scErr) {
      console.error("⚠️ Błąd rejestracji paczki w Sendcloud:", scErr.message);
    }

    // 3. Odpowiedź dla interfejsu
    res.status(200).json({
      success: true,
      orderNumber: orderNumber,
      warehouseAssigned: warehouseCode,
      sendcloudAccount: sendcloudResult?.account || null,
      sendcloudParcelId: sendcloudResult?.parcel?.id || null,
      data: response.data,
    });
  } catch (error) {
    console.error("❌ Błąd tworzenia zamówienia w Unleashed:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// Uruchomienie Serwera
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SMP Portal Server running on http://localhost:${PORT}`);
});