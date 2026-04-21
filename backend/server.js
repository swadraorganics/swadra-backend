const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
let puppeteer = null;
let admin = undefined;

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_BASE_URL = String(
  process.env.PUBLIC_BASE_URL ||
  process.env.RAILWAY_STATIC_URL ||
  process.env.RAILWAY_PUBLIC_DOMAIN ||
  ""
).trim().replace(/\/+$/, "");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "db.json");
const USE_FIRESTORE = String(process.env.USE_FIRESTORE || "").toLowerCase() === "true";
const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION || "appData";
const FIRESTORE_DOCUMENT = process.env.FIRESTORE_DOCUMENT || "swadra";
const FIRESTORE_LISTS = ["products", "orders", "paymentAttempts", "logs"];
const ENABLE_STARTUP_DB_LOG = String(process.env.ENABLE_STARTUP_DB_LOG || "").toLowerCase() === "true";
let firestoreDb = null;
let fileStorageAvailable = !USE_FIRESTORE;
let memoryDb = null;

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error);
});

app.use(cors());
app.use(express.json({ limit: "80mb" }));
app.use(express.urlencoded({ extended: true, limit: "80mb" }));
app.get("/favicon.ico", (req, res) => {
  res.type("image/svg+xml").send(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#7a3d3d"/><text x="16" y="21" text-anchor="middle" font-size="16" font-family="Arial" fill="#fff">S</text></svg>`
  );
});
app.use(express.static(__dirname));

function getDefaultDB() {
  return {
    products: [],
    coupons: [],
    orders: [],
    paymentAttempts: [],
    logs: [],
    appState: {},
    admin: {
      username: "admin",
      password: "1234"
    },
    meta: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  };
}

function cloneDB(data) {
  return JSON.parse(JSON.stringify(normalizeDB(data || getDefaultDB())));
}

function normalizeDB(data) {
  const db = data && typeof data === "object" ? data : getDefaultDB();
  db.products = Array.isArray(db.products) ? db.products : [];
  db.coupons = Array.isArray(db.coupons) ? db.coupons : [];
  db.orders = Array.isArray(db.orders) ? db.orders : [];
  db.paymentAttempts = Array.isArray(db.paymentAttempts) ? db.paymentAttempts : [];
  db.logs = Array.isArray(db.logs) ? db.logs : [];
  db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};
  db.admin = db.admin && typeof db.admin === "object" ? db.admin : {};
  db.admin.username = String(db.admin.username || "admin").trim() || "admin";
  db.admin.password = String(db.admin.password || "1234");
  db.meta = db.meta && typeof db.meta === "object" ? db.meta : {};
  return db;
}

function normalizeCoupon(input = {}) {
  const code = String(input.code || "").trim().toUpperCase();
  return {
    id: String(input.id || "coupon_" + Date.now() + "_" + Math.floor(Math.random() * 1000)),
    code,
    discount: Math.max(0, Math.round(toNumber(input.discount))),
    minimumAmount: Math.max(0, Math.round(toNumber(input.minimumAmount || input.minAmount))),
    status: String(input.status || "active").toLowerCase() === "inactive" ? "inactive" : "active",
    updatedAt: new Date().toISOString()
  };
}

function getFirestore() {
  if (!USE_FIRESTORE) return null;
  if (admin === undefined) {
    try {
      admin = require("firebase-admin");
    } catch (error) {
      admin = null;
    }
  }
  if (!admin) {
    throw new Error("firebase-admin package is required when USE_FIRESTORE=true");
  }
  if (!admin.apps.length) {
    admin.initializeApp();
  }
  if (!firestoreDb) {
    firestoreDb = admin.firestore();
  }
  return firestoreDb;
}

async function ensureFirestoreDB() {
  const firestore = getFirestore();
  if (!firestore) return;
  const ref = firestore.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT);
  const snap = await ref.get();
  if (!snap.exists) {
    const initial = getDefaultDB();
    await ref.set({ meta: initial.meta }, { merge: true });
  }
}

function safeDocId(value) {
  const text = String(value || "").trim();
  if (text && !text.includes("/") && text.length <= 120) return text;
  return crypto.createHash("sha1").update(text || Date.now() + Math.random().toString()).digest("hex");
}

async function readFirestoreCollection(rootRef, name) {
  const snap = await rootRef.collection(name).get();
  return snap.docs.map((doc) => {
    const data = doc.data() || {};
    return { ...data, id: data.id || doc.id };
  });
}

async function replaceFirestoreCollection(rootRef, name, items) {
  const existingSnap = await rootRef.collection(name).get();
  const wanted = new Map();
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    const id = safeDocId(item.id || item.orderId || item.attemptId || `${name}_${index}`);
    wanted.set(id, { ...item, id: item.id || id });
  });

  let batch = getFirestore().batch();
  let count = 0;
  const commitIfNeeded = async (force = false) => {
    if (count >= 400 || (force && count > 0)) {
      await batch.commit();
      batch = getFirestore().batch();
      count = 0;
    }
  };

  existingSnap.docs.forEach((doc) => {
    if (!wanted.has(doc.id)) {
      batch.delete(doc.ref);
      count += 1;
    }
  });

  for (const [id, item] of wanted.entries()) {
    batch.set(rootRef.collection(name).doc(id), item, { merge: false });
    count += 1;
    await commitIfNeeded(false);
  }

  await commitIfNeeded(true);
}

function ensureDB() {
  if (USE_FIRESTORE) return;
  if (!fileStorageAvailable) return;
  try {
    if (!fs.existsSync(DB_PATH)) {
      const initialData = getDefaultDB();
      fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2), "utf8");
    }
  } catch (error) {
    fileStorageAvailable = false;
    memoryDb = cloneDB(memoryDb);
    console.error("[db fallback] file storage unavailable:", error.message);
  }
}

async function readDB() {
  if (USE_FIRESTORE) {
    await ensureFirestoreDB();
    const firestore = getFirestore();
    const rootRef = firestore.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT);
    const rootSnap = await rootRef.get();
    const data = rootSnap.exists ? rootSnap.data() || {} : {};
    for (const name of FIRESTORE_LISTS) {
      data[name] = await readFirestoreCollection(rootRef, name);
    }
    return normalizeDB(data);
  }
  ensureDB();
  if (!fileStorageAvailable) {
    memoryDb = cloneDB(memoryDb);
    return cloneDB(memoryDb);
  }
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = normalizeDB(JSON.parse(raw || '{"products":[],"logs":[],"meta":{}}'));
    memoryDb = cloneDB(parsed);
    return parsed;
  } catch (error) {
    fileStorageAvailable = false;
    memoryDb = cloneDB(memoryDb);
    console.error("[db fallback] read failed:", error.message);
    return cloneDB(memoryDb);
  }
}

async function writeDB(data) {
  data.meta = data.meta || {};
  data.meta.updatedAt = new Date().toISOString();
  const normalized = normalizeDB(data);
  if (USE_FIRESTORE) {
    const firestore = getFirestore();
    const rootRef = firestore.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT);
    await rootRef.set({
      meta: normalized.meta,
      admin: normalized.admin,
      coupons: normalized.coupons,
      appState: normalized.appState
    }, { merge: true });
    for (const name of FIRESTORE_LISTS) {
      await replaceFirestoreCollection(rootRef, name, normalized[name]);
    }
    return;
  }
  memoryDb = cloneDB(normalized);
  if (!fileStorageAvailable) return;
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(normalized, null, 2), "utf8");
  } catch (error) {
    fileStorageAvailable = false;
    console.error("[db fallback] write failed:", error.message);
  }
}

async function addLog(message, level = "info") {
  try {
    const db = await readDB();
    db.logs.unshift({
      id: "log_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
      time: new Date().toISOString(),
      level,
      message
    });
    db.logs = db.logs.slice(0, 500);
    await writeDB(db);
  } catch (error) {
    console.error("[log failed]", level, message, error.message);
  }
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizeAppStateValue(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value) || typeof value === "object") {
    return value;
  }
  return String(value);
}

