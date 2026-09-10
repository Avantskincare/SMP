const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// Config from Environment Variables (with fallbacks to your current credentials)
const API_URL = process.env.UNLEASHED_API_URL || "https://api.unleashedsoftware.com/";
const API_AUTH_ID = process.env.UNLEASHED_AUTH_ID || "25ffd73c-66d0-4f3b-9139-1bc08fc14550";
const API_KEY = process.env.UNLEASHED_API_KEY || "a18nznIOhkM0L1D40Z0BI7COJl5qsyTV6YmZbA27qAdTpQI1bLPtEj5CfbvGw9rPDSJaEmpOdNSJoIOx9Vw==";

// HMAC Signature Generator (Same as your working script)
const getSignature = (queryString = "") => {
  return crypto.createHmac("sha256", API_KEY).update(queryString).digest("base64");
};

// Unleashed Request Helper
const unleashedRequest = async (endpoint, method = "GET", data = null) => {
  const url = `${API_URL}${endpoint}`;
  const signature = getSignature("");

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "api-auth-id": API_AUTH_ID,
    "api-auth-signature": signature,
    "client-type": "inhouse/sampleportal",
  };

  const config = { method, url, headers };
  if (data) config.data = data;

  const response = await axios(config);
  return response.data;
};

// 1. GET /api/products — Fetch active SKUs for the dropdown
app.get("/api/products", async (req, res) => {
  try {
    const data = await unleashedRequest("Products?pageSize=1000");
    const products = (data.Items || []).map((p) => ({
      code: p.ProductCode,
      description: p.ProductDescription,
    }));
    res.json(products);
  } catch (err) {
    console.error("Failed to fetch products:", err.message);
    res.status(500).json({ error: "Could not load products" });
  }
});

// 2. POST /api/create-sample-order — Submit form data to Unleashed
app.post("/api/create-sample-order", async (req, res) => {
  try {
    const form = req.body;
    const orderNumber = `SMP--${Date.now().toString().slice(-6)}`;

    const unleashedPayload = {
      OrderStatus: "Parked",
      Customer: { CustomerCode: form.customerCode || "SMP" },
      OrderNumber: orderNumber,
      CustomerRef: form.customerRef || orderNumber,
      DeliveryName: form.deliveryName,
      DeliveryStreetAddress: form.address1,
      DeliveryStreetAddress2: form.address2 || "",
      DeliveryCity: form.city,
      DeliveryCountry: form.country,
      DeliveryPostCode: form.postCode,
      Warehouse: { WarehouseCode: form.warehouse || "FR_Atypic" },
      Comments: `Salesperson: ${form.salesperson || "N/A"} | Notes: ${form.notes || "None"}`,
      SalesOrderLines: form.lineItems.map((item, index) => ({
        LineNumber: index + 1,
        Product: { ProductCode: item.sku },
        OrderQuantity: parseInt(item.quantity, 10),
        UnitPrice: 0.00, // Sample orders default to 0
      })),
    };

    const result = await unleashedRequest("SalesOrders/" + crypto.randomUUID(), "POST", unleashedPayload);
    res.json({ success: true, orderNumber: result.OrderNumber || orderNumber });
  } catch (err) {
    console.error("Order creation error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to create order in Unleashed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sample Portal running on port ${PORT}`));