function pickAppState(db, keys = []) {
  const source = db.appState && typeof db.appState === "object" ? db.appState : {};
  const result = {};
  (Array.isArray(keys) ? keys : []).forEach((key) => {
    if (typeof key === "string" && key in source) {
      result[key] = source[key];
    }
  });
  return result;
}

function makePaymentOrderId() {
  return "pay_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex");
}

function hashPayload(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload || {}))
    .digest("hex");
}

function verifyRazorpaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  const secret = process.env.RAZORPAY_KEY_SECRET || "";
  if (!secret) {
    return {
      verified: false,
      configured: false,
      message: "RAZORPAY_KEY_SECRET is not configured"
    };
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  return {
    verified: expected === razorpay_signature,
    configured: true,
    message: expected === razorpay_signature ? "Payment verified" : "Invalid Razorpay signature"
  };
}

function readShiprocketEnv() {
  const envPath = path.join(__dirname, "shiprocket.env");
  const config = {};

  if (!fs.existsSync(envPath)) {
    return config;
  }

  const raw = fs.readFileSync(envPath, "utf8").trim();
  if (!raw) {
    return config;
  }

  raw.split(/\r?\n/).forEach((line) => {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) return;
    const eqIndex = clean.indexOf("=");
    if (eqIndex > -1) {
      const key = clean.slice(0, eqIndex).trim();
      const value = clean.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, "");
      if (key) config[key] = value;
    }
  });

  if (Object.keys(config).length === 0) {
    config.SHIPROCKET_TOKEN = raw;
  }

  return config;
}

function getShiprocketConfig() {
  const fileConfig = readShiprocketEnv();
  return {
    ...fileConfig,
    SHIPROCKET_EMAIL: process.env.SHIPROCKET_EMAIL || fileConfig.SHIPROCKET_EMAIL || "",
    SHIPROCKET_PASSWORD: process.env.SHIPROCKET_PASSWORD || fileConfig.SHIPROCKET_PASSWORD || "",
    SHIPROCKET_TOKEN: process.env.SHIPROCKET_TOKEN || fileConfig.SHIPROCKET_TOKEN || "",
    SHIPROCKET_WEBHOOK_TOKEN: process.env.SHIPROCKET_WEBHOOK_TOKEN || fileConfig.SHIPROCKET_WEBHOOK_TOKEN || "",
    SHIPROCKET_PICKUP_LOCATION: process.env.SHIPROCKET_PICKUP_LOCATION || fileConfig.SHIPROCKET_PICKUP_LOCATION || "Primary",
    SHIPROCKET_CHANNEL_ID: process.env.SHIPROCKET_CHANNEL_ID || fileConfig.SHIPROCKET_CHANNEL_ID || "",
    SHIPROCKET_DEFAULT_WEIGHT: process.env.SHIPROCKET_DEFAULT_WEIGHT || fileConfig.SHIPROCKET_DEFAULT_WEIGHT || "0.5",
    SHIPROCKET_DEFAULT_LENGTH: process.env.SHIPROCKET_DEFAULT_LENGTH || fileConfig.SHIPROCKET_DEFAULT_LENGTH || "10",
    SHIPROCKET_DEFAULT_BREADTH: process.env.SHIPROCKET_DEFAULT_BREADTH || fileConfig.SHIPROCKET_DEFAULT_BREADTH || "10",
    SHIPROCKET_DEFAULT_HEIGHT: process.env.SHIPROCKET_DEFAULT_HEIGHT || fileConfig.SHIPROCKET_DEFAULT_HEIGHT || "10"
  };
}

function shiprocketRequest({ method = "GET", path: requestPath, token = "", body = null }) {
  const payload = body ? JSON.stringify(body) : "";

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "apiv2.shiprocket.in",
        path: requestPath,
        method,
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { "Authorization": "Bearer " + token } : {})
        }
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          let parsed = data;
          try {
            parsed = JSON.parse(data || "{}");
          } catch (error) {}
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            statusCode: response.statusCode,
            data: parsed
          });
        });
      }
    );

    req.on("error", (error) => {
      resolve({
        ok: false,
        statusCode: 0,
        data: { message: error.message }
      });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

async function getShiprocketToken() {
  const config = getShiprocketConfig();
  if (config.SHIPROCKET_TOKEN) {
    return {
      ok: true,
      token: config.SHIPROCKET_TOKEN,
      mode: "token"
    };
  }

  if (!config.SHIPROCKET_EMAIL || !config.SHIPROCKET_PASSWORD) {
    return {
      ok: false,
      token: "",
      mode: "missing",
      message: "Shiprocket credentials are not configured. Add SHIPROCKET_TOKEN or SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD in backend/shiprocket.env."
    };
  }

  const auth = await shiprocketRequest({
    method: "POST",
    path: "/v1/external/auth/login",
    body: {
      email: config.SHIPROCKET_EMAIL,
      password: config.SHIPROCKET_PASSWORD
    }
  });

  const token = auth.data?.token || "";
  return {
    ok: Boolean(auth.ok && token),
    token,
    mode: "login",
    message: auth.data?.message || ""
  };
}

function normalizeOrderForDb(input = {}) {
  const now = new Date().toISOString();
  const id = String(input.id || input.orderId || makePaymentOrderId());
  const existingHistory = Array.isArray(input.statusHistory) ? input.statusHistory : [];
  return {
    ...input,
    id,
    userId: String(input.userId || input.user || input.email || ""),
    items: Array.isArray(input.items) ? input.items : [],
    total: toNumber(input.total),
    status: input.status || "Confirmed",
    payment: input.payment || "Paid Successfully",
    shipping: input.shipping || input.checkoutData || {},
    statusHistory: existingHistory.length
      ? existingHistory
      : [{ status: input.status || "Confirmed", time: now, note: "Order confirmed." }],
    createdAt: input.createdAt || now,
    updatedAt: now
  };
}

function findOrderIndex(db, matcher) {
  return db.orders.findIndex((order) => matcher(order));
}

async function updateOrderInDb(orderId, patch = {}) {
  const db = await readDB();
  const index = findOrderIndex(db, (order) => String(order.id) === String(orderId));
  if (index < 0) return null;
  db.orders[index] = {
    ...db.orders[index],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await writeDB(db);
  return db.orders[index];
}

function getAddressParts(shipping = {}) {
  const fullAddress = String(shipping.address || [shipping.house, shipping.area, shipping.postoffice, shipping.city, shipping.district, shipping.state, shipping.pincode].filter(Boolean).join(", "));
  return {
    name: shipping.name || "Swadra Customer",
    phone: shipping.phone || shipping.mobile || "9999999999",
    address: fullAddress || "Address not available",
    city: shipping.city || shipping.district || "Delhi",
    state: shipping.state || "Delhi",
    pincode: String(shipping.pincode || shipping.pin || "110001"),
    country: shipping.country || "India"
  };
}

function buildShiprocketOrderPayload(order) {
  const config = getShiprocketConfig();
  const shipping = getAddressParts(order.shipping || {});
  const orderItems = (order.items || []).map((item, index) => ({
    name: String(item.name || item.productName || `Item ${index + 1}`).slice(0, 190),
    sku: String(item.sku || item.id || item.productId || `SKU-${index + 1}`),
    units: Math.max(1, Math.round(toNumber(item.qty || 1))),
    selling_price: Math.max(1, Math.round(toNumber(item.discountedUnitPrice || item.displayPrice || item.price || 1)))
  }));

  return {
    order_id: String(order.id),
    order_date: new Date(order.createdAt || Date.now()).toISOString().slice(0, 19).replace("T", " "),
    pickup_location: config.SHIPROCKET_PICKUP_LOCATION,
    channel_id: config.SHIPROCKET_CHANNEL_ID || undefined,
    billing_customer_name: shipping.name,
    billing_last_name: "",
    billing_address: shipping.address,
    billing_city: shipping.city,
    billing_pincode: shipping.pincode,
    billing_state: shipping.state,
    billing_country: shipping.country,
    billing_email: order.userId && order.userId.includes("@") ? order.userId : "customer@swadra.local",
    billing_phone: shipping.phone,
    shipping_is_billing: true,
    order_items: orderItems.length ? orderItems : [{ name: "Swadra Product", sku: "SWADRA", units: 1, selling_price: Math.max(1, Math.round(order.total || 1)) }],
    payment_method: String(order.payment || "").toLowerCase().includes("cod") ? "COD" : "Prepaid",
    shipping_charges: toNumber(order.delivery || order.shippingFee || 0),
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: toNumber(order.couponDiscount || order.discount || 0),
    sub_total: Math.max(1, Math.round(toNumber(order.total || 1))),
    length: toNumber(config.SHIPROCKET_DEFAULT_LENGTH) || 10,
    breadth: toNumber(config.SHIPROCKET_DEFAULT_BREADTH) || 10,
    height: toNumber(config.SHIPROCKET_DEFAULT_HEIGHT) || 10,
    weight: toNumber(config.SHIPROCKET_DEFAULT_WEIGHT) || 0.5
  };
}

function extractShiprocketShipment(orderResponse, awbResponse) {
  const orderData = orderResponse?.data || {};
  const awbData = awbResponse?.data || {};
  const responseData = awbData.response?.data || awbData.data || awbData;
  return {
    shiprocketOrderId: orderData.order_id || orderData.data?.order_id || orderData.shipment_id || "",
    shipment_id: responseData.shipment_id || orderData.shipment_id || orderData.data?.shipment_id || "",
    awb: responseData.awb_code || responseData.awb || responseData.awb_number || "",
    courier_name: responseData.courier_name || responseData.courier_company_id || "",
    tracking_url: responseData.tracking_url || responseData.track_url || "",
    trackingStatus: responseData.status || responseData.current_status || "Shipment Created",
    estimatedDelivery: responseData.etd || responseData.estimated_delivery_date || responseData.edd || ""
  };
}

async function createShiprocketShipmentForOrder(order) {
  const auth = await getShiprocketToken();
  if (!auth.ok) {
    return {
      ok: false,
      error: auth.message || "Shiprocket credentials are not configured"
    };
  }

  const createPayload = buildShiprocketOrderPayload(order);
  const created = await shiprocketRequest({
    method: "POST",
    path: "/v1/external/orders/create/adhoc",
    token: auth.token,
    body: createPayload
  });

  if (!created.ok) {
    return {
      ok: false,
      step: "create-order",
      error: created.data?.message || created.data?.error || "Shiprocket order creation failed",
      raw: created.data
    };
  }

  const shipmentId = created.data?.shipment_id || created.data?.data?.shipment_id || created.data?.order_id || "";
  let assigned = { ok: false, data: {} };
  if (shipmentId) {
    assigned = await shiprocketRequest({
      method: "POST",
      path: "/v1/external/courier/assign/awb",
      token: auth.token,
      body: {
        shipment_id: shipmentId
      }
    });
  }

  const shipment = extractShiprocketShipment(created, assigned);
  return {
    ok: true,
    createPayload,
    created: created.data,
    assigned: assigned.data,
    shipment
  };
}

function extractWebhookFields(payload = {}) {
  const data = payload.data || payload;
  const awb = data.awb || data.awb_code || data.awb_number || data.awbNo || data.awbno || "";
  const orderId = data.order_id || data.orderId || data.order || data.seller_order_id || data.reference_order_id || "";
  const status = data.current_status || data.shipment_status || data.status || data.status_code || data.activity || "";
  return {
    data,
    awb: String(awb || ""),
    orderId: String(orderId || ""),
    status: String(status || "Tracking Updated"),
    courier_name: data.courier_name || data.courier || data.courier_company_name || "",
    tracking_url: data.tracking_url || data.track_url || "",
    estimatedDelivery: data.edd || data.etd || data.expected_delivery_date || "",
    eventTime: data.event_time || data.scan_time || data.updated_at || new Date().toISOString(),
    location: data.location || data.current_location || "",
    note: data.remark || data.remarks || data.description || ""
  };
}

function createRazorpayOrder({ amount, currency, receipt, notes }) {
  const keyId = process.env.RAZORPAY_KEY_ID || "";
  const secret = process.env.RAZORPAY_KEY_SECRET || "";

  if (!keyId || !secret) {
    return Promise.resolve({
      ok: false,
      configured: false,
      order: null,
      message: "Razorpay backend credentials are not configured"
    });
  }

  const payload = JSON.stringify({
    amount,
    currency,
    receipt,
    notes: notes || {}
  });

  return new Promise((resolve) => {
    const request = https.request(
      {
        hostname: "api.razorpay.com",
        path: "/v1/orders",
        method: "POST",
        auth: `${keyId}:${secret}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 15000
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          let parsed = {};
          try {
            parsed = JSON.parse(body || "{}");
          } catch (error) {
            parsed = { raw: body };
          }

          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            configured: true,
            order: parsed,
            message: parsed.error?.description || parsed.error?.reason || "Razorpay order response"
          });
        });
      }
    );

    request.on("error", (error) => {
      resolve({
        ok: false,
        configured: true,
        order: null,
        message: error.message
      });
    });

    request.on("timeout", () => {
      request.destroy();
      resolve({
        ok: false,
        configured: true,
        order: null,
        message: "Razorpay order request timed out"
      });
    });

    request.write(payload);
    request.end();
  });
}

function normalizeSearchText(value) {
  return encodeURIComponent(
    String(value || "")
      .replace(/[^\w\s&,-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function buildCompetitorUrls(product, searchMode = "product_name_size") {
  const name = String(product.name || product.productName || "").trim();
  const size = String(product.size || product.productSize || "").trim();

  const queryText =
    searchMode === "product_name" || !size
      ? name
      : `${name} ${size}`.trim();

  const query = normalizeSearchText(queryText);

  return {
    amazonUrl: product.amazonUrl || `https://www.amazon.in/s?k=${query}`,
    flipkartUrl: product.flipkartUrl || `https://www.flipkart.com/search?q=${query}`,
    otherUrl: product.otherUrl || `https://www.google.com/search?q=${query}+price`
  };
}

function uniqueNumbers(arr) {
  return [...new Set(arr.filter(n => Number.isFinite(n) && n > 0))];
}

function chooseBestPrice(candidates, reference = 0) {
  const valid = uniqueNumbers(candidates).filter(n => n >= 20 && n <= 200000);
  if (!valid.length) return 0;

  if (reference > 0) {
    const nearby = valid
      .filter(v => v >= Math.max(20, reference * 0.25) && v <= reference * 2.5)
      .sort((a, b) => Math.abs(a - reference) - Math.abs(b - reference));

    if (nearby.length) return nearby[0];
  }

  return [...valid].sort((a, b) => a - b)[0];
}

function parseCurrencyCandidates(text) {
  const input = String(text || "");
  const values = [];
  const patterns = [
    /â‚¹\s*([0-9][0-9,]{1,8}(?:\.\d{1,2})?)/g,
    /Rs\.?\s*([0-9][0-9,]{1,8}(?:\.\d{1,2})?)/gi,
    /INR\s*([0-9][0-9,]{1,8}(?:\.\d{1,2})?)/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(input)) !== null) {
      const value = Number(String(match[1]).replace(/,/g, ""));
      if (Number.isFinite(value)) values.push(Math.round(value));
    }
  }

  return uniqueNumbers(values);
}

async function createBrowser() {
  if (!puppeteer) {
    puppeteer = require("puppeteer");
  }
  return puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ]
  });
}

async function preparePage(page) {
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "accept-language": "en-IN,en;q=0.9"
  });
  await page.setViewport({ width: 1440, height: 1200 });
}

async function safeGoto(page, url, timeout = 30000) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await new Promise(resolve => setTimeout(resolve, 1800));
}

async function scrapeAmazon(page, product) {
  const selectors = [
    "#priceblock_ourprice",
    "#priceblock_dealprice",
    "#priceblock_saleprice",
    ".a-price .a-offscreen",
    ".a-price-whole"
  ];

  for (const selector of selectors) {
    const text = await page.$eval(selector, el => el.textContent || "", { timeout: 1000 }).catch(() => "");
    const candidates = parseCurrencyCandidates(text);
    const chosen = chooseBestPrice(candidates, toNumber(product?.sellingPrice || product?.price || product?.mrp || 0));
    if (chosen > 0) {
      return { price: chosen, status: "Fetched from Amazon page" };
    }
  }

  const bodyText = await page.evaluate(() => document.body?.innerText || "");
  const chosen = chooseBestPrice(
    parseCurrencyCandidates(bodyText),
    toNumber(product?.sellingPrice || product?.price || product?.mrp || 0)
  );

  return {
    price: chosen,
    status: chosen > 0 ? "Fetched from Amazon text" : "Price not detected"
  };
}

async function scrapeFlipkart(page, product) {
  const selectors = [
    ".Nx9bqj",
    "._30jeq3",
    ".CEmiEU"
  ];

  for (const selector of selectors) {
    const text = await page.$eval(selector, el => el.textContent || "", { timeout: 1000 }).catch(() => "");
    const candidates = parseCurrencyCandidates(text);
    const chosen = chooseBestPrice(candidates, toNumber(product?.sellingPrice || product?.price || product?.mrp || 0));
    if (chosen > 0) {
      return { price: chosen, status: "Fetched from Flipkart page" };
    }
  }

  const bodyText = await page.evaluate(() => document.body?.innerText || "");
  const chosen = chooseBestPrice(
    parseCurrencyCandidates(bodyText),
    toNumber(product?.sellingPrice || product?.price || product?.mrp || 0)
  );

  return {
    price: chosen,
    status: chosen > 0 ? "Fetched from Flipkart text" : "Price not detected"
  };
}

async function scrapeGoogle(page, product) {
  const bodyText = await page.evaluate(() => document.body?.innerText || "");
  const chosen = chooseBestPrice(
    parseCurrencyCandidates(bodyText),
    toNumber(product?.sellingPrice || product?.price || product?.mrp || 0)
  );

  return {
    price: chosen,
    status: chosen > 0 ? "Fetched from Google text" : "Price not detected"
  };
}

async function fetchCompetitorPrice(browser, url, product = null) {
  const cleanUrl = String(url || "").trim();
  if (!/^https?:\/\//i.test(cleanUrl)) {
    return { url: cleanUrl, price: 0, status: "Invalid URL" };
  }

  const page = await browser.newPage();

  try {
    await preparePage(page);
    await safeGoto(page, cleanUrl);

    const lowerUrl = cleanUrl.toLowerCase();
    let result;

    if (lowerUrl.includes("amazon")) {
      result = await scrapeAmazon(page, product);
    } else if (lowerUrl.includes("flipkart")) {
      result = await scrapeFlipkart(page, product);
    } else {
      result = await scrapeGoogle(page, product);
    }

    return {
      url: cleanUrl,
      price: result.price || 0,
      status: result.status || "Unknown"
    };
  } catch (error) {
    return {
      url: cleanUrl,
      price: 0,
      status: `Fetch failed: ${error.message}`
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function syncCompetitorPricesForProduct(product, options = {}, browser) {
  const searchMode = options.searchMode || "product_name_size";
  const searchTarget = options.searchTarget || "all";
  const urls = buildCompetitorUrls(product, searchMode);

  const shouldFetchAmazon =
    searchTarget === "all" ||
    searchTarget === "amazon_flipkart" ||
    searchTarget === "amazon_only";

  const shouldFetchFlipkart =
    searchTarget === "all" ||
    searchTarget === "amazon_flipkart" ||
    searchTarget === "flipkart_only";

  const shouldFetchOther =
    searchTarget === "all" ||
    searchTarget === "google_only";

  const [amazon, flipkart, other] = await Promise.all([
    shouldFetchAmazon
      ? fetchCompetitorPrice(browser, urls.amazonUrl, product)
      : Promise.resolve({ url: urls.amazonUrl, price: 0, status: "Skipped" }),
    shouldFetchFlipkart
      ? fetchCompetitorPrice(browser, urls.flipkartUrl, product)
      : Promise.resolve({ url: urls.flipkartUrl, price: 0, status: "Skipped" }),
    shouldFetchOther
      ? fetchCompetitorPrice(browser, urls.otherUrl, product)
      : Promise.resolve({ url: urls.otherUrl, price: 0, status: "Skipped" })
  ]);

  return {
    product: normalizeProduct(
      {
        ...product,
        amazonUrl: urls.amazonUrl,
        flipkartUrl: urls.flipkartUrl,
        otherUrl: urls.otherUrl,
        amazonPrice: amazon.price || product.amazonPrice || 0,
        flipkartPrice: flipkart.price || product.flipkartPrice || 0,
        otherPrice: other.price || product.otherPrice || 0,
        amazonStatus: amazon.status,
        flipkartStatus: flipkart.status,
        otherStatus: other.status
      },
      product
    ),
    statuses: {
      amazon: amazon.status,
      flipkart: flipkart.status,
      other: other.status
    }
  };
}

function getLowestCompetitor(product) {
  const prices = [
    toNumber(product.amazonPrice),
    toNumber(product.flipkartPrice),
    toNumber(product.otherPrice)
  ].filter((p) => p > 0);

  return prices.length ? Math.min(...prices) : 0;
}

function calculateAIPrice(product) {
  const rawCost = toNumber(product.rawCost);
  const shippingCost = toNumber(product.shippingCost);
  const packagingCost = toNumber(product.packagingCost);
  const extraCost = toNumber(product.extraCost);
  const minProfit = toNumber(product.minProfit);
  const undercutBy = toNumber(product.undercutBy || 1);
  const mrp = toNumber(product.mrp);
  const offlinePrice = toNumber(product.offlinePrice);

  const totalCost = rawCost + shippingCost + packagingCost + extraCost;
  const floorPrice = totalCost + minProfit;
  const lowestCompetitor = getLowestCompetitor(product);

  let finalSellingPrice = floorPrice;
  let aiStatus = "No competitor price found, floor used";

  if (lowestCompetitor > 0) {
    const targetPrice = lowestCompetitor - undercutBy;

    if (targetPrice >= floorPrice) {
      finalSellingPrice = targetPrice;
      aiStatus = "Competitor beaten safely";
    } else {
      finalSellingPrice = floorPrice;
      aiStatus = "Competitor too low, floor protected";
    }
  } else if (offlinePrice > 0) {
    finalSellingPrice = offlinePrice;
    aiStatus = "No competitor price found, offline price used";
  }

  if (mrp > 0 && finalSellingPrice > mrp) {
    finalSellingPrice = mrp;
    aiStatus = "Capped by fixed MRP";
  }

  return {
    totalCost: Math.round(totalCost),
    floorPrice: Math.round(floorPrice),
    lowestCompetitor: Math.round(lowestCompetitor),
    sellingPrice: Math.round(finalSellingPrice),
    aiStatus
  };
}

function normalizeProduct(input, existingProduct = null) {
  const base = existingProduct || {};

  const name = String(
    input.name ?? input.productName ?? base.name ?? base.productName ?? ""
  ).trim();

  const size = String(
    input.size ?? input.productSize ?? base.size ?? base.productSize ?? ""
  ).trim();

  const category = String(input.category ?? base.category ?? "").trim();
  const availability =
    String(input.availability ?? base.availability ?? "Available").trim() || "Available";
  const images = Array.isArray(input.images)
    ? input.images.filter(Boolean).slice(0, 4)
    : Array.isArray(base.images)
      ? base.images.filter(Boolean).slice(0, 4)
      : (input.image || base.image ? [input.image || base.image].filter(Boolean) : []);

  const stockQty = toNumber(input.stockQty ?? base.stockQty);
  const isBestseller = Boolean(input.isBestseller ?? base.isBestseller ?? false);
  const isSpecialProduct = Boolean(input.isSpecialProduct ?? base.isSpecialProduct ?? false);

  const mrpLocked = Boolean(base.mrpLocked || input.mrpLocked || false);
  const mrpValue = toNumber(
    mrpLocked ? (base.mrp ?? input.mrp) : (input.mrp ?? base.mrp)
  );

  const product = {
    id: input.id || base.id || "p_" + Date.now(),
    name,
    productName: name,
    size,
    productSize: size,
    category,
    isBestseller,
    isSpecialProduct,
    availability,
    stockQty,
    image: images[0] || input.image || base.image || "",
    images,
    outOfStock: Boolean(
      input.outOfStock ??
        base.outOfStock ??
        (availability === "Out of Stock" || stockQty <= 0)
    ),

    rawCost: toNumber(input.rawCost ?? base.rawCost),
    shippingCost: toNumber(input.shippingCost ?? base.shippingCost),
    packagingCost: toNumber(input.packagingCost ?? base.packagingCost),
    extraCost: toNumber(input.extraCost ?? base.extraCost),
    minProfit: toNumber(input.minProfit ?? base.minProfit),
    undercutBy: toNumber(
      input.undercutBy !== undefined ? input.undercutBy : (base.undercutBy || 1)
    ),

    amazonPrice: toNumber(input.amazonPrice ?? base.amazonPrice),
    flipkartPrice: toNumber(input.flipkartPrice ?? base.flipkartPrice),
    otherPrice: toNumber(input.otherPrice ?? base.otherPrice),
    offlinePrice: toNumber(input.offlinePrice ?? base.offlinePrice),
    amazonUrl: String(input.amazonUrl ?? base.amazonUrl ?? "").trim(),
    flipkartUrl: String(input.flipkartUrl ?? base.flipkartUrl ?? "").trim(),
    otherUrl: String(input.otherUrl ?? base.otherUrl ?? "").trim(),
    amazonStatus: String(input.amazonStatus ?? base.amazonStatus ?? ""),
    flipkartStatus: String(input.flipkartStatus ?? base.flipkartStatus ?? ""),
    otherStatus: String(input.otherStatus ?? base.otherStatus ?? ""),

    mrpLocked,
    mrp: mrpValue,

    createdAt: base.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (!product.mrpLocked && product.mrp > 0) {
    product.mrpLocked = true;
  }

  const calc = calculateAIPrice(product);

  product.totalCost = calc.totalCost;
  product.floorPrice = calc.floorPrice;
  product.lowestCompetitor = calc.lowestCompetitor;
  product.sellingPrice = calc.sellingPrice;
  product.price = calc.sellingPrice;
  product.aiStatus = calc.aiStatus;

  return product;
}

app.get("/health", async (req, res) => {
  res.status(200).type("application/json").send(JSON.stringify({
    ok: true,
    status: "online",
    time: new Date().toISOString()
  }));
});

app.get("/api/products", async (req, res) => {
  try {
    const db = await readDB();
    res.json({
      ok: true,
      count: db.products.length,
      products: db.products
    });
  } catch (error) {
    addLog("Failed to load products: " + error.message, "error");
    res.status(500).json({
      ok: false,
      error: "Failed to load products"
    });
  }
});

app.get("/api/logs", async (req, res) => {
  try {
    const db = await readDB();
    res.json({
      ok: true,
      logs: db.logs || []
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Failed to load logs"
    });
  }
});

app.get("/api/admin/config", async (req, res) => {
  try {
    const db = await readDB();
    res.json({
      ok: true,
      username: db.admin.username
    });
  } catch (error) {
    addLog("Failed to load admin config: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to load admin config" });
  }
});

app.post("/api/admin/login", async (req, res) => {
  try {
    const db = await readDB();
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const success = username === db.admin.username && password === db.admin.password;
    addLog(`Admin login ${success ? "success" : "failed"} for ${username || "unknown"}`, success ? "success" : "warn");
    res.status(success ? 200 : 401).json({
      ok: success,
      success,
      message: success ? "Login successful" : "Wrong credentials"
    });
  } catch (error) {
    addLog("Admin login failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to login" });
  }
});

app.post("/api/admin/credentials", async (req, res) => {
  try {
    const db = await readDB();
    const username = String(req.body?.username || db.admin.username).trim();
    const password = String(req.body?.password || db.admin.password);
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: "Username and password are required" });
    }
    db.admin = { username, password };
    await writeDB(db);
    addLog("Admin credentials updated", "success");
    res.json({ ok: true, username });
  } catch (error) {
    addLog("Admin credentials update failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to update credentials" });
  }
});

app.get("/api/coupons", async (req, res) => {
  try {
    const db = await readDB();
    const coupons = db.coupons.map((coupon) => normalizeCoupon(coupon)).slice(0, 50);
    res.json({
      ok: true,
      coupons,
      primaryCoupon: coupons.find((coupon) => coupon.status === "active") || null
    });
  } catch (error) {
    addLog("Failed to load coupons: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to load coupons" });
  }
});

app.get("/api/app-state", async (req, res) => {
  try {
    const db = await readDB();
    const rawKeys = String(req.query.keys || "").trim();
    const keys = rawKeys
      ? rawKeys.split(",").map((item) => item.trim()).filter(Boolean)
      : Object.keys(db.appState || {});
    res.json({
      ok: true,
      state: pickAppState(db, keys),
      updatedAt: db.meta?.updatedAt || null
    });
  } catch (error) {
    addLog("App state fetch failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to fetch app state" });
  }
});

app.get("/api/app-state/bootstrap", async (req, res) => {
  try {
    const db = await readDB();
    const keys = [
      "users",
      "homeContent",
      "adminProducts",
      "adminProductsByCategory",
      "swadraBackendProductsCache",
      "adminProductsUpdatedAt",
      "adminCustomersUpdatedAt",
      "heroVideoUpdatedAt",
      "adminCoupons",
      "adminCoupon",
      "ORDER_STATUS_OVERRIDE_KEY",
      "PAYMENT_REVIEW_KEY",
      "CUSTOMER_PAUSE_KEY",
      "DELETED_CUSTOMERS_KEY"
    ];
    res.json({
      ok: true,
      state: pickAppState(db, keys),
      updatedAt: db.meta?.updatedAt || null
    });
  } catch (error) {
    addLog("App state bootstrap failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to bootstrap app state" });
  }
});

app.post("/api/app-state", async (req, res) => {
  try {
    const db = await readDB();
    const state = req.body && typeof req.body.state === "object" ? req.body.state : {};
    const removeKeys = Array.isArray(req.body?.removeKeys) ? req.body.removeKeys : [];
    db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};

    Object.keys(state).forEach((key) => {
      if (!key) return;
      db.appState[key] = normalizeAppStateValue(state[key]);
    });

    removeKeys.forEach((key) => {
      if (!key) return;
      delete db.appState[key];
    });

    await writeDB(db);
    res.json({
      ok: true,
      state: db.appState,
      updatedAt: db.meta?.updatedAt || null
    });
  } catch (error) {
    addLog("App state save failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to save app state" });
  }
});

app.post("/api/coupons", async (req, res) => {
  try {
    const coupon = normalizeCoupon(req.body || {});
    if (!coupon.code) {
      return res.status(400).json({ ok: false, error: "Coupon code is required" });
    }
    if (!coupon.discount) {
      return res.status(400).json({ ok: false, error: "Coupon discount must be greater than zero" });
    }
    const db = await readDB();
    const existingIndex = db.coupons.findIndex((item) => String(item.code || "").trim().toUpperCase() === coupon.code);
    if (existingIndex > -1) {
      db.coupons[existingIndex] = {
        ...db.coupons[existingIndex],
        ...coupon,
        id: db.coupons[existingIndex].id || coupon.id
      };
    } else {
      db.coupons.unshift(coupon);
    }
    db.coupons = db.coupons.slice(0, 50);
    await writeDB(db);
    addLog(`Coupon saved: ${coupon.code}`, "success");
    res.json({
      ok: true,
      coupons: db.coupons,
      primaryCoupon: db.coupons.find((item) => item.status === "active") || null
    });
  } catch (error) {
    addLog("Coupon save failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to save coupon" });
  }
});

app.delete("/api/coupons/:code", async (req, res) => {
  try {
    const code = String(req.params.code || "").trim().toUpperCase();
    const db = await readDB();
    db.coupons = db.coupons.filter((coupon) => String(coupon.code || "").trim().toUpperCase() !== code);
    await writeDB(db);
    addLog(`Coupon deleted: ${code}`, "warn");
    res.json({
      ok: true,
      coupons: db.coupons,
      primaryCoupon: db.coupons.find((item) => item.status === "active") || null
    });
  } catch (error) {
    addLog("Coupon delete failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to delete coupon" });
  }
});

app.post("/api/orders", async (req, res) => {
  try {
    const incoming = normalizeOrderForDb(req.body || {});
    const db = await readDB();
    const existingIndex = findOrderIndex(db, (order) => String(order.id) === String(incoming.id));
    const existing = existingIndex > -1 ? db.orders[existingIndex] : {};
    let order = normalizeOrderForDb({
      ...existing,
      ...incoming,
      statusHistory: Array.isArray(existing.statusHistory) && existing.statusHistory.length
        ? existing.statusHistory
        : incoming.statusHistory
    });

    order.shiprocket = {
      ...(existing.shiprocket || {}),
      status: existing.shiprocket?.status || "pending"
    };

    try {
      if (order.awb || order.trackingId || order.shipment_id) {
        order.shiprocket = {
          ...(order.shiprocket || {}),
          status: order.shiprocket?.status || "created",
          skippedDuplicateCreate: true
        };
      } else {
      const shipmentResult = await createShiprocketShipmentForOrder(order);
      if (shipmentResult.ok) {
        const shipment = shipmentResult.shipment || {};
        order = {
          ...order,
          shipment_id: shipment.shipment_id || order.shipment_id || "",
          shiprocketOrderId: shipment.shiprocketOrderId || order.shiprocketOrderId || "",
          awb: shipment.awb || order.awb || "",
          trackingId: shipment.awb || order.trackingId || "",
          courier_name: shipment.courier_name || order.courier_name || "",
          courierName: shipment.courier_name || order.courierName || "",
          tracking_url: shipment.tracking_url || order.tracking_url || "",
          trackingUrl: shipment.tracking_url || order.trackingUrl || "",
          trackingStatus: shipment.trackingStatus || order.trackingStatus || "Shipment Created",
          estimatedDelivery: shipment.estimatedDelivery || order.estimatedDelivery || "",
          status: shipment.awb ? "Dispatched" : order.status,
          shiprocket: {
            status: "created",
            createdAt: new Date().toISOString(),
            createResponse: shipmentResult.created,
            awbResponse: shipmentResult.assigned
          },
          statusHistory: [
            ...(order.statusHistory || []),
            {
              status: shipment.awb ? "Dispatched" : "Shipment Created",
              time: new Date().toISOString(),
              note: shipment.awb ? `AWB ${shipment.awb} assigned.` : "Shiprocket shipment created."
            }
          ]
        };
        addLog(`Shiprocket shipment created for order ${order.id} AWB ${order.awb || "pending"}`, "success");
      } else {
        order.shiprocket = {
          status: "failed",
          error: shipmentResult.error,
          step: shipmentResult.step || "",
          raw: shipmentResult.raw || null,
          failedAt: new Date().toISOString()
        };
        addLog(`Shiprocket shipment failed for order ${order.id}: ${shipmentResult.error}`, "error");
      }
      }
    } catch (shiprocketError) {
      order.shiprocket = {
        status: "failed",
        error: shiprocketError.message,
        failedAt: new Date().toISOString()
      };
      addLog(`Shiprocket shipment exception for order ${order.id}: ${shiprocketError.message}`, "error");
    }

    if (existingIndex > -1) db.orders[existingIndex] = order;
    else db.orders.unshift(order);
    db.orders = db.orders.slice(0, 5000);
    await writeDB(db);

    res.json({
      ok: true,
      order,
      shiprocket: order.shiprocket
    });
  } catch (error) {
    addLog("Order create failed: " + error.message, "error");
    res.status(500).json({
      ok: false,
      error: "Failed to save order"
    });
  }
});

app.get("/api/orders/:id", async (req, res) => {
  try {
    const db = await readDB();
    const order = db.orders.find((item) => String(item.id) === String(req.params.id));
    if (!order) {
      return res.status(404).json({ ok: false, error: "Order not found" });
    }
    res.json({ ok: true, order });
  } catch (error) {
    addLog("Order fetch failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to fetch order" });
  }
});

app.get("/api/orders/user/:userId", async (req, res) => {
  try {
    const db = await readDB();
    const userId = decodeURIComponent(req.params.userId || "");
    const orders = db.orders.filter((order) => String(order.userId || order.user || "") === String(userId));
    res.json({ ok: true, count: orders.length, orders });
  } catch (error) {
    addLog("User orders fetch failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to fetch user orders" });
  }
});

app.post("/api/payments/create-order", async (req, res) => {
  try {
    const payload = req.body || {};
    const amount = Math.round(toNumber(payload.amount));

    if (amount <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Valid payment amount is required"
      });
    }

    const db = await readDB();
    const razorpay = await createRazorpayOrder({
      amount,
      currency: payload.currency || "INR",
      receipt: payload.receipt || "swadra_" + Date.now(),
      notes: {
        local_order_id: payload.orderId || "",
        snapshot_hash: hashPayload(payload.snapshot || {}),
        source: "Swadra Website"
      }
    });

    const order = {
      id: payload.orderId || makePaymentOrderId(),
      amount,
      currency: payload.currency || "INR",
      status: razorpay.ok ? "razorpay_order_created" : "created_local",
      receipt: payload.receipt || "swadra_" + Date.now(),
      razorpayOrderId: razorpay.order?.id || "",
      razorpayConfigured: razorpay.configured,
      razorpayMessage: razorpay.message,
      snapshotHash: hashPayload(payload.snapshot || {}),
      snapshot: payload.snapshot || {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.paymentAttempts.unshift(order);
    db.paymentAttempts = db.paymentAttempts.slice(0, 1000);
    await writeDB(db);
    addLog(`Payment order created: ${order.id} amount ${amount}`, "info");

    res.json({
      ok: true,
      order,
      razorpayOrder: razorpay.ok
        ? razorpay.order
        : {
            id: order.id,
            amount,
            currency: order.currency,
            receipt: order.receipt,
            localOnly: true
          },
      verificationConfigured: Boolean(process.env.RAZORPAY_KEY_SECRET),
      razorpayConfigured: razorpay.configured,
      keyId: process.env.RAZORPAY_KEY_ID || "",
      razorpayMessage: razorpay.message
    });
  } catch (error) {
    addLog("Payment order creation failed: " + error.message, "error");
    res.status(500).json({
      ok: false,
      error: "Failed to create payment order"
    });
  }
});

app.post("/api/payments/verify", async (req, res) => {
  try {
    const payload = req.body || {};
    const verification = verifyRazorpaySignature(payload);
    const db = await readDB();
    const attemptId = payload.razorpay_order_id || payload.localOrderId || "";
    const index = db.paymentAttempts.findIndex((attempt) => String(attempt.id) === String(attemptId));

    if (index > -1) {
      db.paymentAttempts[index] = {
        ...db.paymentAttempts[index],
        status: verification.verified ? "paid" : "verification_failed",
        razorpayPaymentId: payload.razorpay_payment_id || "",
        razorpaySignature: payload.razorpay_signature || "",
        verificationConfigured: verification.configured,
        verificationMessage: verification.message,
        updatedAt: new Date().toISOString()
      };
    } else {
      db.paymentAttempts.unshift({
        id: attemptId || makePaymentOrderId(),
        status: verification.verified ? "paid" : "verification_failed",
        razorpayPaymentId: payload.razorpay_payment_id || "",
        verificationConfigured: verification.configured,
        verificationMessage: verification.message,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }

    await writeDB(db);
    addLog(`Payment verify ${verification.verified ? "passed" : "blocked"}: ${attemptId || "unknown"}`, verification.verified ? "success" : "warn");

    res.status(verification.verified ? 200 : 202).json({
      ok: verification.verified,
      ...verification
    });
  } catch (error) {
    addLog("Payment verification failed: " + error.message, "error");
    res.status(500).json({
      ok: false,
      verified: false,
      error: "Failed to verify payment"
    });
  }
});

app.post("/api/payments/attempts", async (req, res) => {
  try {
    const payload = req.body || {};
    const db = await readDB();
    const id = payload.id || payload.localOrderId || makePaymentOrderId();
    const existingIndex = db.paymentAttempts.findIndex((attempt) => String(attempt.id) === String(id));
    const attempt = {
      ...(existingIndex > -1 ? db.paymentAttempts[existingIndex] : {}),
      ...payload,
      id,
      updatedAt: new Date().toISOString(),
      createdAt: existingIndex > -1 ? db.paymentAttempts[existingIndex].createdAt : new Date().toISOString()
    };

    if (existingIndex > -1) db.paymentAttempts[existingIndex] = attempt;
    else db.paymentAttempts.unshift(attempt);

    db.paymentAttempts = db.paymentAttempts.slice(0, 1000);
    await writeDB(db);
    res.json({ ok: true, attempt });
  } catch (error) {
    addLog("Payment attempt save failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to save payment attempt" });
  }
});

app.get("/api/payments/attempts", async (req, res) => {
  try {
    const db = await readDB();
    res.json({
      ok: true,
      attempts: db.paymentAttempts || []
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: "Failed to load payment attempts" });
  }
});

app.post("/api/products", async (req, res) => {
  try {
    const input = req.body || {};

    if (!input.productName || !String(input.productName).trim()) {
      return res.status(400).json({
        ok: false,
        error: "Product name is required"
      });
    }

    if (!input.productSize || !String(input.productSize).trim()) {
      return res.status(400).json({
        ok: false,
        error: "Product size is required"
      });
    }

    const db = await readDB();
    const existingIndex = db.products.findIndex(
      (p) => String(p.id) === String(input.id)
    );

    let savedProduct;

    if (existingIndex > -1) {
      const existing = db.products[existingIndex];
      savedProduct = normalizeProduct(input, existing);
      db.products[existingIndex] = savedProduct;
      addLog(`Product updated: ${savedProduct.productName} (${savedProduct.productSize})`, "success");
    } else {
      savedProduct = normalizeProduct(input);
      db.products.unshift(savedProduct);
      addLog(`Product created: ${savedProduct.productName} (${savedProduct.productSize})`, "success");
    }

    await writeDB(db);

    res.json({
      ok: true,
      product: savedProduct
    });
  } catch (error) {
    addLog("Failed to save product: " + error.message, "error");
    res.status(500).json({
      ok: false,
      error: "Failed to save product"
    });
  }
});

app.put("/api/products/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const db = await readDB();
    const index = db.products.findIndex((p) => String(p.id) === String(id));

    if (index === -1) {
      return res.status(404).json({
        ok: false,
        error: "Product not found"
      });
    }

    const existing = db.products[index];
    const updated = normalizeProduct({ ...req.body, id }, existing);

    db.products[index] = updated;
    await writeDB(db);
    addLog(`Product updated by ID: ${updated.productName} (${updated.productSize})`, "success");

    res.json({
      ok: true,
      product: updated
    });
  } catch (error) {
    addLog("Failed to update product: " + error.message, "error");
    res.status(500).json({
      ok: false,
      error: "Failed to update product"
    });
  }
});

app.delete("/api/products/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const db = await readDB();
    const index = db.products.findIndex((p) => String(p.id) === String(id));

    if (index === -1) {
      return res.status(404).json({
        ok: false,
        error: "Product not found"
      });
    }

    const deleted = db.products[index];
    db.products.splice(index, 1);
    await writeDB(db);

    addLog(`Product deleted: ${deleted.productName} (${deleted.productSize})`, "warn");

    res.json({
      ok: true,
      deletedId: id
    });
  } catch (error) {
    addLog("Failed to delete product: " + error.message, "error");
    res.status(500).json({
      ok: false,
      error: "Failed to delete product"
    });
  }
});

app.post("/api/pricing/run", async (req, res) => {
  try {
    const db = await readDB();
    db.products = db.products.map((product) => normalizeProduct(product, product));
    await writeDB(db);
    addLog("AI pricing run completed for all products", "success");

    res.json({
      ok: true,
      count: db.products.length,
      products: db.products
    });
  } catch (error) {
    addLog("AI pricing run failed: " + error.message, "error");
    res.status(500).json({
      ok: false,
      error: "Failed to run AI pricing"
    });
  }
});

app.post("/api/products/:id/recalculate", async (req, res) => {
  try {
    const id = req.params.id;
    const db = await readDB();
    const index = db.products.findIndex((p) => String(p.id) === String(id));

    if (index === -1) {
      return res.status(404).json({
        ok: false,
        error: "Product not found"
      });
    }

    db.products[index] = normalizeProduct(db.products[index], db.products[index]);
    await writeDB(db);

    addLog(`Single product recalculated: ${db.products[index].productName}`, "success");

    res.json({
      ok: true,
      product: db.products[index]
    });
  } catch (error) {
    addLog("Single product recalculation failed: " + error.message, "error");
    res.status(500).json({
      ok: false,
      error: "Failed to recalculate product"
    });
  }
});

app.post("/api/pricing/fetch-competitor-prices", async (req, res) => {
  let browser;
  try {
    const payload = req.body || {};

    const tempProduct = normalizeProduct({
      productName: payload.productName || payload.name || "",
      productSize: payload.productSize || payload.size || "",
      amazonUrl: payload.amazonUrl || "",
      flipkartUrl: payload.flipkartUrl || "",
      otherUrl: payload.otherUrl || "",
      amazonPrice: 0,
      flipkartPrice: 0,
      otherPrice: 0
    });

    browser = await createBrowser();

    const result = await syncCompetitorPricesForProduct(tempProduct, {
      searchMode: payload.searchMode || "product_name_size",
      searchTarget: payload.searchTarget || "all"
    }, browser);

    res.json({
      ok: true,
      prices: {
        amazonPrice: result.product.amazonPrice,
        flipkartPrice: result.product.flipkartPrice,
        otherPrice: result.product.otherPrice
      },
      statuses: {
        amazon: result.product.amazonStatus,
        flipkart: result.product.flipkartStatus,
        other: result.product.otherStatus
      },
      urls: {
        amazonUrl: result.product.amazonUrl,
        flipkartUrl: result.product.flipkartUrl,
        otherUrl: result.product.otherUrl
      }
    });
  } catch (error) {
    addLog("Competitor price fetch failed: " + error.message, "error");
    res.status(500).json({
      ok: false,
      error: "Failed to fetch competitor prices"
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.post("/api/pricing/search-by-product-name", async (req, res) => {
  let browser;
  try {
    const payload = req.body || {};
    const db = await readDB();

    let productsToProcess = [];
    const incomingProducts = Array.isArray(payload.products) ? payload.products : [];

    if (incomingProducts.length) {
      productsToProcess = incomingProducts.map((product) => {
        const existing = db.products.find((p) => String(p.id) === String(product.id));
        return normalizeProduct(product, existing || null);
      });
    } else {
      productsToProcess = db.products.map((product) => normalizeProduct(product, product));
    }

    browser = await createBrowser();
    const updatedProducts = [];

    for (const product of productsToProcess) {
      const result = await syncCompetitorPricesForProduct(product, {
        searchMode: payload.searchMode || "product_name_size",
        searchTarget: payload.searchTarget || "all"
      }, browser);

      updatedProducts.push(result.product);
    }

    const updatedMap = new Map(db.products.map((p) => [String(p.id), p]));
    updatedProducts.forEach((product) => {
      updatedMap.set(String(product.id), product);
    });

    db.products = Array.from(updatedMap.values());
    await writeDB(db);

    addLog(`Product-name auto search completed for ${updatedProducts.length} products`, "success");

    res.json({
      ok: true,
      count: updatedProducts.length,
      products: db.products
    });
  } catch (error) {
    addLog("Product-name auto search failed: " + error.message, "error");
    res.status(500).json({
      ok: false,
      error: "Failed to search competitor prices by product name"
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.post("/api/pricing/fetch-all-competitor-prices", async (req, res) => {
  let browser;
  try {
    const payload = req.body || {};
    const db = await readDB();
    const updatedProducts = [];

    browser = await createBrowser();

    for (const product of db.products) {
      const result = await syncCompetitorPricesForProduct(product, {
        searchMode: payload.searchMode || "product_name_size",
        searchTarget: payload.searchTarget || "all"
      }, browser);
      updatedProducts.push(result.product);
    }

    db.products = updatedProducts;
    await writeDB(db);
    addLog(`Bulk competitor price sync completed for ${updatedProducts.length} products`, "success");

    res.json({
      ok: true,
      count: updatedProducts.length,
      products: updatedProducts
    });
  } catch (error) {
    addLog("Bulk competitor price sync failed: " + error.message, "error");
    res.status(500).json({
      ok: false,
      error: "Failed to fetch all competitor prices"
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.get("/api/shiprocket/config", async (req, res) => {
  const config = getShiprocketConfig();
  res.json({
    ok: true,
    configured: Boolean(config.SHIPROCKET_TOKEN || (config.SHIPROCKET_EMAIL && config.SHIPROCKET_PASSWORD)),
    mode: config.SHIPROCKET_TOKEN ? "token" : (config.SHIPROCKET_EMAIL && config.SHIPROCKET_PASSWORD ? "login" : "missing")
  });
});

app.get("/api/shiprocket/auth-token", async (req, res) => {
  try {
    const auth = await getShiprocketToken();
    if (!auth.ok) {
      return res.status(503).json({
        ok: false,
        error: auth.message || "Shiprocket auth failed"
      });
    }
    res.json({
      ok: true,
      mode: auth.mode,
      token: auth.token
    });
  } catch (error) {
    addLog("Shiprocket auth token route failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to get Shiprocket token" });
  }
});

app.get(["/api/shiprocket/track", "/api/shiprocket/track/:awb"], async (req, res) => {
  try {
    const awb = String(req.params.awb || req.query.awb || req.query.trackingId || "").trim();

    if (!awb) {
      return res.status(400).json({
        ok: false,
        error: "AWB or trackingId is required"
      });
    }

    const auth = await getShiprocketToken();
    if (!auth.ok) {
      return res.status(503).json({
        ok: false,
        error: auth.message || "Shiprocket is not configured"
      });
    }

    const tracking = await shiprocketRequest({
      method: "GET",
      path: "/v1/external/courier/track/awb/" + encodeURIComponent(awb),
      token: auth.token
    });

    if (!tracking.ok) {
      addLog(`Shiprocket tracking failed for AWB ${awb}: ${JSON.stringify(tracking.data).slice(0, 220)}`, "error");
      return res.status(tracking.statusCode || 502).json({
        ok: false,
        awb,
        error: tracking.data?.message || tracking.data?.error || "Failed to fetch Shiprocket tracking",
        shiprocket: tracking.data
      });
    }

    addLog(`Shiprocket tracking fetched for AWB ${awb}`, "info");
    res.json({
      ok: true,
      awb,
      shiprocket: tracking.data
    });
  } catch (error) {
    addLog("Shiprocket tracking endpoint failed: " + error.message, "error");
    res.status(500).json({
      ok: false,
      error: "Failed to fetch Shiprocket tracking"
    });
  }
});

app.post("/api/shiprocket/webhook", async (req, res) => {
  try {
    const config = getShiprocketConfig();
    const expectedToken = config.SHIPROCKET_WEBHOOK_TOKEN || "";
    const providedToken = req.get("x-api-key") || req.get("x-shiprocket-token") || req.query.token || "";

    if (expectedToken && providedToken !== expectedToken) {
      addLog("Shiprocket webhook rejected: invalid verification token", "error");
      return res.status(401).json({ ok: false, error: "Invalid webhook token" });
    }

    const event = extractWebhookFields(req.body || {});
    const db = await readDB();
    const index = findOrderIndex(db, (order) => {
      return (event.awb && [order.awb, order.trackingId, order.awbCode].map(String).includes(String(event.awb)))
        || (event.orderId && [order.id, order.shiprocketOrderId, order.shipment_id].map(String).includes(String(event.orderId)));
    });

    if (index < 0) {
      addLog(`Shiprocket webhook received but no order matched AWB ${event.awb || "n/a"} order ${event.orderId || "n/a"}`, "error");
      return res.status(202).json({ ok: true, matched: false });
    }

    const current = db.orders[index];
    const historyEntry = {
      status: event.status,
      time: event.eventTime,
      location: event.location,
      note: event.note || "Shiprocket tracking update"
    };

    db.orders[index] = {
      ...current,
      awb: event.awb || current.awb || current.trackingId || "",
      trackingId: event.awb || current.trackingId || current.awb || "",
      courier_name: event.courier_name || current.courier_name || "",
      courierName: event.courier_name || current.courierName || "",
      tracking_url: event.tracking_url || current.tracking_url || "",
      trackingUrl: event.tracking_url || current.trackingUrl || "",
      trackingStatus: event.status || current.trackingStatus || "",
      estimatedDelivery: event.estimatedDelivery || current.estimatedDelivery || "",
      status: event.status || current.status,
      statusHistory: [...(Array.isArray(current.statusHistory) ? current.statusHistory : []), historyEntry],
      shiprocketWebhookLastPayload: req.body,
      updatedAt: new Date().toISOString()
    };

    await writeDB(db);
    addLog(`Shiprocket webhook updated order ${db.orders[index].id}: ${event.status}`, "info");
    res.json({ ok: true, matched: true, order: db.orders[index] });
  } catch (error) {
    addLog("Shiprocket webhook failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Webhook processing failed" });
  }
});

app.get("/", async (req, res) => {
  res.status(200).type("text/html").send(`
    <html>
      <head>
        <title>Swadra Backend</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            background: #f8f5f2;
            color: #222;
            padding: 40px;
          }
          .box {
            max-width: 800px;
            margin: auto;
            background: #fff;
            padding: 24px;
            border-radius: 18px;
            box-shadow: 0 10px 28px rgba(0,0,0,0.08);
          }
          h1 { color: #7a3d3d; margin-top: 0; }
          code {
            background: #f1ece8;
            padding: 3px 6px;
            border-radius: 6px;
          }
          ul { line-height: 1.8; }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>Swadra AI Pricing Backend Running</h1>
          <p>Available endpoints:</p>
          <ul>
            <li><code>GET /health</code></li>
            <li><code>GET /api/products</code></li>
            <li><code>POST /api/products</code></li>
            <li><code>PUT /api/products/:id</code></li>
            <li><code>DELETE /api/products/:id</code></li>
            <li><code>GET /api/logs</code></li>
            <li><code>POST /api/payments/create-order</code></li>
            <li><code>POST /api/payments/verify</code></li>
            <li><code>POST /api/payments/attempts</code></li>
            <li><code>GET /api/payments/attempts</code></li>
            <li><code>POST /api/pricing/run</code></li>
            <li><code>POST /api/products/:id/recalculate</code></li>
            <li><code>POST /api/pricing/fetch-competitor-prices</code></li>
            <li><code>POST /api/pricing/search-by-product-name</code></li>
            <li><code>POST /api/pricing/fetch-all-competitor-prices</code></li>
          </ul>
        </div>
      </body>
    </html>
  `);
});

app.use((error, req, res, next) => {
  console.error("[express error]", req.method, req.originalUrl, error);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

const server = app.listen(PORT, HOST, () => {
  const localUrl = `http://${HOST}:${PORT}`;
  const publicUrl = PUBLIC_BASE_URL
    ? (PUBLIC_BASE_URL.startsWith("http") ? PUBLIC_BASE_URL : `https://${PUBLIC_BASE_URL}`)
    : "";

  console.log(`Server running on ${localUrl}`);
  if(publicUrl){
    console.log(`Public URL: ${publicUrl}`);
  }

  if (ENABLE_STARTUP_DB_LOG) {
    addLog(`Backend server started on ${HOST}:${PORT}`, "success");
    if(publicUrl){
      addLog(`Public URL available at ${publicUrl}`, "success");
    }
  }
});

server.on("error", (error) => {
  console.error("[server error]", error);
});


