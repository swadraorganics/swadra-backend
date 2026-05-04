const express = require("express");
const cors = require("cors");
const fs = require("fs");
const http = require("http");
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
const FRONTEND_ORIGIN = String(process.env.FRONTEND_ORIGIN || "").trim();
const USE_FIRESTORE = String(process.env.USE_FIRESTORE || "").toLowerCase() === "true";
const IS_HOSTED_RUNTIME = Boolean(
  PUBLIC_BASE_URL ||
  process.env.RAILWAY_PROJECT_ID ||
  process.env.RAILWAY_SERVICE_ID ||
  process.env.RAILWAY_ENVIRONMENT
);
const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION || "appData";
const FIRESTORE_DOCUMENT = process.env.FIRESTORE_DOCUMENT || "swadra";
const FIRESTORE_LISTS = ["orders", "paymentAttempts", "logs"];
const ENABLE_STARTUP_DB_LOG = String(process.env.ENABLE_STARTUP_DB_LOG || "").toLowerCase() === "true";
const ENABLE_PERSISTENT_LOGS = String(process.env.ENABLE_PERSISTENT_LOGS || "").toLowerCase() === "true";
let firestoreDb = null;
let memoryDb = null;
let dbCache = null;
let dbCacheLoaded = false;

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function splitOrigins(value) {
  return String(value || "")
    .split(",")
    .map((entry) => normalizeOrigin(entry))
    .filter(Boolean);
}

function buildAllowedOrigins() {
  const allowed = new Set();
  splitOrigins(FRONTEND_ORIGIN).forEach((origin) => allowed.add(origin));
  [
    "https://swadraorganics.com",
    "https://www.swadraorganics.com",
    "https://swadra-organics-db127.web.app",
    "https://swadra-organics-db127.firebaseapp.com"
  ].forEach((origin) => allowed.add(origin));
  const publicOrigin = normalizeOrigin(
    PUBLIC_BASE_URL
      ? (PUBLIC_BASE_URL.startsWith("http") ? PUBLIC_BASE_URL : `https://${PUBLIC_BASE_URL}`)
      : ""
  );
  if (publicOrigin) {
    allowed.add(publicOrigin);
  }
  return allowed;
}

const ALLOWED_ORIGINS = buildAllowedOrigins();
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error);
});

app.use(cors({
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-session-token"],
  credentials: true,
  origin(origin, callback) {
    const normalized = normalizeOrigin(origin);
    if (!normalized) {
      callback(null, true);
      return;
    }
    if (
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized) ||
      ALLOWED_ORIGINS.has(normalized)
    ) {
      callback(null, true);
      return;
    }
    callback(new Error("CORS origin not allowed"));
  }
}));
app.use("/api/payments/webhook", express.raw({ type: "application/json", limit: "2mb" }));
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));
app.use(express.static(__dirname));

const rateLimitStore = new Map();

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "unknown";
}

function createRateLimiter({ windowMs, max, keyPrefix }) {
  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const key = `${keyPrefix}:${clientIp(req)}`;
    const record = rateLimitStore.get(key);
    if (!record || now > record.resetAt) {
      rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (record.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        ok: false,
        error: "Too many requests. Please try again shortly."
      });
    }
    record.count += 1;
    rateLimitStore.set(key, record);
    return next();
  };
}

const authRateLimit = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 10, keyPrefix: "auth" });
const couponRateLimit = createRateLimiter({ windowMs: 5 * 60 * 1000, max: 30, keyPrefix: "coupon" });
const paymentRateLimit = createRateLimiter({ windowMs: 5 * 60 * 1000, max: 120, keyPrefix: "payment" });
const webhookRateLimit = createRateLimiter({ windowMs: 60 * 1000, max: 120, keyPrefix: "webhook" });

function createSerialMiddleware() {
  let tail = Promise.resolve();
  return async function serialMiddleware(req, res, next) {
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const previous = tail;
    tail = tail.then(() => current, () => current);
    await previous;
    const done = () => release();
    res.once("finish", done);
    res.once("close", done);
    next();
  };
}

const inventorySerial = createSerialMiddleware();

function getDefaultDB() {
  return {
    coupons: [],
    orders: [],
    paymentAttempts: [],
    logs: [],
    userActivities: [],
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
  db.coupons = Array.isArray(db.coupons) ? db.coupons : [];
  db.orders = Array.isArray(db.orders) ? db.orders : [];
  db.paymentAttempts = Array.isArray(db.paymentAttempts) ? db.paymentAttempts : [];
  db.logs = Array.isArray(db.logs) ? db.logs : [];
  db.userActivities = Array.isArray(db.userActivities) ? db.userActivities : [];
  db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};
  db.admin = db.admin && typeof db.admin === "object" ? db.admin : {};
  db.admin.username = String(db.admin.username || "admin").trim() || "admin";
  db.admin.passwordHash = String(db.admin.passwordHash || "");
  db.admin.passwordSalt = String(db.admin.passwordSalt || "");
  db.admin.passwordAlgo = String(db.admin.passwordAlgo || (db.admin.passwordHash ? "scrypt" : ""));
  db.admin.password = db.admin.passwordHash ? String(db.admin.password || "") : String(db.admin.password || "1234");
  db.meta = db.meta && typeof db.meta === "object" ? db.meta : {};
  return db;
}

function normalizeCoupon(input = {}) {
  const code = String(input.code || "").trim().toUpperCase();
  const scope = String(input.scope || input.couponScope || input.type || "").trim().toLowerCase();
  return {
    id: String(input.id || "coupon_" + Date.now() + "_" + Math.floor(Math.random() * 1000)),
    code,
    discount: Math.max(0, Math.round(toNumber(input.discount))),
    minimumAmount: Math.max(0, Math.round(toNumber(input.minimumAmount || input.minAmount))),
    scope: scope === "special" || scope === "overall" || scope === "overall_with_delivery" ? "overall_with_delivery" : "product_base",
    sharePercent: Math.max(0, Math.min(100, toNumber(input.sharePercent || input.commissionPercent || input.payoutPercent || 5) || 5)),
    status: String(input.status || "active").toLowerCase() === "inactive" ? "inactive" : "active",
    createdAt: input.createdAt || input.created || "",
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
    const projectId = String(process.env.FIREBASE_PROJECT_ID || "").trim();
    const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || "").trim();
    const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    if (projectId && clientEmail && privateKey) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey
        })
      });
    } else {
      admin.initializeApp();
    }
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

async function readTopLevelFirestoreCollection(name) {
  if (!USE_FIRESTORE) return [];
  try {
    const snap = await getFirestore().collection(name).get();
    return snap.docs.map((doc) => {
      const data = doc.data() || {};
      return { ...data, id: data.id || data.email || doc.id, docId: doc.id };
    });
  } catch (error) {
    addLog(`Top-level Firestore ${name} read failed: ${error.message}`, "warn");
    return [];
  }
}

async function readTopLevelSiteContent() {
  if (!USE_FIRESTORE) return {};
  try {
    const snap = await getFirestore().collection("siteContent").doc("homepage").get();
    return snap.exists ? snap.data() || {} : {};
  } catch (error) {
    addLog("Top-level siteContent read failed: " + error.message, "warn");
    return {};
  }
}

async function readDurableAdminCredentials() {
  if (!USE_FIRESTORE) return null;
  try {
    const snap = await getFirestore().collection("adminCredentials").doc("current").get();
    return snap.exists ? (snap.data() || null) : null;
  } catch (error) {
    addLog("Admin credentials mirror read skipped: " + error.message, "warn");
    return null;
  }
}

async function writeDurableAdminCredentials(adminConfig = {}) {
  if (!USE_FIRESTORE) return;
  const payload = {
    username: String(adminConfig.username || "admin").trim() || "admin",
    passwordHash: String(adminConfig.passwordHash || ""),
    passwordSalt: String(adminConfig.passwordSalt || ""),
    passwordAlgo: String(adminConfig.passwordAlgo || ""),
    role: String(adminConfig.role || "owner").trim() || "owner",
    passwordUpdatedAt: adminConfig.passwordUpdatedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await getFirestore().collection("adminCredentials").doc("current").set(payload, { merge: true });
}

async function writeTopLevelSiteContentPatch(patch = {}) {
  if (!USE_FIRESTORE) return;
  await getFirestore().collection("siteContent").doc("homepage").set(patch, { merge: true });
}

async function writeTopLevelUsers(users = {}) {
  if (!USE_FIRESTORE) return;
  const firestore = getFirestore();
  let batch = firestore.batch();
  let count = 0;
  for (const [email, record] of Object.entries(users || {})) {
    const id = safeDocId(record.uid || record.userId || record.id || email);
    batch.set(firestore.collection("users").doc(id), { ...record, email: record.email || email }, { merge: true });
    count += 1;
    if (count >= 400) {
      await batch.commit();
      batch = firestore.batch();
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
}

function normalizeCartItems(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const qty = Math.max(1, Math.round(toNumber(item?.qty || item?.quantity || 1)) || 1);
    const price = Math.max(0, toNumber(item?.price || item?.sellingPrice || item?.discountedUnitPrice || item?.displayPrice || 0));
    const mrp = Math.max(0, toNumber(item?.mrp || item?.originalPrice || item?.mrpPrice || item?.price || 0));
    const size = String(item?.size || item?.productSize || item?.selectedSize || item?.variant || item?.weight || item?.packSize || item?.unit || item?.weightLabel || item?.quantityLabel || "").trim();
    const image = String(item?.image || item?.productImage || item?.thumbnail || "").trim();
    return {
      ...item,
      id: String(item?.id ?? item?.productId ?? item?.sku ?? item?.name ?? Date.now()).trim(),
      productId: String(item?.productId || item?.id || item?.sku || "").trim(),
      sku: String(item?.sku || item?.productSku || "").trim(),
      name: String(item?.name || item?.productName || item?.title || "Swadra Product").trim(),
      productName: String(item?.productName || item?.name || item?.title || "Swadra Product").trim(),
      qty,
      quantity: qty,
      price,
      sellingPrice: Math.max(0, toNumber(item?.sellingPrice || price)),
      discountedUnitPrice: Math.max(0, toNumber(item?.discountedUnitPrice || item?.displayPrice || price)),
      mrp,
      originalPrice: Math.max(0, toNumber(item?.originalPrice || mrp || price)),
      size,
      productSize: size,
      selectedSize: size,
      variant: size,
      weight: String(item?.weight || size).trim(),
      packSize: String(item?.packSize || "").trim(),
      unit: String(item?.unit || "").trim(),
      image,
      productImage: image,
      images: Array.isArray(item?.images) ? item.images.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 4) : (image ? [image] : []),
      displayLineTotal: Math.round(toNumber(item?.displayLineTotal || item?.discountedLineTotal || price * qty)),
      discountedLineTotal: Math.round(toNumber(item?.discountedLineTotal || item?.displayLineTotal || price * qty)),
      originalLineTotal: Math.round(toNumber(item?.originalLineTotal || item?.mrpLineTotal || (mrp || price) * qty)),
      mrpLineTotal: Math.round(toNumber(item?.mrpLineTotal || item?.originalLineTotal || (mrp || price) * qty)),
      couponLineDiscount: Math.round(toNumber(item?.couponLineDiscount || item?.lineCouponDiscount || 0)),
      productDiscount: Math.round(toNumber(item?.productDiscount || Math.max(0, ((mrp || price) - price) * qty)))
    };
  }).filter((item) => item.id || item.name);
}

async function writeTopLevelOrder(order = {}) {
  if (!USE_FIRESTORE || !order || typeof order !== "object") return;
  const id = safeDocId(order.id || order.orderId || "");
  await getFirestore().collection("orders").doc(id).set(order, { merge: true });
}

async function writeTopLevelPaymentAttempt(attempt = {}) {
  if (!USE_FIRESTORE || !attempt || typeof attempt !== "object") return;
  const id = safeDocId(attempt.id || attempt.orderId || attempt.localOrderId || attempt.razorpayOrderId || "");
  if (!id) return;
  await getFirestore().collection("paymentAttempts").doc(id).set(attempt, { merge: true });
}

async function writeTopLevelUserActivity(activity = {}) {
  if (!USE_FIRESTORE || !activity || typeof activity !== "object") return;
  const id = safeDocId(activity.id || ("activity_" + Date.now() + "_" + Math.floor(Math.random() * 1000)));
  await getFirestore().collection("userActivities").doc(id).set({ ...activity, id: activity.id || id }, { merge: true });
}

async function deleteTopLevelUserDocs(collectionName, ids = []) {
  if (!USE_FIRESTORE) return;
  const firestore = getFirestore();
  const uniqueIds = Array.from(new Set(ids.map((id) => String(id || "").trim()).filter(Boolean)));
  if (!uniqueIds.length) return;
  let batch = firestore.batch();
  let count = 0;
  for (const id of uniqueIds) {
    batch.delete(firestore.collection(collectionName).doc(safeDocId(id)));
    count += 1;
    if (count >= 400) {
      await batch.commit();
      batch = firestore.batch();
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
}

function mergeRecordsById(primary = [], secondary = []) {
  const map = new Map();
  [...secondary, ...primary].forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const key = String(item.id || item.orderId || item.email || item.code || item.docId || `item_${index}`);
    map.set(key, { ...(map.get(key) || {}), ...item });
  });
  return Array.from(map.values());
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

function productPersistenceDisabledResponse(res) {
  return res.status(410).json({
    ok: false,
    error: "Legacy product endpoint disabled. Use Firestore products collection and Cloudinary image upload only."
  });
}

function hashAdminToken(token = "") {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function getAdminSessionSecret(db = {}) {
  const admin = db.admin && typeof db.admin === "object" ? db.admin : {};
  return String(
    process.env.ADMIN_SESSION_SECRET ||
    admin.passwordHash ||
    admin.passwordSalt ||
    admin.password ||
    "swadra-admin-session"
  );
}

function base64UrlEncode(value = "") {
  return Buffer.from(String(value || ""), "utf8").toString("base64url");
}

function base64UrlDecode(value = "") {
  return Buffer.from(String(value || ""), "base64url").toString("utf8");
}

function signAdminSessionPayload(db = {}, payload = "") {
  return crypto.createHmac("sha256", getAdminSessionSecret(db)).update(String(payload || "")).digest("hex");
}

function createSignedAdminToken(db = {}, session = {}) {
  const payload = base64UrlEncode(JSON.stringify({
    username: String(session.username || "").trim(),
    role: String(session.role || "owner").trim() || "owner",
    expiresAt: String(session.expiresAt || ""),
    nonce: crypto.randomBytes(8).toString("hex")
  }));
  return "sat_" + payload + "." + signAdminSessionPayload(db, payload);
}

function verifySignedAdminToken(db = {}, token = "") {
  const raw = String(token || "").trim();
  if (!raw.startsWith("sat_") || !raw.includes(".")) return null;
  const body = raw.slice(4);
  const [payload, signature] = body.split(".");
  if (!payload || !signature) return null;
  const expected = signAdminSessionPayload(db, payload);
  if (!safeEqualHex(signature, expected)) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(base64UrlDecode(payload));
  } catch (error) {
    return null;
  }
  const username = String(parsed.username || "").trim();
  const expiresAt = String(parsed.expiresAt || "");
  if (!username || username !== String(db.admin?.username || "").trim()) return null;
  if (Date.parse(expiresAt || "") <= Date.now()) return null;
  return {
    tokenHash: hashAdminToken(raw),
    username,
    role: String(parsed.role || db.admin?.role || "owner"),
    status: "active",
    expiresAt,
    signed: true
  };
}

function getCustomerSessionSecret(db = {}) {
  return String(
    process.env.CUSTOMER_SESSION_SECRET ||
    process.env.ADMIN_SESSION_SECRET ||
    db.admin?.passwordHash ||
    db.admin?.passwordSalt ||
    "swadra-customer-session"
  );
}

function signCustomerSessionPayload(db = {}, payload = "") {
  return crypto.createHmac("sha256", getCustomerSessionSecret(db)).update(String(payload || "")).digest("hex");
}

function createSignedCustomerToken(db = {}, session = {}) {
  const email = normalizeAccountEmail(session.email || session.userId || "");
  const phone = normalizeAccountPhone(session.phone || session.mobile || "");
  if (!email && !phone) return "";
  const payload = base64UrlEncode(JSON.stringify({
    email,
    phone,
    uid: String(session.uid || session.userId || "").trim(),
    expiresAt: String(session.expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()),
    nonce: crypto.randomBytes(8).toString("hex")
  }));
  return "sct_" + payload + "." + signCustomerSessionPayload(db, payload);
}

function verifySignedCustomerToken(db = {}, token = "") {
  const raw = String(token || "").trim();
  if (!raw.startsWith("sct_") || !raw.includes(".")) return null;
  const body = raw.slice(4);
  const [payload, signature] = body.split(".");
  if (!payload || !signature) return null;
  const expected = signCustomerSessionPayload(db, payload);
  if (!safeEqualText(signature, expected)) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(base64UrlDecode(payload));
  } catch (error) {
    return null;
  }
  if (Date.parse(parsed.expiresAt || "") <= Date.now()) return null;
  const email = normalizeAccountEmail(parsed.email || "");
  const phone = normalizeAccountPhone(parsed.phone || "");
  if (!email && !phone) return null;
  return { email, phone, uid: String(parsed.uid || "").trim(), expiresAt: parsed.expiresAt };
}

function hashAdminPassword(password = "", salt = crypto.randomBytes(16).toString("hex")) {
  const cleanSalt = String(salt || "").trim() || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password || ""), cleanSalt, 64).toString("hex");
  return {
    passwordHash: hash,
    passwordSalt: cleanSalt,
    passwordAlgo: "scrypt"
  };
}

function safeEqualHex(left = "", right = "") {
  const a = Buffer.from(String(left || ""), "hex");
  const b = Buffer.from(String(right || ""), "hex");
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeEqualText(left = "", right = "") {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyAdminPassword(db = {}, password = "") {
  const admin = db.admin && typeof db.admin === "object" ? db.admin : {};
  if (admin.passwordHash && admin.passwordSalt) {
    const candidate = hashAdminPassword(password, admin.passwordSalt);
    return {
      ok: safeEqualHex(candidate.passwordHash, admin.passwordHash),
      legacy: false
    };
  }
  return {
    ok: String(password || "") === String(admin.password || ""),
    legacy: true
  };
}

function setAdminPasswordHash(db = {}, password = "") {
  db.admin = db.admin && typeof db.admin === "object" ? db.admin : {};
  const hashed = hashAdminPassword(password);
  db.admin.passwordHash = hashed.passwordHash;
  db.admin.passwordSalt = hashed.passwordSalt;
  db.admin.passwordAlgo = hashed.passwordAlgo;
  db.admin.passwordUpdatedAt = new Date().toISOString();
  db.admin.password = "";
  return db.admin;
}

function ensureAdminSecurity(db = {}) {
  db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};
  db.appState.adminSessions = Array.isArray(db.appState.adminSessions) ? db.appState.adminSessions : [];
  db.appState.adminAudit = Array.isArray(db.appState.adminAudit) ? db.appState.adminAudit : [];
  db.admin = db.admin && typeof db.admin === "object" ? db.admin : {};
  db.admin.role = String(db.admin.role || "owner").trim() || "owner";
  return db.appState;
}

function getAdminTokenFromRequest(req) {
  const tokens = getAdminTokensFromRequest(req);
  return tokens[0] || "";
}

function getAdminTokensFromRequest(req) {
  const tokens = [];
  const addToken = (value) => {
    const token = String(value || "").trim();
    if (token && !tokens.includes(token)) tokens.push(token);
  };
  const auth = String(req.get("authorization") || "").trim();
  if (/^Bearer\s+/i.test(auth)) addToken(auth.replace(/^Bearer\s+/i, "").trim());
  addToken(req.get("x-admin-session-token"));
  addToken(req.body?.adminToken);
  addToken(req.query?.adminToken);
  const cookie = String(req.get("cookie") || "");
  const match = cookie.match(/(?:^|;\s*)swadra_admin_token=([^;]+)/);
  if (match) addToken(decodeURIComponent(match[1]));
  return tokens;
}

function setAdminSessionCookie(res, token = "", expiresAt = "") {
  const maxAgeSeconds = Math.max(1, Math.floor((Date.parse(expiresAt || "") - Date.now()) / 1000)) || (12 * 60 * 60);
  res.setHeader("Set-Cookie", [
    "swadra_admin_token=" + encodeURIComponent(String(token || "")),
    "Max-Age=" + maxAgeSeconds,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=None"
  ].join("; "));
}

function clearAdminSessionCookie(res) {
  res.setHeader("Set-Cookie", "swadra_admin_token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None");
}

function setCustomerSessionCookie(res, token = "", expiresAt = "") {
  if (!token) return;
  const maxAgeSeconds = Math.max(1, Math.floor((Date.parse(expiresAt || "") - Date.now()) / 1000)) || (30 * 24 * 60 * 60);
  res.append("Set-Cookie", [
    "swadra_customer_token=" + encodeURIComponent(String(token || "")),
    "Max-Age=" + maxAgeSeconds,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=None"
  ].join("; "));
}

function clearCustomerSessionCookie(res) {
  res.append("Set-Cookie", "swadra_customer_token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None");
}

function getCustomerSessionFromRequest(db = {}, req) {
  const auth = String(req.get("authorization") || "").trim();
  const bearer = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : "";
  const explicit = String(req.get("x-customer-session-token") || req.query?.customerToken || req.body?.customerToken || "").trim();
  const cookie = String(req.get("cookie") || "");
  const match = cookie.match(/(?:^|;\s*)swadra_customer_token=([^;]+)/);
  const tokens = [bearer, explicit, match ? decodeURIComponent(match[1]) : ""].filter(Boolean);
  for (const token of tokens) {
    const session = verifySignedCustomerToken(db, token);
    if (session) return session;
  }
  return null;
}

function findValidAdminSession(db = {}, req) {
  const tokens = getAdminTokensFromRequest(req);
  if (!tokens.length) return null;
  const state = ensureAdminSecurity(db);
  const now = Date.now();
  for (const token of tokens) {
    const tokenHash = hashAdminToken(token);
    const storedSession = state.adminSessions.find((session) => {
      return session &&
        session.tokenHash === tokenHash &&
        Date.parse(session.expiresAt || "") > now &&
        String(session.status || "active") === "active";
    }) || null;
    if (storedSession) return storedSession;
    const signedSession = verifySignedAdminToken(db, token);
    if (signedSession) return signedSession;
  }
  return null;
}

function revokeAdminSessionForRequest(db = {}, req) {
  const tokens = getAdminTokensFromRequest(req);
  if (!tokens.length) return false;
  const state = ensureAdminSecurity(db);
  const tokenHashes = tokens.map((token) => hashAdminToken(token));
  let revoked = false;
  state.adminSessions = state.adminSessions.map((session) => {
    if (session && tokenHashes.includes(session.tokenHash) && String(session.status || "active") === "active") {
      revoked = true;
      return {
        ...session,
        status: "revoked",
        revokedAt: new Date().toISOString()
      };
    }
    return session;
  });
  return revoked;
}

function normalizeCustomerIdentity(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return [];
  const values = [text];
  const digits = text.replace(/\D/g, "");
  if (digits.length >= 10) values.push(digits.slice(-10));
  return Array.from(new Set(values.filter(Boolean)));
}

function getUniqueCustomerIdentities(values = []) {
  return Array.from(new Set(values.flatMap((value) => normalizeCustomerIdentity(value))));
}

function getCustomerAccessFields(req) {
  const cookieSession = req.__customerSession || null;
  return getUniqueCustomerIdentities([
    cookieSession?.email,
    cookieSession?.phone,
    cookieSession?.uid,
    req.query?.userId,
    req.query?.uid,
    req.query?.authUserId,
    req.query?.firebaseUid,
    req.query?.email,
    req.query?.customerEmail,
    req.query?.phone,
    req.body?.userId,
    req.body?.uid,
    req.body?.authUserId,
    req.body?.firebaseUid,
    req.body?.email,
    req.body?.customerEmail,
    req.body?.phone,
    req.body?.mobile,
    req.get("x-customer-user"),
    req.get("x-customer-uid"),
    req.get("x-customer-email"),
    req.get("x-customer-phone")
  ]);
}

function getOrderCustomerIdentities(order = {}) {
  const shipping = order.shipping && typeof order.shipping === "object" ? order.shipping : {};
  const billing = order.billing && typeof order.billing === "object" ? order.billing : {};
  return getUniqueCustomerIdentities([
    order.userId,
    order.user,
    order.uid,
    order.authUserId,
    order.firebaseUid,
    order.customerId,
    order.email,
    order.customerEmail,
    order.userEmail,
    order.shippingEmail,
    order.phone,
    order.mobile,
    order.customerPhone,
    order.shippingPhone,
    shipping.userId,
    shipping.uid,
    shipping.email,
    shipping.phone,
    shipping.mobile,
    billing.email,
    billing.phone,
    billing.mobile
  ]);
}

function orderMatchesCustomerAccess(order = {}, req) {
  const values = getCustomerAccessFields(req);
  if (!values.length) return false;
  const candidates = getOrderCustomerIdentities(order);
  return candidates.some((value) => values.includes(value));
}

function auditAdminAction(db = {}, req, action, status = "success", details = {}) {
  const state = ensureAdminSecurity(db);
  const session = findValidAdminSession(db, req) || {};
  state.adminAudit.unshift({
    id: "audit_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    action,
    status,
    username: session.username || String(req.body?.username || "unknown"),
    role: session.role || "unknown",
    ip: clientIp(req),
    userAgent: String(req.get("user-agent") || "").slice(0, 180),
    details,
    time: new Date().toISOString()
  });
  state.adminAudit = state.adminAudit.slice(0, 1000);
}

function recordUserActivity(db = {}, input = {}) {
  if (!db || typeof db !== "object") return null;
  const activity = {
    id: "act_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    type: String(input.type || input.action || "activity").trim(),
    userId: String(input.userId || input.email || input.uid || "").trim().toLowerCase(),
    email: normalizeAccountEmail(input.email || input.userId || ""),
    phone: normalizeAccountPhone(input.phone || input.mobile || ""),
    orderId: String(input.orderId || "").trim(),
    paymentId: String(input.paymentId || input.razorpayPaymentId || "").trim(),
    status: String(input.status || "").trim(),
    details: input.details && typeof input.details === "object" ? input.details : {},
    ip: input.req ? clientIp(input.req) : "",
    userAgent: input.req ? String(input.req.get("user-agent") || "").slice(0, 180) : "",
    createdAt: new Date().toISOString()
  };
  db.userActivities = Array.isArray(db.userActivities) ? db.userActivities : [];
  db.userActivities.unshift(activity);
  db.userActivities = db.userActivities.slice(0, 2000);
  db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};
  db.appState.userActivities = db.userActivities;
  writeTopLevelUserActivity(activity).catch((error) => {
    addLog("User activity Firestore mirror skipped: " + error.message, "warn");
  });
  return activity;
}

async function requireAdminSession(req, res, next) {
  try {
    const db = await readDB();
    const session = findValidAdminSession(db, req);
    if (!session) {
      auditAdminAction(db, req, req.method + " " + req.path, "blocked", { reason: "missing-or-expired-session" });
      await writeDB(db);
      return res.status(401).json({ ok: false, error: "Admin session required" });
    }
    req.adminSession = session;
    next();
  } catch (error) {
    addLog("Admin session check failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to verify admin session" });
  }
}

function requireDurablePersistence(res) {
  return true;
}

const PUBLIC_APP_STATE_KEYS = new Set([
  "homeContent",
  "offers",
  "heroImages",
  "customers",
  "familyCards",
  "swadra_home_family_story_v1",
  "shippingSettings",
  "compliance",
  "policyPages",
  "supportRequests",
  "callbackRequests",
  "contactRequests"
]);

const PUBLIC_APP_STATE_WRITE_KEYS = new Set([
  "supportRequests",
  "callbackRequests",
  "contactRequests"
]);

function filterPublicAppStateKeys(keys = []) {
  return (Array.isArray(keys) ? keys : []).filter((key) => PUBLIC_APP_STATE_KEYS.has(String(key || "")));
}

function isPublicAppStateWrite(state = {}, removeKeys = []) {
  const stateKeys = Object.keys(state || {});
  const deleteKeys = Array.isArray(removeKeys) ? removeKeys : [];
  return [...stateKeys, ...deleteKeys].every((key) => PUBLIC_APP_STATE_WRITE_KEYS.has(String(key || "")));
}

function redactBackupSecrets(value) {
  if (Array.isArray(value)) return value.map(redactBackupSecrets);
  if (!value || typeof value !== "object") return value;
  const output = {};
  Object.keys(value).forEach((key) => {
    if (/password|secret|token|apikey|api_key|salt|hash/i.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactBackupSecrets(value[key]);
    }
  });
  return output;
}

function ensureReconciliationReports(db = {}) {
  db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};
  db.appState.reconciliationReports = Array.isArray(db.appState.reconciliationReports) ? db.appState.reconciliationReports : [];
  return db.appState.reconciliationReports;
}

function moneyNumber(value) {
  return Math.round(toNumber(value || 0));
}

function getReportOrderValue(order = {}) {
  return moneyNumber(order.finalAmount || order.payableAmount || order.total || order.amount || order.totalAmount || order.paidAmount || 0);
}

function getReportPaidAmount(order = {}) {
  const status = String(order.paymentStatus || order.payment || order.status || "").toLowerCase();
  if (String(order.status || "").toLowerCase().includes("cancel")) return 0;
  if (status.includes("paid") || status.includes("success")) return getReportOrderValue(order);
  return moneyNumber(order.paidAmount || 0);
}

function getReportRefundAmount(order = {}) {
  return moneyNumber(order.refundAmount || order.refundRaw?.amount && toNumber(order.refundRaw.amount) / 100 || 0);
}

function getReportCourierCharge(order = {}) {
  const delivery = order.deliveryDetails || order.shipping?.deliveryDetails || {};
  const shiprocket = order.shiprocket || {};
  return moneyNumber(
    shiprocket.freight_charge ||
    shiprocket.courier_charge ||
    shiprocket.shipping_charge ||
    order.freight_charge ||
    order.courier_charge ||
    delivery.lowestCourierCharge ||
    order.lowestCourierCharge ||
    0
  );
}

function buildReconciliationReport(db = {}, input = {}) {
  const now = new Date().toISOString();
  const from = String(input.from || "").trim();
  const to = String(input.to || "").trim();
  const fromTime = from ? Date.parse(from) : 0;
  const toTime = to ? Date.parse(to) + 24 * 60 * 60 * 1000 - 1 : Infinity;
  const orders = (Array.isArray(db.orders) ? db.orders : []).filter((order) => {
    const rawDate = order.createdAt || order.date || order.updatedAt || "";
    const t = Date.parse(rawDate);
    if (!t) return true;
    return t >= fromTime && t <= toTime;
  });
  const attempts = Array.isArray(db.paymentAttempts) ? db.paymentAttempts : [];
  const rows = orders.map((order) => {
    const id = String(order.id || order.orderId || "");
    const paidAmount = getReportPaidAmount(order);
    const refundAmount = getReportRefundAmount(order);
    return {
      id,
      userId: String(order.userId || order.user || order.email || order.customerEmail || ""),
      date: order.createdAt || order.date || order.updatedAt || "",
      status: String(order.status || order.orderStatus || ""),
      paymentStatus: String(order.paymentStatus || order.payment || ""),
      orderValue: getReportOrderValue(order),
      paidAmount,
      refundAmount,
      courierCharge: getReportCourierCharge(order),
      netReceivable: Math.max(0, paidAmount - refundAmount),
      razorpayOrderId: String(order.razorpayOrderId || order.paymentOrderId || ""),
      razorpayPaymentId: String(order.razorpayPaymentId || order.paymentId || order.payment_id || "")
    };
  });
  const paymentPaid = attempts.filter((attempt) => String(attempt.status || "").toLowerCase().includes("paid")).reduce((sum, attempt) => {
    return sum + moneyNumber((attempt.amountPaise ? toNumber(attempt.amountPaise) / 100 : attempt.amount || attempt.snapshot?.amount || 0));
  }, 0);
  const totals = {
    orders: rows.length,
    orderValue: rows.reduce((sum, row) => sum + row.orderValue, 0),
    paidAmount: rows.reduce((sum, row) => sum + row.paidAmount, 0),
    refundAmount: rows.reduce((sum, row) => sum + row.refundAmount, 0),
    courierCharge: rows.reduce((sum, row) => sum + row.courierCharge, 0),
    netReceivable: rows.reduce((sum, row) => sum + row.netReceivable, 0),
    paymentAttempts: attempts.length,
    paymentAttemptPaidAmount: paymentPaid
  };
  const fingerprint = hashPayload({ from, to, totals, rows });
  return {
    id: String(input.id || "rec_" + now.slice(0, 10) + "_" + fingerprint.slice(0, 10)),
    from,
    to,
    createdAt: now,
    createdBy: String(input.createdBy || "admin"),
    immutable: true,
    fingerprint,
    totals,
    rows
  };
}

async function readDB() {
  if (USE_FIRESTORE) {
    await ensureFirestoreDB();
    const firestore = getFirestore();
    const rootRef = firestore.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT);
    const rootSnap = await rootRef.get();
    const data = rootSnap.exists ? rootSnap.data() || {} : {};
    const mirroredAdmin = await readDurableAdminCredentials();
    if (mirroredAdmin && (mirroredAdmin.passwordHash || mirroredAdmin.passwordSalt || mirroredAdmin.username)) {
      data.admin = { ...(data.admin || {}), ...mirroredAdmin, password: "" };
    }
    for (const name of FIRESTORE_LISTS) {
      data[name] = await readFirestoreCollection(rootRef, name);
    }
    return normalizeDB(data);
  }
  if (dbCacheLoaded && dbCache) {
    return dbCache;
  }
  if (!memoryDb) {
    // Railway should not recreate db.json or any file-backed business store.
    // Outside Firestore, backend state is runtime-memory only.
    memoryDb = getDefaultDB();
  }
  dbCache = normalizeDB(memoryDb);
  dbCacheLoaded = true;
  return dbCache;
}

async function writeDB(data) {
  data.meta = data.meta || {};
  data.meta.updatedAt = new Date().toISOString();
  const normalized = normalizeDB(data);
  dbCache = normalized;
  dbCacheLoaded = true;
  if (USE_FIRESTORE) {
    const firestore = getFirestore();
    const rootRef = firestore.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT);
    await rootRef.set({
      meta: normalized.meta,
      admin: normalized.admin,
      coupons: normalized.coupons,
      userActivities: normalized.userActivities.slice(0, 2000),
      appState: normalized.appState
    }, { merge: true });
    await writeDurableAdminCredentials(normalized.admin);
    for (const name of FIRESTORE_LISTS) {
      await replaceFirestoreCollection(rootRef, name, normalized[name]);
    }
    return;
  }
  memoryDb = normalized;
}

async function readProducts() {
  // Product master data is no longer served from backend files or Firestore appData.
  // The only approved source is the frontend Firestore "products" collection helper.
  return [];
}

async function writeProducts(products) {
  throw new Error("Legacy backend product persistence is disabled. Use Firestore products collection only.");
}

async function addLog(message, level = "info") {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[${level}] ${message}`);
  if (!ENABLE_PERSISTENT_LOGS) {
    return;
  }
  try {
    const db = await readDB();
    cleanupInventoryLocks(db);
    db.logs.unshift({
      id: "log_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
      time: new Date().toISOString(),
      level,
      message
    });
    db.logs = db.logs.slice(0, 500);
    if (shouldTriggerOpsAlert(message, level)) {
      const state = db.appState && typeof db.appState === "object" ? db.appState : {};
      const cooldownSec = Math.max(60, Math.round(toNumber(state.alertCooldownSec || 300)));
      const now = Date.now();
      const lastAt = Number(state.lastAlertAtTs || 0);
      if (!lastAt || now - lastAt >= cooldownSec * 1000) {
        const alertResp = await sendOpsAlert(db, message, level);
        if (alertResp && alertResp.ok) {
          db.appState = state;
          db.appState.lastAlertAtTs = now;
          db.appState.lastAlertAt = new Date(now).toISOString();
        }
      }
    }
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

function getEmailConfig(db = {}) {
  const appState = db.appState && typeof db.appState === "object" ? db.appState : {};
  return {
    resendApiKey: String(process.env.RESEND_API_KEY || appState.resendApiKey || "").trim(),
    fromEmail: String(process.env.RESEND_FROM_EMAIL || appState.resendFromEmail || "Swadra Organics <orders@swadraorganics.com>").trim(),
    replyTo: String(process.env.RESEND_REPLY_TO || appState.resendReplyTo || "").trim()
  };
}

function pickOrderEmail(order = {}) {
  return String(
    order.customerEmail ||
    order.email ||
    order.userEmail ||
    (String(order.userId || "").includes("@") ? order.userId : "") ||
    order.shipping?.email ||
    ""
  ).trim().toLowerCase();
}

function pickOrderName(order = {}) {
  return String(order.shipping?.name || order.customerName || order.name || "Customer").trim();
}

function normalizeEmailStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  if (value.includes("refund")) return "Refund";
  if (value.includes("cancel")) return "Cancelled";
  if (value.includes("deliver")) return "Delivered";
  if (value.includes("out")) return "Out for Delivery";
  if (value.includes("dispatch") || value.includes("ship")) return "Dispatched";
  if (value.includes("pack")) return "Packed";
  if (value.includes("confirm") || value.includes("paid")) return "Confirmed";
  return status ? String(status) : "Updated";
}

function getEmailTemplateConfig(db = {}, label = "Updated") {
  const appState = db.appState && typeof db.appState === "object" ? db.appState : {};
  const templates = appState.emailTemplates && typeof appState.emailTemplates === "object" ? appState.emailTemplates : {};
  const template = templates[label] && typeof templates[label] === "object" ? templates[label] : {};
  return {
    subject: String(template.subject || "").trim(),
    heading: String(template.heading || "").trim(),
    message: String(template.message || "").trim(),
    footer: String(template.footer || "").trim()
  };
}

function applyEmailTemplate(value = "", vars = {}) {
  return String(value || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    const next = vars[key];
    return next === undefined || next === null ? "" : String(next);
  });
}

function buildOrderEmail(order = {}, status = "Confirmed", db = {}) {
  const label = normalizeEmailStatus(status);
  const id = String(order.id || order.orderId || "");
  const total = Math.round(toNumber(order.total || order.finalAmount || order.amount || 0));
  const tracking = String(order.awb || order.trackingId || order.awbCode || "").trim();
  const courier = String(order.courierName || order.courier_name || "").trim();
  const items = (Array.isArray(order.items) ? order.items : []).map((item) => {
    const qty = Math.max(1, Math.round(toNumber(item.qty || item.quantity || 1)));
    const size = String(item.size || item.productSize || item.selectedSize || item.variant || item.weight || item.packSize || item.unit || "").trim();
    return `${item.name || "Swadra Product"}${size ? " (" + size + ")" : ""} x ${qty}`;
  });
  const subjectMap = {
    Confirmed: `Order confirmed - ${id}`,
    Packed: `Order packed - ${id}`,
    Dispatched: `Order dispatched - ${id}`,
    "Out for Delivery": `Order out for delivery - ${id}`,
    Delivered: `Order delivered - ${id}`,
    Cancelled: `Order cancelled - ${id}`,
    Refund: `Refund update - ${id}`
  };
  const template = getEmailTemplateConfig(db, label);
  const vars = {
    customerName: pickOrderName(order),
    orderId: id,
    status: label,
    total: total ? `₹${total}` : "",
    trackingId: tracking,
    courier,
    brandName: "Swadra Organics"
  };
  const subject = applyEmailTemplate(template.subject, vars) || subjectMap[label] || `Order update - ${id}`;
  const customMessage = applyEmailTemplate(template.message, vars);
  const footer = applyEmailTemplate(template.footer, vars) || "Thank you for shopping with Swadra Organics.";
  const text = [
    `Hello ${pickOrderName(order)},`,
    "",
    customMessage || `Your Swadra Organics order status is: ${label}`,
    `Order ID: ${id}`,
    total ? `Total: ₹${total}` : "",
    tracking ? `Tracking ID: ${tracking}` : "",
    courier ? `Courier: ${courier}` : "",
    items.length ? "" : "",
    items.length ? "Items:" : "",
    ...items.map((item) => `- ${item}`),
    "",
    footer
  ].filter((line, index, arr) => line !== "" || arr[index - 1] !== "").join("\n");
  const htmlItems = items.length ? `<ul>${items.map((item) => `<li>${escapeHtmlForEmail(item)}</li>`).join("")}</ul>` : "";
  const html = `
    <div style="font-family:Arial,sans-serif;color:#222;line-height:1.6">
      <h2 style="color:#7a3d3d;margin:0 0 12px">${escapeHtmlForEmail(applyEmailTemplate(template.heading, vars) || "Swadra Organics Order Update")}</h2>
      <p>Hello ${escapeHtmlForEmail(pickOrderName(order))},</p>
      <p>${escapeHtmlForEmail(customMessage || "Your order status is")} <strong>${escapeHtmlForEmail(label)}</strong>.</p>
      <p><strong>Order ID:</strong> ${escapeHtmlForEmail(id)}<br>
      ${total ? `<strong>Total:</strong> ₹${total}<br>` : ""}
      ${tracking ? `<strong>Tracking ID:</strong> ${escapeHtmlForEmail(tracking)}<br>` : ""}
      ${courier ? `<strong>Courier:</strong> ${escapeHtmlForEmail(courier)}<br>` : ""}</p>
      ${htmlItems}
      <p>${escapeHtmlForEmail(footer)}</p>
    </div>
  `;
  return { subject, text, html };
}

function escapeHtmlForEmail(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resendRequest(apiKey, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.resend.com",
      path: "/emails",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (response) => {
      let data = "";
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => {
        let parsed = data;
        try { parsed = JSON.parse(data || "{}"); } catch (error) {}
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, statusCode: response.statusCode, data: parsed });
      });
    });
    req.on("error", (error) => resolve({ ok: false, statusCode: 0, data: { message: error.message } }));
    req.write(body);
    req.end();
  });
}

async function sendOrderEmail(db, order, status, reason = "") {
  const to = pickOrderEmail(order);
  if (!to) return { ok: false, skipped: true, reason: "missing-recipient" };
  const config = getEmailConfig(db);
  if (!config.resendApiKey) return { ok: false, skipped: true, reason: "missing-resend-key" };
  const content = buildOrderEmail(order, status, db);
  const response = await resendRequest(config.resendApiKey, {
    from: config.fromEmail,
    to: [to],
    ...(config.replyTo ? { reply_to: config.replyTo } : {}),
    subject: content.subject,
    text: content.text,
    html: content.html
  });
  if (!response.ok) {
    addLog(`Order email failed for ${order.id || "unknown"} ${status}: ${JSON.stringify(response.data).slice(0, 220)}`, "error");
  } else {
    addLog(`Order email sent for ${order.id || "unknown"} ${status}${reason ? " (" + reason + ")" : ""}`, "success");
  }
  return response;
}

function shouldTriggerOpsAlert(message = "", level = "info") {
  const text = String(message || "").toLowerCase();
  if (level === "error") return true;
  return [
    "otp",
    "payment verification failed",
    "payment verify blocked",
    "razorpay webhook failed",
    "shiprocket webhook failed",
    "refund failed",
    "coupon save failed"
  ].some((token) => text.includes(token));
}

async function sendOpsAlert(db, message, level = "error") {
  const appState = db.appState && typeof db.appState === "object" ? db.appState : {};
  const toEmail = String(process.env.ALERT_EMAIL || appState.alertEmail || "").trim().toLowerCase();
  if (!toEmail) return { ok: false, skipped: true, reason: "missing-alert-email" };
  const config = getEmailConfig(db);
  if (!config.resendApiKey) return { ok: false, skipped: true, reason: "missing-resend-key" };
  const subject = `[Swadra Alert] ${String(level || "error").toUpperCase()} ${new Date().toISOString()}`;
  const text = `Backend alert\nLevel: ${level}\nTime: ${new Date().toISOString()}\nMessage: ${message}`;
  return resendRequest(config.resendApiKey, {
    from: config.fromEmail,
    to: [toEmail],
    ...(config.replyTo ? { reply_to: config.replyTo } : {}),
    subject,
    text,
    html: `<pre style="font-family:ui-monospace,Consolas,monospace">${escapeHtmlForEmail(text)}</pre>`
  });
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

function makeWebsiteOrderIdForDate(date = new Date(), sequence = 1) {
  const safeDate = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const key = safeDate.toISOString().slice(2, 10).replace(/-/g, "");
  return "SWO" + key + String(Math.max(1, sequence)).padStart(3, "0");
}

function getNextWebsiteOrderId(db = {}, date = new Date()) {
  const key = (date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()).toISOString().slice(2, 10).replace(/-/g, "");
  const prefix = "SWO" + key;
  const ids = []
    .concat(Array.isArray(db.orders) ? db.orders : [])
    .concat(Array.isArray(db.paymentAttempts) ? db.paymentAttempts : [])
    .map((item) => String(item?.id || item?.orderId || item?.localOrderId || item?.createdOrderId || ""))
    .filter((id) => id.startsWith(prefix));
  const max = ids.reduce((highest, id) => {
    const numeric = Number(id.slice(prefix.length));
    return Number.isFinite(numeric) ? Math.max(highest, numeric) : highest;
  }, 0);
  return makeWebsiteOrderIdForDate(date, max + 1);
}

function hashPayload(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload || {}))
    .digest("hex");
}

function getRazorpayKeyId() {
  return String(
    process.env.RAZORPAY_KEY_ID ||
    process.env.RAZORPAY_KEY ||
    process.env.RAZORPAY_ID ||
    process.env.RAZORPAY_KEYID ||
    process.env.RAZORPAY_API_KEY ||
    process.env.RZP_KEY_ID ||
    process.env.RZP_KEY ||
    process.env.KEY_ID ||
    process.env.key_id ||
    ""
  ).trim();
}

function getRazorpaySecret() {
  return String(
    process.env.RAZORPAY_KEY_SECRET ||
    process.env.RAZOR_KEY_SECRET ||
    process.env.RAZORPAY_SECRET ||
    process.env.RAZORPAY_KEYSECRET ||
    process.env.RAZORPAY_API_SECRET ||
    process.env.RZP_KEY_SECRET ||
    process.env.RZP_SECRET ||
    process.env.KEY_SECRET ||
    process.env.key_secret ||
    ""
  ).trim();
}

function isRazorpayConfigured() {
  return Boolean(getRazorpayKeyId() && getRazorpaySecret());
}

function verifyRazorpaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  const secret = getRazorpaySecret();
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

function verifyRazorpayWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || getRazorpaySecret();
  if (!secret) {
    return {
      verified: false,
      configured: false,
      message: "RAZORPAY_WEBHOOK_SECRET is not configured"
    };
  }
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = String(signature || "").trim();
  const verified = Boolean(
    received &&
    expected.length === received.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))
  );
  return {
    verified,
    configured: true,
    message: verified ? "Razorpay webhook verified" : "Invalid Razorpay webhook signature"
  };
}

function getRazorpayWebhookEntity(payload = {}, type = "payment") {
  return payload?.payload?.[type]?.entity || payload?.[type] || payload?.entity || {};
}

function findPaymentAttemptIndexByRazorpay(db = {}, fields = {}) {
  const attempts = Array.isArray(db.paymentAttempts) ? db.paymentAttempts : [];
  const orderId = String(fields.orderId || "").trim();
  const paymentId = String(fields.paymentId || "").trim();
  const refundId = String(fields.refundId || "").trim();
  return attempts.findIndex((attempt) => {
    const ids = [
      attempt.id,
      attempt.localOrderId,
      attempt.orderId,
      attempt.razorpayOrderId,
      attempt.razorpayPaymentId,
      attempt.paymentId,
      attempt.refundId,
      attempt.razorpayRefundId,
      attempt.snapshot?.orderId,
      attempt.snapshot?.id,
      attempt.snapshot?.localOrderId
    ].map((value) => String(value || "").trim()).filter(Boolean);
    return Boolean(
      (orderId && ids.includes(orderId)) ||
      (paymentId && ids.includes(paymentId)) ||
      (refundId && ids.includes(refundId))
    );
  });
}

function findOrderIndexByRazorpay(db = {}, fields = {}) {
  const orderId = String(fields.orderId || "").trim();
  const paymentId = String(fields.paymentId || "").trim();
  const refundId = String(fields.refundId || "").trim();
  return findOrderIndex(db, (order) => {
    const ids = [
      order.id,
      order.orderId,
      order.localOrderId,
      order.razorpayOrderId,
      order.paymentOrderId,
      order.razorpayPaymentId,
      order.paymentId,
      order.refundId,
      order.razorpayRefundId
    ].map((value) => String(value || "").trim()).filter(Boolean);
    return Boolean(
      (orderId && ids.includes(orderId)) ||
      (paymentId && ids.includes(paymentId)) ||
      (refundId && ids.includes(refundId))
    );
  });
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
  const normalizedItems = normalizeCartItems(input.items || input.products || input.cartItems || []);
  return {
    ...input,
    id,
    userId: String(input.userId || input.user || input.email || ""),
    items: normalizedItems,
    total: toNumber(input.finalAmount || input.payableAmount || input.total || input.amount || input.paidAmount),
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

function getOrderCustomerKeys(order = {}) {
  const shipping = order.shipping && typeof order.shipping === "object" ? order.shipping : {};
  const email = normalizeAccountEmail(
    order.customerEmail ||
    order.email ||
    order.userEmail ||
    order.userId ||
    shipping.email ||
    ""
  );
  const phone = normalizeAccountPhone(
    order.customerPhone ||
    order.phone ||
    order.mobile ||
    shipping.phone ||
    shipping.mobile ||
    ""
  );
  return { email, phone };
}

async function mirrorOrderToCustomerProfile(db, order = {}) {
  if (!db || !order || typeof order !== "object") return null;
  const { email, phone } = getOrderCustomerKeys(order);
  if (!email) return null;
  db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};
  const users = db.appState.users && typeof db.appState.users === "object" ? db.appState.users : {};
  const existing = users[email] && typeof users[email] === "object" ? users[email] : {};
  const shipping = order.shipping && typeof order.shipping === "object" ? order.shipping : {};
  const orderId = String(order.id || order.orderId || "");
  const nextOrders = Array.isArray(existing.orders) ? existing.orders.slice() : [];
  const orderIndex = nextOrders.findIndex((item) => String(item?.id || item?.orderId || "") === orderId);
  if (orderIndex > -1) nextOrders[orderIndex] = { ...nextOrders[orderIndex], ...order };
  else nextOrders.unshift(order);

  const nextPayments = Array.isArray(existing.payments) ? existing.payments.slice() : [];
  const payment = {
    id: String(order.payment_id || order.paymentId || order.razorpayPaymentId || orderId),
    paymentId: String(order.payment_id || order.paymentId || order.razorpayPaymentId || ""),
    orderId,
    email,
    phone,
    amount: toNumber(order.total || order.finalAmount || order.amount || 0),
    status: String(order.paymentStatus || order.payment || "Paid Successfully"),
    method: String(order.paymentMethod || order.paymentInstrumentLabel || "online"),
    razorpayOrderId: String(order.razorpay_order_id || order.razorpayOrderId || ""),
    createdAt: order.paymentCompletedAt || order.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const paymentIndex = nextPayments.findIndex((item) => String(item?.id || item?.paymentId || item?.orderId || "") === String(payment.id || payment.orderId));
  if (paymentIndex > -1) nextPayments[paymentIndex] = { ...nextPayments[paymentIndex], ...payment };
  else nextPayments.unshift(payment);

  const address = {
    ...(existing.address || {}),
    ...(shipping || {})
  };
  const nextUser = {
    ...existing,
    id: existing.id || existing.uid || existing.userId || email,
    userId: existing.userId || existing.uid || existing.id || email,
    uid: existing.uid || existing.userId || existing.id || email,
    email,
    emailNormalized: email,
    phone: existing.phone || phone,
    phoneNormalized: normalizeAccountPhone(existing.phone || phone),
    profile: {
      ...(existing.profile || {}),
      email,
      phone: existing.profile?.phone || existing.phone || phone,
      name: existing.profile?.name || shipping.name || order.name || email.split("@")[0]
    },
    address,
    addresses: Array.isArray(existing.addresses) && existing.addresses.length ? existing.addresses : (address && (address.house || address.address) ? [{ ...address, id: address.id || "addr_order_" + orderId }] : []),
    defaultAddressId: existing.defaultAddressId || (address && (address.house || address.address) ? (address.id || "addr_order_" + orderId) : ""),
    orders: nextOrders.slice(0, 300),
    payments: nextPayments.slice(0, 300),
    updatedAt: new Date().toISOString()
  };
  users[email] = nextUser;
  db.appState.users = users;
  await writeTopLevelUsers({ [email]: nextUser }).catch((error) => {
    addLog("Order customer profile mirror skipped: " + error.message, "warn");
  });
  return nextUser;
}

function getPaymentAttemptAmountRupees(attempt = {}) {
  if (attempt.amountPaise !== undefined && attempt.amountPaise !== null) {
    return Math.round(toNumber(attempt.amountPaise) / 100);
  }
  return Math.round(toNumber(attempt.amount || attempt.snapshot?.amount || attempt.snapshot?.totals?.finalTotal || 0));
}

function paymentAttemptLooksPaid(attempt = {}) {
  const status = String(attempt.status || attempt.paymentStatus || attempt.detail?.status || "").toLowerCase();
  return status.includes("paid") || status.includes("captured") || status.includes("success");
}

function orderFromPaidPaymentAttempt(attempt = {}) {
  if (!paymentAttemptLooksPaid(attempt)) return null;
  const id = String(attempt.createdOrderId || attempt.orderId || attempt.localOrderId || attempt.id || "").trim();
  if (!id) return null;
  const snapshot = attempt.snapshot && typeof attempt.snapshot === "object" ? attempt.snapshot : {};
  const checkoutData = attempt.checkoutData && typeof attempt.checkoutData === "object"
    ? attempt.checkoutData
    : (snapshot.checkoutData && typeof snapshot.checkoutData === "object" ? snapshot.checkoutData : {});
  const email = normalizeAccountEmail(attempt.email || attempt.customerEmail || attempt.user || snapshot.user || checkoutData.email || "");
  const phone = normalizeAccountPhone(attempt.phone || attempt.customerPhone || checkoutData.phone || snapshot.phone || "");
  const paymentId = String(attempt.payment_id || attempt.paymentId || attempt.razorpayPaymentId || attempt.detail?.paymentId || attempt.detail?.razorpay_payment_id || "").trim();
  const total = getPaymentAttemptAmountRupees(attempt);
  return normalizeOrderForDb({
    id,
    userId: email || String(attempt.user || ""),
    email,
    customerEmail: email,
    phone,
    customerPhone: phone,
    items: normalizeCartItems(attempt.items || snapshot.cart || snapshot.items || attempt.cart || []),
    total,
    amount: total,
    finalAmount: total,
    shipping: checkoutData,
    payment: "Paid Successfully",
    paymentStatus: "Paid Successfully",
    payment_id: paymentId,
    razorpayPaymentId: paymentId,
    razorpay_order_id: attempt.razorpayOrderId || attempt.razorpay_order_id || "",
    paymentMethod: attempt.paymentInstrument?.method || attempt.method || "online",
    paymentInstrument: attempt.paymentInstrument || null,
    status: "Confirmed",
    statusHistory: [{ status: "Confirmed", time: attempt.updatedAt || attempt.createdAt || new Date().toISOString(), note: "Recovered from paid payment record." }],
    recoveredFromPaymentAttempt: true,
    source: "paymentAttempts",
    date: attempt.updatedAt || attempt.createdAt || new Date().toISOString(),
    createdAt: attempt.updatedAt || attempt.createdAt || new Date().toISOString()
  });
}

function mergeRecoveredPaidAttemptOrders(orders = [], attempts = []) {
  const merged = Array.isArray(orders) ? orders.slice() : [];
  const ids = new Set(merged.map((order) => String(order?.id || order?.orderId || "").trim()).filter(Boolean));
  (Array.isArray(attempts) ? attempts : []).forEach((attempt) => {
    const order = orderFromPaidPaymentAttempt(attempt);
    if (!order) return;
    const id = String(order.id || "").trim();
    if (!id || ids.has(id)) return;
    ids.add(id);
    merged.unshift(order);
  });
  return merged;
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
    units: Math.max(1, Math.round(toNumber(item.quantity || item.qty || item.count || 1))),
    selling_price: Math.max(1, Math.round(toNumber(item.discountedUnitPrice || item.finalUnitPrice || item.couponUnitPrice || item.displayPrice || item.price || 1)))
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
    shipping_charges: toNumber(order.deliveryCharge || order.delivery || order.shippingFee || 0),
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: toNumber(order.couponDiscount || order.discount || 0),
    sub_total: Math.max(1, Math.round(toNumber(order.finalAmount || order.payableAmount || order.total || order.amount || order.paidAmount || 1))),
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

  if (!assigned.ok) {
    return {
      ok: false,
      step: "assign-awb",
      error: assigned.data?.message || assigned.data?.error || "Shiprocket AWB assignment failed",
      raw: assigned.data,
      created: created.data
    };
  }

  let label = { ok: false, data: {} };
  if (shipmentId) {
    label = await shiprocketRequest({
      method: "POST",
      path: "/v1/external/courier/generate/label",
      token: auth.token,
      body: { shipment_id: [shipmentId] }
    });
  }

  const shipment = extractShiprocketShipment(created, assigned);
  return {
    ok: true,
    createPayload,
    created: created.data,
    assigned: assigned.data,
    label: label.data,
    labelError: label.ok ? "" : (label.data?.message || label.data?.error || "Shiprocket label generation failed"),
    shipment
  };
}

function ensureReturnWorkflow(db = {}) {
  db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};
  db.appState.returnRequests = Array.isArray(db.appState.returnRequests) ? db.appState.returnRequests : [];
  return db.appState.returnRequests;
}

function normalizeReturnRequest(input = {}, order = {}) {
  const now = new Date().toISOString();
  return {
    id: String(input.id || "ret_" + Date.now() + "_" + Math.floor(Math.random() * 1000)),
    orderId: String(input.orderId || order.id || ""),
    userId: String(input.userId || order.userId || order.email || ""),
    type: String(input.type || "Return").trim(),
    reason: String(input.reason || input.note || "Customer requested return/refund support.").trim().slice(0, 500),
    status: String(input.status || "Requested").trim(),
    requestedAmount: Math.round(toNumber(input.requestedAmount || order.finalAmount || order.total || order.amount || 0)),
    createdAt: input.createdAt || now,
    updatedAt: now,
    history: Array.isArray(input.history) && input.history.length
      ? input.history
      : [{ status: "Requested", time: now, note: "Customer submitted return/refund request." }]
  };
}

function ensureAbandonedCarts(db = {}) {
  db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};
  db.appState.abandonedCarts = Array.isArray(db.appState.abandonedCarts) ? db.appState.abandonedCarts : [];
  return db.appState.abandonedCarts;
}

function normalizeAbandonedCart(input = {}, existing = {}) {
  const now = new Date().toISOString();
  const items = Array.isArray(input.items || input.cartItems || input.cart) ? (input.items || input.cartItems || input.cart) : [];
  const summary = input.summary && typeof input.summary === "object" ? input.summary : {};
  const email = String(input.email || input.userId || input.user || existing.email || existing.userId || "").trim().toLowerCase();
  const status = String(input.status || existing.status || "open").trim() || "open";
  const idSource = input.id || input.cartId || existing.id || email || input.phone || Date.now();
  return {
    ...existing,
    id: String(idSource).replace(/[^a-z0-9_.@-]/gi, "_").slice(0, 120),
    userId: String(input.userId || input.user || existing.userId || email || "").trim().toLowerCase(),
    email,
    phone: String(input.phone || existing.phone || "").trim(),
    name: String(input.name || existing.name || "").trim(),
    pincode: String(input.pincode || summary.pincode || existing.pincode || "").trim(),
    postoffice: String(input.postoffice || input.postOffice || existing.postoffice || "").trim(),
    status,
    source: String(input.source || existing.source || "cart").trim(),
    items: items.map((item) => ({
      id: String(item.id || item.productId || item.sku || "").trim(),
      productId: String(item.productId || item.id || item.sku || "").trim(),
      name: String(item.name || item.title || "Swadra Product").trim(),
      size: String(item.size || item.productSize || item.variant || "").trim(),
      qty: getItemQty(item),
      price: Math.round(toNumber(item.price || item.sellingPrice || item.discountedUnitPrice || 0)),
      image: String(item.image || item.productImage || "").trim()
    })).filter((item) => item.name || item.id || item.productId),
    totals: {
      subtotal: Math.round(toNumber(summary.sellingTotal || input.subtotal || 0)),
      discount: Math.round(toNumber(summary.couponDiscount || input.discount || 0)),
      delivery: Math.round(toNumber(summary.delivery || input.delivery || 0)),
      total: Math.round(toNumber(summary.finalTotal || input.total || 0))
    },
    checkoutUrl: String(input.checkoutUrl || existing.checkoutUrl || "/cart.html").trim(),
    reminderCount: Math.max(0, Math.round(toNumber(existing.reminderCount || input.reminderCount || 0))),
    lastReminderAt: existing.lastReminderAt || input.lastReminderAt || "",
    createdAt: existing.createdAt || input.createdAt || now,
    updatedAt: now,
    history: Array.isArray(existing.history) && existing.history.length
      ? existing.history
      : [{ status, time: now, note: "Cart recovery tracking started." }]
  };
}

function findAbandonedCartIndex(carts = [], input = {}) {
  const keys = [input.id, input.cartId, input.userId, input.user, input.email]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (!keys.length) return -1;
  return carts.findIndex((cart) => {
    const cartKeys = [cart.id, cart.userId, cart.email]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    return cartKeys.some((key) => keys.includes(key));
  });
}

async function sendAbandonedCartEmail(db = {}, cart = {}) {
  const config = getEmailConfig(db);
  const to = String(cart.email || "").trim().toLowerCase();
  if (!to) return { ok: false, skipped: true, reason: "missing-email" };
  if (!config.resendApiKey) return { ok: false, skipped: true, reason: "missing-resend-key" };
  const itemLines = (Array.isArray(cart.items) ? cart.items : []).slice(0, 6).map((item) => {
    return `- ${item.name || "Swadra Product"} x ${item.qty || 1}`;
  }).join("\n");
  const total = Math.round(toNumber(cart.totals?.total || 0));
  return resendRequest(config.resendApiKey, {
    from: config.fromEmail,
    to: [to],
    reply_to: config.replyTo || undefined,
    subject: "Your Swadra cart is waiting",
    text: [
      `Hi ${cart.name || "there"},`,
      "",
      "You left these Swadra products in your cart:",
      itemLines || "- Your selected Swadra products",
      "",
      total ? `Cart total: Rs. ${total}` : "",
      "Complete your order here: https://swadraorganics.com/cart.html",
      "",
      "If you already placed the order, please ignore this message."
    ].filter(Boolean).join("\n"),
    html: `<p>Hi ${escapeHtmlForEmail(cart.name || "there")},</p><p>You left these Swadra products in your cart.</p><ul>${(Array.isArray(cart.items) ? cart.items : []).slice(0, 6).map((item) => `<li>${escapeHtmlForEmail(item.name || "Swadra Product")} x ${escapeHtmlForEmail(item.qty || 1)}</li>`).join("")}</ul>${total ? `<p><strong>Cart total:</strong> Rs. ${total}</p>` : ""}<p><a href="https://swadraorganics.com/cart.html">Complete your order</a></p>`
  });
}

const INVENTORY_LOCK_TTL_MS = 15 * 60 * 1000;

function getInventoryKey(item = {}) {
  const productId = String(item.productId || item.id || item.sku || item.name || "").trim().toLowerCase();
  const variant = String(item.size || item.productSize || item.variant || "").trim().toLowerCase();
  if (!productId) return "";
  return `${productId}::${variant}`;
}

function getItemQty(item = {}) {
  return Math.max(1, Math.round(toNumber(item.quantity || item.qty || item.count || 1)));
}

function getItemStock(item = {}) {
  const raw = item.stockQty ?? item.stock ?? item.availableStock;
  if (raw === undefined || raw === null || raw === "") return null;
  return Math.max(0, Math.round(toNumber(raw)));
}

function cleanupInventoryLocks(db = {}) {
  const now = Date.now();
  const locks = Array.isArray(db.appState?.inventoryLocks) ? db.appState.inventoryLocks : [];
  db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};
  db.appState.inventoryLocks = locks.filter((lock) => {
    const isActive = String(lock.status || "reserved") === "reserved";
    const expiresAt = Date.parse(lock.expiresAt || "");
    return !(isActive && expiresAt && expiresAt < now);
  });
}

function getReservedQty(db = {}, inventoryKey = "") {
  if (!inventoryKey) return 0;
  const locks = Array.isArray(db.appState?.inventoryLocks) ? db.appState.inventoryLocks : [];
  return locks
    .filter((lock) => String(lock.status || "reserved") === "reserved" && String(lock.inventoryKey) === inventoryKey)
    .reduce((sum, lock) => sum + Math.max(0, Math.round(toNumber(lock.qty))), 0);
}

function releaseInventoryLock(db = {}, orderId = "", status = "released") {
  const locks = Array.isArray(db.appState?.inventoryLocks) ? db.appState.inventoryLocks : [];
  db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};
  db.appState.inventoryLocks = locks.map((lock) => {
    if (String(lock.orderId) !== String(orderId)) return lock;
    if (String(lock.status || "") !== "reserved") return lock;
    return { ...lock, status, releasedAt: new Date().toISOString() };
  });
}

function pickInventoryLockOrderId(attempt = {}, fallback = "") {
  return String(
    attempt.id ||
    attempt.localOrderId ||
    attempt.orderId ||
    attempt.snapshot?.orderId ||
    attempt.snapshot?.id ||
    attempt.snapshot?.localOrderId ||
    fallback ||
    ""
  ).trim();
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
  const keyId = getRazorpayKeyId();
  const secret = getRazorpaySecret();

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

function razorpayApiRequest({ method = "GET", path: requestPath, body = null }) {
  const keyId = getRazorpayKeyId();
  const secret = getRazorpaySecret();

  if (!keyId || !secret) {
    return Promise.resolve({
      ok: false,
      configured: false,
      data: null,
      message: "Razorpay backend credentials are not configured"
    });
  }

  const payload = body ? JSON.stringify(body) : "";

  return new Promise((resolve) => {
    const request = https.request(
      {
        hostname: "api.razorpay.com",
        path: requestPath,
        method,
        auth: `${keyId}:${secret}`,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
        },
        timeout: 15000
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          let parsed = {};
          try {
            parsed = JSON.parse(raw || "{}");
          } catch (error) {
            parsed = { raw };
          }
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            configured: true,
            data: parsed,
            message: parsed.error?.description || parsed.error?.reason || "Razorpay API response"
          });
        });
      }
    );

    request.on("error", (error) => {
      resolve({
        ok: false,
        configured: true,
        data: null,
        message: error.message
      });
    });

    request.on("timeout", () => {
      request.destroy();
      resolve({
        ok: false,
        configured: true,
        data: null,
        message: "Razorpay API request timed out"
      });
    });

    if (payload) request.write(payload);
    request.end();
  });
}

async function fetchRazorpayPaymentDetails(paymentId) {
  const normalizedId = String(paymentId || "").trim();
  if (!normalizedId) {
    return {
      ok: false,
      configured: isRazorpayConfigured(),
      payment: null,
      instrument: null,
      message: "Razorpay payment ID is required"
    };
  }

  const paymentResponse = await razorpayApiRequest({
    method: "GET",
    path: "/v1/payments/" + encodeURIComponent(normalizedId)
  });

  const payment = paymentResponse.data || null;
  const instrument = payment
    ? {
        method: String(payment.method || "").trim(),
        vpa: String(payment.vpa || payment.acquirer_data?.vpa || "").trim(),
        bank: String(payment.bank || payment.acquirer_data?.bank || "").trim(),
        wallet: String(payment.wallet || "").trim(),
        cardId: String(payment.card_id || "").trim(),
        network: String(payment.card?.network || payment.network || "").trim(),
        last4: String(payment.card?.last4 || "").trim(),
        issuer: String(payment.card?.issuer || "").trim(),
        cardType: String(payment.card?.type || "").trim(),
        email: String(payment.email || "").trim(),
        contact: String(payment.contact || "").trim(),
        status: String(payment.status || "").trim()
      }
    : null;

  return {
    ok: paymentResponse.ok,
    configured: paymentResponse.configured,
    payment,
    instrument,
    message: paymentResponse.message
  };
}

async function fetchRazorpayPayments({ from, to, count = 100, skip = 0 } = {}) {
  const query = new URLSearchParams();
  if (from) query.set("from", String(from));
  if (to) query.set("to", String(to));
  query.set("count", String(Math.max(1, Math.min(100, Math.round(toNumber(count) || 100)))));
  query.set("skip", String(Math.max(0, Math.round(toNumber(skip) || 0))));
  const response = await razorpayApiRequest({
    method: "GET",
    path: "/v1/payments?" + query.toString()
  });
  const items = Array.isArray(response.data?.items) ? response.data.items : [];
  return {
    ok: response.ok,
    configured: response.configured,
    payments: items,
    count: items.length,
    message: response.message
  };
}

function getDateKeyFromUnixSeconds(value) {
  const date = value ? new Date(Number(value) * 1000) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(2, 10).replace(/-/g, "");
  return date.toISOString().slice(2, 10).replace(/-/g, "");
}

function getNextRecoveredOrderId(existingOrders = [], dateKey = "") {
  const key = String(dateKey || new Date().toISOString().slice(2, 10).replace(/-/g, "")).replace(/\D/g, "").slice(0, 6);
  const prefix = "SWO" + key;
  const max = (Array.isArray(existingOrders) ? existingOrders : []).reduce((highest, order) => {
    const id = String(order?.id || order?.orderId || "");
    if (!id.startsWith(prefix)) return highest;
    const number = Number(id.slice(prefix.length));
    return Number.isFinite(number) ? Math.max(highest, number) : highest;
  }, 0);
  return prefix + String(max + 1).padStart(3, "0");
}

function razorpayPaymentLooksPaid(payment = {}) {
  const status = String(payment.status || "").toLowerCase();
  return status === "captured" || status === "paid" || payment.captured === true;
}

function buildRecoveredOrderFromRazorpayPayment(payment = {}, existingOrders = [], fallbackEmail = "") {
  if (!razorpayPaymentLooksPaid(payment)) return null;
  const notes = payment.notes && typeof payment.notes === "object" ? payment.notes : {};
  const email = normalizeAccountEmail(payment.email || notes.email || notes.customer_email || fallbackEmail || "");
  if (!email) return null;
  const phone = normalizeAccountPhone(payment.contact || notes.phone || notes.mobile || notes.delivery_phone || "");
  const dateKey = getDateKeyFromUnixSeconds(payment.created_at);
  const orderId = String(
    notes.local_order_id ||
    notes.localOrderId ||
    notes.order_id ||
    notes.orderId ||
    payment.notes?.createdOrderId ||
    ""
  ).trim() || getNextRecoveredOrderId(existingOrders, dateKey);
  const amount = Math.round(toNumber(payment.amount) / 100);
  const createdAt = payment.created_at ? new Date(Number(payment.created_at) * 1000).toISOString() : new Date().toISOString();
  const name = String(notes.delivery_name || notes.name || email.split("@")[0] || "Customer").trim();
  const shipping = {
    name,
    email,
    phone,
    address: String(notes.delivery_address || notes.address || "").trim(),
    pincode: String(notes.pincode || notes.delivery_pincode || "").trim()
  };
  return normalizeOrderForDb({
    id: orderId,
    orderId,
    userId: email,
    email,
    customerEmail: email,
    phone,
    customerPhone: phone,
    items: [],
    total: amount,
    amount,
    finalAmount: amount,
    shipping,
    payment: "Paid Successfully",
    paymentStatus: "Paid Successfully",
    payment_id: payment.id || "",
    paymentId: payment.id || "",
    razorpayPaymentId: payment.id || "",
    razorpay_order_id: payment.order_id || "",
    razorpayOrderId: payment.order_id || "",
    paymentMethod: payment.method || "online",
    paymentInstrument: {
      method: payment.method || "",
      vpa: payment.vpa || payment.acquirer_data?.vpa || "",
      bank: payment.bank || payment.acquirer_data?.bank || "",
      status: payment.status || ""
    },
    status: "Confirmed",
    statusHistory: [{ status: "Confirmed", time: createdAt, note: "Recovered from captured Razorpay payment." }],
    recoveredFromRazorpay: true,
    source: "razorpayPayments",
    date: createdAt,
    createdAt,
    updatedAt: new Date().toISOString()
  });
}

async function recoverRecentRazorpayOrders(db, { days = 3, fallbackEmail = "" } = {}) {
  if (!isRazorpayConfigured()) return { ok: false, recovered: [], message: "Razorpay not configured" };
  const now = Math.floor(Date.now() / 1000);
  const from = now - Math.max(1, Math.min(30, Math.round(toNumber(days) || 3))) * 24 * 60 * 60;
  const response = await fetchRazorpayPayments({ from, to: now, count: 100 });
  if (!response.ok) return { ok: false, recovered: [], message: response.message };
  const existingOrders = mergeRecordsById(await readTopLevelFirestoreCollection("orders"), Array.isArray(db.orders) ? db.orders : []);
  const existingPaymentIds = new Set(existingOrders.map((order) => String(order?.razorpayPaymentId || order?.paymentId || order?.payment_id || "").trim()).filter(Boolean));
  const existingOrderIds = new Set(existingOrders.map((order) => String(order?.id || order?.orderId || "").trim()).filter(Boolean));
  const recovered = [];
  response.payments
    .filter(razorpayPaymentLooksPaid)
    .sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0))
    .forEach((payment) => {
      const paymentId = String(payment.id || "").trim();
      if (paymentId && existingPaymentIds.has(paymentId)) return;
      const order = buildRecoveredOrderFromRazorpayPayment(payment, [...existingOrders, ...recovered], fallbackEmail);
      if (!order) return;
      const orderId = String(order.id || order.orderId || "").trim();
      if (!orderId || existingOrderIds.has(orderId)) return;
      existingOrderIds.add(orderId);
      if (paymentId) existingPaymentIds.add(paymentId);
      recovered.push(order);
    });
  for (const order of recovered) {
    db.orders.unshift(order);
    db.paymentAttempts.unshift({
      id: order.id,
      orderId: order.id,
      createdOrderId: order.id,
      status: "paid",
      amount: order.total,
      email: order.email,
      customerEmail: order.customerEmail,
      phone: order.phone,
      customerPhone: order.customerPhone,
      items: order.items,
      checkoutData: order.shipping,
      razorpayPaymentId: order.razorpayPaymentId,
      razorpayOrderId: order.razorpayOrderId,
      paymentMethod: order.paymentMethod,
      paymentInstrument: order.paymentInstrument,
      source: "razorpayRecovery",
      createdAt: order.createdAt,
      updatedAt: new Date().toISOString()
    });
    await mirrorOrderToCustomerProfile(db, order);
    await writeTopLevelOrder(order).catch((error) => addLog("Recovered order mirror skipped: " + error.message, "warn"));
    await writeTopLevelPaymentAttempt(db.paymentAttempts[0]).catch((error) => addLog("Recovered payment mirror skipped: " + error.message, "warn"));
  }
  db.orders = db.orders.slice(0, 5000);
  db.paymentAttempts = db.paymentAttempts.slice(0, 1000);
  if (recovered.length) await writeDB(db);
  return { ok: true, recovered, scanned: response.count };
}

function pickRazorpayPaymentId(order = {}) {
  return String(
    order.razorpayPaymentId ||
    order.paymentId ||
    order.payment_id ||
    order.transactionId ||
    order.txnId ||
    order.detail?.razorpayPaymentId ||
    order.detail?.paymentId ||
    order.razorpay?.payment_id ||
    order.razorpay?.paymentId ||
    ""
  ).trim();
}

function findPaymentAttemptForOrder(db = {}, order = {}) {
  const attempts = Array.isArray(db.paymentAttempts) ? db.paymentAttempts : [];
  const ids = [
    order.id,
    order.orderId,
    order.localOrderId,
    order.razorpayOrderId,
    order.paymentOrderId
  ].map((item) => String(item || "").trim()).filter(Boolean);

  return attempts.find((attempt) => {
    const candidateIds = [
      attempt.id,
      attempt.localOrderId,
      attempt.orderId,
      attempt.razorpayOrderId,
      attempt.snapshot?.orderId,
      attempt.snapshot?.id,
      attempt.snapshot?.localOrderId
    ].map((item) => String(item || "").trim()).filter(Boolean);
    return candidateIds.some((candidate) => ids.includes(candidate));
  }) || null;
}

function mergePaymentAttemptIntoOrder(order = {}, attempt = null) {
  if (!attempt) return order;
  return {
    ...order,
    razorpayOrderId: order.razorpayOrderId || attempt.razorpayOrderId || "",
    razorpayPaymentId: order.razorpayPaymentId || attempt.razorpayPaymentId || "",
    paymentId: order.paymentId || attempt.razorpayPaymentId || attempt.paymentId || "",
    paymentInstrument: order.paymentInstrument || attempt.paymentInstrument || null,
    razorpayPaymentDetails: order.razorpayPaymentDetails || attempt.razorpayPaymentDetails || null
  };
}

async function createRazorpayRefundForOrder(order = {}) {
  const paymentId = pickRazorpayPaymentId(order);
  const amountRupees = Math.round(toNumber(order.refundAmount || order.finalAmount || order.payableAmount || order.total || order.amount || order.paidAmount || 0));

  if (order.refundId || order.razorpayRefundId) {
    return {
      ok: true,
      skipped: true,
      status: order.razorpayRefundStatus || order.refundStatus || "Refund Already Created",
      refund: null,
      message: "Refund already created"
    };
  }

  if (!paymentId) {
    return {
      ok: false,
      configured: isRazorpayConfigured(),
      status: "Refund Pending",
      refund: null,
      message: "Razorpay payment ID missing"
    };
  }

  if (amountRupees <= 0) {
    return {
      ok: false,
      configured: isRazorpayConfigured(),
      status: "Refund Pending",
      refund: null,
      message: "Refund amount missing"
    };
  }

  const response = await razorpayApiRequest({
    method: "POST",
    path: "/v1/payments/" + encodeURIComponent(paymentId) + "/refund",
    body: {
      amount: amountRupees * 100,
      speed: "normal",
      notes: {
        order_id: String(order.id || order.orderId || ""),
        reason: "Order cancelled"
      }
    }
  });

  const refund = response.data || {};
  const rawStatus = String(refund.status || "").trim();
  const status = response.ok
    ? (rawStatus ? "Razorpay " + rawStatus : "Razorpay Refund Created")
    : "Razorpay Refund Failed";

  return {
    ok: response.ok,
    configured: response.configured,
    status,
    refund,
    message: response.message
  };
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
    /₹\s*([0-9][0-9,]{1,8}(?:\.\d{1,2})?)/g,
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

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtmlToText(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function fetchUrlText(url) {
  return new Promise((resolve, reject) => {
    const target = String(url || "").trim();
    if (!/^https?:\/\//i.test(target)) {
      reject(new Error("Invalid URL"));
      return;
    }

    const client = target.startsWith("https://") ? https : http;
    const request = client.get(target, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "accept-language": "en-IN,en;q=0.9"
      },
      timeout: 25000
    }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirected = new URL(response.headers.location, target).toString();
        response.resume();
        fetchUrlText(redirected).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode && response.statusCode >= 400) {
        response.resume();
        reject(new Error("HTTP " + response.statusCode));
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve(stripHtmlToText(body));
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("Request timeout"));
    });
    request.on("error", reject);
  });
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

  const lowerUrl = cleanUrl.toLowerCase();
  const referencePrice = toNumber(product?.sellingPrice || product?.price || product?.mrp || 0);

  if (!browser) {
    try {
      const text = await fetchUrlText(cleanUrl);
      const chosen = chooseBestPrice(parseCurrencyCandidates(text), referencePrice);
      return {
        url: cleanUrl,
        price: chosen || 0,
        status: chosen > 0 ? "Fetched from HTML fallback" : "Price not detected in fallback"
      };
    } catch (error) {
      return {
        url: cleanUrl,
        price: 0,
        status: `Fallback failed: ${error.message}`
      };
    }
  }

  const page = await browser.newPage();

  try {
    await preparePage(page);
    await safeGoto(page, cleanUrl);

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
    try {
      const text = await fetchUrlText(cleanUrl);
      const chosen = chooseBestPrice(parseCurrencyCandidates(text), referencePrice);
      return {
        url: cleanUrl,
        price: chosen || 0,
        status: chosen > 0 ? `Fetched from HTML fallback after browser failure` : `Browser failed, fallback found no price`
      };
    } catch (fallbackError) {
      return {
        url: cleanUrl,
        price: 0,
        status: `Fetch failed: ${error.message}; fallback failed: ${fallbackError.message}`
      };
    }
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

app.get("/api/products", async (req, res) => {
  return productPersistenceDisabledResponse(res);
});

app.get("/api/logs", requireAdminSession, async (req, res) => {
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

app.post("/api/admin/login", authRateLimit, async (req, res) => {
  try {
    const db = await readDB();
    const state = ensureAdminSecurity(db);
    const username = String(req.body?.username || req.body?.email || "").trim();
    const password = String(req.body?.password || "");
    const passwordCheck = verifyAdminPassword(db, password);
    const success = username === db.admin.username && passwordCheck.ok;
    let session = null;
    if (success) {
      if (passwordCheck.legacy || !db.admin.passwordHash) {
        setAdminPasswordHash(db, password);
      }
      const now = new Date();
      session = {
        token: "",
        username,
        role: db.admin.role || "owner",
        expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString()
      };
      session.token = createSignedAdminToken(db, session);
      state.adminSessions = state.adminSessions.filter((item) => Date.parse(item.expiresAt || "") > Date.now()).slice(0, 20);
      state.adminSessions.unshift({
        tokenHash: hashAdminToken(session.token),
        username,
        role: session.role,
        status: "active",
        ip: clientIp(req),
        userAgent: String(req.get("user-agent") || "").slice(0, 180),
        createdAt: now.toISOString(),
        expiresAt: session.expiresAt
      });
    }
    auditAdminAction(db, req, "admin.login", success ? "success" : "failed", { username });
    await writeDB(db);
    addLog(`Admin login ${success ? "success" : "failed"} for ${username || "unknown"}`, success ? "success" : "warn");
    if (success && session && session.token) {
      setAdminSessionCookie(res, session.token, session.expiresAt);
    }
    res.status(success ? 200 : 401).json({
      ok: success,
      success,
      message: success ? "Login successful" : "Wrong credentials",
      redirectTo: success ? "admin-index.html" : "",
      session
    });
  } catch (error) {
    addLog("Admin login failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to login" });
  }
});

app.get("/api/admin/session", requireAdminSession, async (req, res) => {
  try {
    res.json({
      ok: true,
      session: {
        ok: true,
        username: req.adminSession?.username || "admin",
        role: req.adminSession?.role || "owner",
        expiresAt: req.adminSession?.expiresAt || ""
      }
    });
  } catch (error) {
    addLog("Admin session check failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to check admin session" });
  }
});

app.get("/api/account/session", async (req, res) => {
  try {
    const db = await readDB();
    const session = getCustomerSessionFromRequest(db, req);
    if (!session) {
      return res.status(401).json({ ok: false, error: "Customer session required" });
    }
    const email = normalizeAccountEmail(session.email || "");
    let record = null;
    if (email) {
      const users = db.appState?.users && typeof db.appState.users === "object" ? { ...db.appState.users } : {};
      const topUsers = await readTopLevelFirestoreCollection("users");
      topUsers.forEach((user) => {
        const userEmail = normalizeAccountEmail(user.email || user.emailNormalized || user.id || user.docId || "");
        if (userEmail) users[userEmail] = mergeAccountProfileRecord(user, users[userEmail] || {});
      });
      record = users[email] || null;
    }
    res.json({
      ok: true,
      session: {
        email,
        phone: normalizeAccountPhone(session.phone || ""),
        uid: String(session.uid || ""),
        expiresAt: session.expiresAt || ""
      },
      record
    });
  } catch (error) {
    addLog("Customer session fetch failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to fetch customer session" });
  }
});

app.post("/api/account/logout", async (req, res) => {
  try {
    const db = await readDB();
    const session = getCustomerSessionFromRequest(db, req);
    if (session?.email || session?.phone) {
      recordUserActivity(db, {
        type: "logout",
        email: session.email || "",
        phone: session.phone || "",
        status: "success",
        req
      });
      await writeDB(db).catch((error) => addLog("Customer logout activity save skipped: " + error.message, "warn"));
    }
    clearCustomerSessionCookie(res);
    res.json({ ok: true, loggedOut: true });
  } catch (error) {
    clearCustomerSessionCookie(res);
    res.json({ ok: true, loggedOut: true });
  }
});

app.get("/api/admin/audit", requireAdminSession, async (req, res) => {
  try {
    const db = await readDB();
    ensureAdminSecurity(db);
    res.json({ ok: true, audit: db.appState.adminAudit || [] });
  } catch (error) {
    addLog("Admin audit fetch failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to load admin audit" });
  }
});

app.get("/api/admin/user-activities", requireAdminSession, async (req, res) => {
  try {
    const db = await readDB();
    const email = normalizeAccountEmail(req.query?.email || "");
    const topActivities = await readTopLevelFirestoreCollection("userActivities");
    const activities = mergeRecordsById(
      topActivities,
      (Array.isArray(db.userActivities) ? db.userActivities : (Array.isArray(db.appState?.userActivities) ? db.appState.userActivities : []))
    )
      .filter((activity) => !email || normalizeAccountEmail(activity.email || activity.userId || "") === email)
      .sort((a, b) => Date.parse(b.createdAt || b.time || 0) - Date.parse(a.createdAt || a.time || 0))
      .slice(0, 500);
    res.json({ ok: true, count: activities.length, activities });
  } catch (error) {
    addLog("User activity fetch failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to load user activity" });
  }
});

app.post("/api/admin/logout", requireAdminSession, async (req, res) => {
  try {
    const db = await readDB();
    const revoked = revokeAdminSessionForRequest(db, req);
    auditAdminAction(db, req, "admin.logout", revoked ? "success" : "noop", { revoked });
    await writeDB(db);
    clearAdminSessionCookie(res);
    res.json({ ok: true, revoked });
  } catch (error) {
    addLog("Admin logout failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to logout" });
  }
});

app.post("/api/admin/logout-all", requireAdminSession, async (req, res) => {
  try {
    const db = await readDB();
    const state = ensureAdminSecurity(db);
    const now = new Date().toISOString();
    let count = 0;
    state.adminSessions = state.adminSessions.map((session) => {
      if (session && String(session.status || "active") === "active") {
        count += 1;
        return { ...session, status: "revoked", revokedAt: now };
      }
      return session;
    });
    auditAdminAction(db, req, "admin.logout-all", "success", { count });
    await writeDB(db);
    clearAdminSessionCookie(res);
    res.json({ ok: true, revoked: count });
  } catch (error) {
    addLog("Admin logout-all failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to revoke sessions" });
  }
});

app.get("/api/admin/backup/export", requireAdminSession, async (req, res) => {
  try {
    const db = await readDB();
    const includeSecrets = String(req.query.includeSecrets || "").toLowerCase() === "true";
    const payload = {
      exportedAt: new Date().toISOString(),
      version: "swadra-backup-v1",
      source: USE_FIRESTORE ? "firestore" : "file",
      data: includeSecrets ? cloneDB(db) : redactBackupSecrets(cloneDB(db))
    };
    auditAdminAction(db, req, "backup.export", "success", { includeSecrets });
    await writeDB(db);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="swadra-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (error) {
    addLog("Backup export failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to export backup" });
  }
});

app.get("/api/admin/reconciliation-reports", requireAdminSession, async (req, res) => {
  try {
    const db = await readDB();
    res.json({ ok: true, reports: ensureReconciliationReports(db) });
  } catch (error) {
    addLog("Reconciliation report fetch failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to fetch reconciliation reports" });
  }
});

app.post("/api/admin/reconciliation-reports", requireAdminSession, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
    const db = await readDB();
    const reports = ensureReconciliationReports(db);
    const report = buildReconciliationReport(db, {
      from: req.body?.from,
      to: req.body?.to,
      createdBy: req.adminSession?.username || "admin"
    });
    if (reports.some((item) => String(item.fingerprint || "") === report.fingerprint)) {
      return res.status(409).json({ ok: false, error: "Same reconciliation snapshot already exists" });
    }
    reports.unshift(report);
    db.appState.reconciliationReports = reports.slice(0, 365);
    auditAdminAction(db, req, "reconciliation.create", "success", { reportId: report.id, totals: report.totals });
    await writeDB(db);
    res.json({ ok: true, report });
  } catch (error) {
    addLog("Reconciliation report create failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to create reconciliation report" });
  }
});

app.post("/admin/login", async (req, res) => {
  req.url = "/api/admin/login";
  app._router.handle(req, res, () => {
    if (!res.headersSent) {
      res.status(404).json({ ok: false, error: "Admin login route unavailable" });
    }
  });
});

app.post("/api/admin/credentials", requireAdminSession, async (req, res) => {
  try {
    const db = await readDB();
    const username = String(req.body?.username || db.admin.username).trim();
    const password = String(req.body?.password || "");
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: "Username and password are required" });
    }
    db.admin = { ...db.admin, username, role: db.admin.role || "owner" };
    setAdminPasswordHash(db, password);
    const state = ensureAdminSecurity(db);
    const now = new Date().toISOString();
    state.adminSessions = state.adminSessions.map((session) => {
      return session && String(session.status || "active") === "active"
        ? { ...session, status: "revoked", revokedAt: now, revokeReason: "credentials_updated" }
        : session;
    });
    auditAdminAction(db, req, "admin.credentials.update", "success", { username });
    await writeDB(db);
    addLog("Admin credentials updated", "success");
    clearAdminSessionCookie(res);
    res.json({ ok: true, username, sessionsRevoked: true });
  } catch (error) {
    addLog("Admin credentials update failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to update credentials" });
  }
});

app.get("/api/coupons", async (req, res) => {
  try {
    const db = await readDB();
    const siteContent = await readTopLevelSiteContent();
    const topCoupons = Array.isArray(siteContent.coupons) ? siteContent.coupons : [];
    const coupons = mergeRecordsById(topCoupons, db.coupons).map((coupon) => normalizeCoupon(coupon)).slice(0, 50);
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

function getItemGstRate(item = {}) {
  const rate = toNumber(item.gstRate || item.gst || item.taxRate || 5);
  return rate > 0 ? rate : 5;
}

function calculateCartPricing({ items = [], couponCode = "", delivery = 0 } = {}, coupons = []) {
  const cart = normalizeCartItems(items);
  const rows = cart.map((item) => {
    const qty = getItemQty(item);
    const lineTotal = Math.round(toNumber(item.displayLineTotal || item.discountedLineTotal || item.price * qty));
    const mrpLineTotal = Math.round(toNumber(item.mrpLineTotal || item.originalLineTotal || (item.mrp || item.price) * qty));
    const gstRate = getItemGstRate(item);
    const baseAmount = Math.round(lineTotal / (1 + gstRate / 100));
    const gstAmount = Math.max(0, lineTotal - baseAmount);
    return { item, qty, lineTotal, mrpLineTotal, gstRate, baseAmount, gstAmount };
  });
  const productTotal = rows.reduce((sum, row) => sum + row.lineTotal, 0);
  const mrpTotal = rows.reduce((sum, row) => sum + row.mrpLineTotal, 0);
  const baseAmount = rows.reduce((sum, row) => sum + row.baseAmount, 0);
  const gst = rows.reduce((sum, row) => sum + row.gstAmount, 0);
  const code = String(couponCode || "").trim().toUpperCase();
  const coupon = code
    ? (Array.isArray(coupons) ? coupons : []).find((item) => item && item.status !== "inactive" && String(item.code || "").trim().toUpperCase() === code)
    : null;
  const minimum = Math.max(0, Math.round(toNumber(coupon?.minimumAmount || coupon?.minAmount || 0)));
  const couponValid = Boolean(coupon && (!minimum || productTotal >= minimum));
  const couponPercent = couponValid ? Math.max(0, toNumber(coupon.discount || 0)) : 0;
  const deliveryCharge = Math.max(0, Math.round(toNumber(delivery || 0)));
  const couponScope = couponValid ? String(coupon?.scope || "product_base") : "product_base";
  const couponBase = couponScope === "overall_with_delivery" ? Math.max(0, productTotal + deliveryCharge) : baseAmount;
  const couponDiscount = Math.min(couponBase, Math.round(couponBase * (couponPercent / 100)));
  const itemCouponDiscount = Math.min(baseAmount, couponDiscount);
  let remainingDiscount = itemCouponDiscount;
  const discountedItems = rows.map((row, index) => {
    const isLast = index === rows.length - 1;
    const lineDiscount = isLast ? remainingDiscount : Math.min(remainingDiscount, Math.round(itemCouponDiscount * (row.baseAmount / Math.max(1, baseAmount))));
    remainingDiscount -= lineDiscount;
    const discountedLineTotal = Math.max(0, row.lineTotal - lineDiscount);
    return {
      ...row.item,
      couponLineDiscount: lineDiscount,
      discountedLineTotal,
      displayLineTotal: discountedLineTotal,
      discountedUnitPrice: Math.round(discountedLineTotal / Math.max(1, row.qty))
    };
  });
  const finalTotal = Math.max(0, productTotal - couponDiscount + deliveryCharge);
  return {
    ok: true,
    mrpTotal,
    productTotal,
    sellingTotal: productTotal,
    baseAmount,
    gst,
    gstTotal: gst,
    couponCode: couponValid ? code : "",
    couponScope,
    couponBase,
    couponDiscount,
    couponValid,
    couponMessage: code && !couponValid ? (coupon ? "Minimum amount not met" : "Invalid coupon") : "",
    delivery: deliveryCharge,
    finalTotal,
    discountedItems
  };
}

app.post("/api/checkout/calculate", paymentRateLimit, async (req, res) => {
  try {
    const db = await readDB();
    const siteContent = await readTopLevelSiteContent();
    const coupons = mergeRecordsById(siteContent.coupons || [], db.coupons || []).map((coupon) => normalizeCoupon(coupon)).slice(0, 50);
    const result = calculateCartPricing({
      items: req.body?.items || req.body?.cart || [],
      couponCode: req.body?.couponCode || req.body?.coupon?.code || "",
      delivery: req.body?.delivery || req.body?.deliveryCharge || 0
    }, coupons);
    const email = normalizeAccountEmail(req.body?.email || req.body?.userId || "");
    if (email && result.couponCode) {
      recordUserActivity(db, { type: "coupon_applied", email, status: "success", details: { code: result.couponCode, discount: result.couponDiscount }, req });
      await writeDB(db).catch((error) => addLog("Coupon activity save skipped: " + error.message, "warn"));
    }
    res.json(result);
  } catch (error) {
    addLog("Checkout calculation failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to calculate checkout total" });
  }
});

async function buildAdminUsersMap() {
  const db = await readDB();
  const topUsers = await readTopLevelFirestoreCollection("users");
  const topCarts = await readTopLevelFirestoreCollection("carts");
  const cartsById = new Map();
  topCarts.forEach((cart) => {
    const ids = [
      cart.docId,
      cart.userId,
      cart.uid,
      cart.email
    ].map((value) => String(value || "").trim()).filter(Boolean);
    ids.forEach((id) => cartsById.set(id, Array.isArray(cart.items) ? cart.items : []));
  });
  const usersMap = { ...(db.appState?.users || {}) };
  topUsers.forEach((user) => {
    const email = String(user.email || user.id || user.docId || user.uid || "").trim().toLowerCase();
    if (!email) return;
    const existing = usersMap[email] || {};
    const cart =
      cartsById.get(String(user.uid || "")) ||
      cartsById.get(String(user.userId || "")) ||
      cartsById.get(String(user.id || "")) ||
      cartsById.get(String(user.docId || "")) ||
      cartsById.get(email) ||
      user.cart ||
      [];
    usersMap[email] = mergeAccountProfileRecord({
      ...user,
      email: user.email || email,
      cart
    }, existing);
  });
  const authUsers = await listFirebaseAuthAccountUsers();
  authUsers.forEach((user) => {
    const email = normalizeAccountEmail(user.email || "");
    if (!email) return;
    usersMap[email] = mergeAccountProfileRecord({
      ...user,
      cart: Array.isArray(usersMap[email]?.cart) && usersMap[email].cart.length ? usersMap[email].cart : (Array.isArray(user.cart) ? user.cart : [])
    }, usersMap[email] || {});
  });
  topCarts.forEach((cart) => {
    const email = normalizeAccountEmail(cart.email || "");
    if (!email || usersMap[email]) return;
    usersMap[email] = {
      id: cart.uid || cart.userId || email,
      userId: cart.uid || cart.userId || email,
      uid: cart.uid || cart.userId || "",
      email,
      emailNormalized: email,
      phone: "",
      phoneNormalized: "",
      profile: { email, phone: "", name: email.split("@")[0] },
      cart: Array.isArray(cart.items) ? cart.items : [],
      status: "active",
      createdAt: cart.createdAt || cart.updatedAt || "",
      updatedAt: cart.updatedAt || ""
    };
  });
  const topAttempts = await readTopLevelFirestoreCollection("paymentAttempts");
  const attempts = mergeRecordsById(topAttempts, Array.isArray(db.paymentAttempts) ? db.paymentAttempts : []);
  mergeRecoveredPaidAttemptOrders([], attempts).forEach((order) => {
    const { email, phone } = getOrderCustomerKeys(order);
    if (!email) return;
    const existing = usersMap[email] && typeof usersMap[email] === "object" ? usersMap[email] : {};
    const existingOrders = Array.isArray(existing.orders) ? existing.orders.slice() : [];
    const orderId = String(order.id || order.orderId || "");
    const orderIndex = existingOrders.findIndex((item) => String(item?.id || item?.orderId || "") === orderId);
    if (orderIndex > -1) existingOrders[orderIndex] = { ...existingOrders[orderIndex], ...order };
    else existingOrders.unshift(order);
    usersMap[email] = {
      ...existing,
      id: existing.id || existing.uid || existing.userId || email,
      userId: existing.userId || existing.uid || existing.id || email,
      uid: existing.uid || existing.userId || existing.id || email,
      email,
      emailNormalized: email,
      phone: existing.phone || phone,
      phoneNormalized: normalizeAccountPhone(existing.phone || phone),
      profile: {
        ...(existing.profile || {}),
        email,
        phone: existing.profile?.phone || existing.phone || phone,
        name: existing.profile?.name || order.shipping?.name || email.split("@")[0]
      },
      orders: existingOrders.slice(0, 300),
      updatedAt: new Date().toISOString()
    };
  });
  if (Object.keys(usersMap).length) {
    db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};
    db.appState.users = { ...(db.appState.users || {}), ...usersMap };
    writeDB(db).catch((writeError) => {
      addLog("Admin users app-state mirror skipped: " + writeError.message, "warn");
    });
  }
  return usersMap;
}

app.get("/api/admin/users", requireAdminSession, async (req, res) => {
  try {
    const usersMap = await buildAdminUsersMap();
    res.json({
      ok: true,
      count: Object.keys(usersMap).length,
      users: usersMap
    });
  } catch (error) {
    addLog("Admin users fetch failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to fetch admin users" });
  }
});

app.get("/api/account/users", async (req, res) => {
  try {
    if (String(req.query?.recoverRazorpay || "").toLowerCase() === "recent") {
      const db = await readDB();
      await recoverRecentRazorpayOrders(db, {
        days: Math.max(1, Math.min(30, Math.round(toNumber(req.query?.days || 7) || 7))),
        fallbackEmail: normalizeAccountEmail(req.query?.email || "")
      });
    }
    const usersMap = await buildAdminUsersMap();
    res.json({
      ok: true,
      count: Object.keys(usersMap).length,
      users: usersMap
    });
  } catch (error) {
    addLog("Account users mirror fetch failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to fetch users" });
  }
});

function normalizeAccountEmail(value = "") {
  return String(value || "").trim().toLowerCase();
}

function normalizeAccountPhone(value = "") {
  return String(value || "").replace(/\D/g, "").slice(-10);
}

function isValidIndianMobileNumber(value = "") {
  const phone = normalizeAccountPhone(value);
  if (!/^[6-9]\d{9}$/.test(phone)) return false;
  if (/^(\d)\1{9}$/.test(phone)) return false;
  return !["1234567890", "0123456789", "9876543210"].includes(phone);
}

function mergeAccountProfileRecord(primary = {}, fallback = {}) {
  const primaryRecord = primary && typeof primary === "object" ? primary : {};
  const fallbackRecord = fallback && typeof fallback === "object" ? fallback : {};
  const next = { ...fallbackRecord, ...primaryRecord };
  const primaryAddresses = Array.isArray(primaryRecord.addresses) ? primaryRecord.addresses : [];
  const fallbackAddresses = Array.isArray(fallbackRecord.addresses) ? fallbackRecord.addresses : [];
  if (!primaryAddresses.length && fallbackAddresses.length) {
    next.addresses = fallbackAddresses;
    next.defaultAddressId = next.defaultAddressId || fallbackRecord.defaultAddressId || "";
  }
  const primaryAddress = primaryRecord.address && typeof primaryRecord.address === "object" ? primaryRecord.address : {};
  const fallbackAddress = fallbackRecord.address && typeof fallbackRecord.address === "object" ? fallbackRecord.address : {};
  if (!Object.keys(primaryAddress).length && Object.keys(fallbackAddress).length) {
    next.address = fallbackAddress;
  }
  if (fallbackRecord.profile && typeof fallbackRecord.profile === "object") {
    next.profile = {
      ...fallbackRecord.profile,
      ...(primaryRecord.profile && typeof primaryRecord.profile === "object" ? primaryRecord.profile : {})
    };
  }
  return next;
}

function maskEmailAddress(value = "") {
  const email = normalizeAccountEmail(value);
  const [name, domain] = email.split("@");
  if (!name || !domain) return "";
  return `${name.slice(0, 2)}***${name.slice(-2)}@${domain}`;
}

async function findAccountUser(email = "") {
  const normalizedEmail = normalizeAccountEmail(email);
  if (!normalizedEmail) return null;
  const db = await readDB();
  const topUsers = await readTopLevelFirestoreCollection("users");
  const users = { ...(db.appState?.users || {}) };
  topUsers.forEach((user) => {
    const userEmail = normalizeAccountEmail(user.email || user.id || user.docId || "");
    if (userEmail) users[userEmail] = mergeAccountProfileRecord(user, users[userEmail] || {});
  });
  const record = users[normalizedEmail];
  if (!record) return null;
  return { ...record, email: record.email || normalizedEmail };
}

async function findFirebaseAuthUserByEmail(email = "") {
  const normalizedEmail = normalizeAccountEmail(email);
  if (!normalizedEmail) return null;
  try {
    if (admin === undefined) {
      admin = require("firebase-admin");
    }
    if (admin && !admin.apps.length) {
      admin.initializeApp();
    }
    const auth = admin && typeof admin.auth === "function" ? admin.auth() : null;
    if (!auth) return null;
    const authUser = await auth.getUserByEmail(normalizedEmail);
    return authUser ? {
      uid: authUser.uid,
      email: normalizeAccountEmail(authUser.email || normalizedEmail),
      phone: normalizeAccountPhone(authUser.phoneNumber || ""),
      emailVerified: Boolean(authUser.emailVerified)
    } : null;
  } catch (error) {
    const code = String(error && error.code || "").toLowerCase();
    if (code.includes("user-not-found")) return null;
    addLog("Account Firebase Auth lookup skipped: " + error.message, "warn");
    return null;
  }
}

async function listFirebaseAuthAccountUsers() {
  const users = [];
  try {
    if (admin === undefined) {
      admin = require("firebase-admin");
    }
    if (admin && !admin.apps.length) {
      admin.initializeApp();
    }
    const auth = admin && typeof admin.auth === "function" ? admin.auth() : null;
    if (!auth || typeof auth.listUsers !== "function") return users;
    let pageToken = "";
    do {
      const page = await auth.listUsers(1000, pageToken || undefined);
      (page.users || []).forEach((authUser) => {
        const email = normalizeAccountEmail(authUser.email || "");
        if (!email) return;
        users.push({
          uid: authUser.uid,
          id: authUser.uid || email,
          userId: authUser.uid || email,
          email,
          emailNormalized: email,
          phone: normalizeAccountPhone(authUser.phoneNumber || ""),
          phoneNormalized: normalizeAccountPhone(authUser.phoneNumber || ""),
          profile: {
            email,
            phone: normalizeAccountPhone(authUser.phoneNumber || ""),
            name: String(authUser.displayName || email.split("@")[0]).trim()
          },
          status: authUser.disabled ? "paused" : "active",
          createdAt: authUser.metadata?.creationTime ? new Date(authUser.metadata.creationTime).toISOString() : "",
          updatedAt: authUser.metadata?.lastRefreshTime ? new Date(authUser.metadata.lastRefreshTime).toISOString() : "",
          lastLoginAt: authUser.metadata?.lastSignInTime ? new Date(authUser.metadata.lastSignInTime).toISOString() : ""
        });
      });
      pageToken = page.pageToken || "";
    } while (pageToken);
  } catch (error) {
    addLog("Admin Firebase Auth users merge skipped: " + error.message, "warn");
  }
  return users;
}

async function upsertAccountUser(input = {}) {
  const email = normalizeAccountEmail(input.email);
  const phone = normalizeAccountPhone(input.phone);
  const password = String(input.password || "").trim();
  if (!email) {
    const error = new Error("Email is required");
    error.statusCode = 400;
    throw error;
  }

  const db = await readDB();
  db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};
  const users = db.appState.users && typeof db.appState.users === "object" ? db.appState.users : {};
  const topUsers = await readTopLevelFirestoreCollection("users");
  topUsers.forEach((user) => {
    const userEmail = normalizeAccountEmail(user.email || user.id || user.docId || "");
    if (userEmail) users[userEmail] = mergeAccountProfileRecord(user, users[userEmail] || {});
  });
  const existing = users[email] && typeof users[email] === "object" ? users[email] : {};
  const existingPhone = normalizeAccountPhone(existing.phone || existing.phoneNormalized || existing.profile?.phone || "");
  const finalPhone = phone || existingPhone;
  const finalPassword = password || String(existing.password || "").trim();
  const isNewUser = !existing.email && !users[email];
  const hasIdentityOnlyProfile = Boolean(input.profile) &&
    !input.address &&
    !Array.isArray(input.addresses) &&
    !input.defaultAddressId &&
    !Array.isArray(input.cart) &&
    !Array.isArray(input.orders) &&
    !phone &&
    password.length < 6;
  const isProfileOnlyUpdate = Boolean(
    input.profile ||
    input.address ||
    Array.isArray(input.addresses) ||
    input.defaultAddressId ||
    Array.isArray(input.cart) ||
    Array.isArray(input.orders)
  );

  if (isNewUser && hasIdentityOnlyProfile && !finalPhone) {
    const authUser = await findFirebaseAuthUserByEmail(email);
    if (!authUser) {
      const error = new Error("Mobile number is required for new customer account");
      error.statusCode = 400;
      throw error;
    }
  }

  if (finalPhone && !isValidIndianMobileNumber(finalPhone)) {
    const error = new Error("Please enter a valid Indian mobile number.");
    error.statusCode = 400;
    throw error;
  }

  if (isNewUser && !isProfileOnlyUpdate && (!finalPhone || finalPassword.length < 6)) {
    const error = new Error("Email, mobile number and valid password are required");
    error.statusCode = 400;
    throw error;
  }

  for (const [userEmail, record] of Object.entries(users)) {
    if (finalPhone && normalizeAccountEmail(userEmail) !== email && normalizeAccountPhone(record?.phone || record?.phoneNormalized || record?.profile?.phone || "") === finalPhone) {
      const error = new Error("This mobile number is already linked with another email account.");
      error.statusCode = 409;
      throw error;
    }
  }

  const now = new Date().toISOString();
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const hasNonEmptyValue = (value) => {
    if (Array.isArray(value)) return value.some(hasNonEmptyValue);
    if (value && typeof value === "object") {
      return Object.values(value).some(hasNonEmptyValue);
    }
    return String(value == null ? "" : value).trim() !== "";
  };
  const hasAddressPayload = input.address && typeof input.address === "object" && hasNonEmptyValue(input.address);
  const hasAddressListPayload = Array.isArray(input.addresses) && input.addresses.some((address) => hasNonEmptyValue(address));
  const shouldClearAddresses = input.clearAddresses === true;
  const existingAddresses = Array.isArray(existing.addresses) ? existing.addresses : [];
  const nextAddresses = hasAddressListPayload
    ? input.addresses
    : shouldClearAddresses
      ? []
      : existingAddresses;
  const nextDefaultAddressId = hasAddressListPayload || hasAddressPayload || shouldClearAddresses || hasOwn("defaultAddressId")
    ? String(input.defaultAddressId || (nextAddresses[0] && nextAddresses[0].id) || existing.defaultAddressId || "")
    : String(existing.defaultAddressId || "");
  const inputProfile = input.profile && typeof input.profile === "object" ? input.profile : {};
  const hasProfileName = Object.prototype.hasOwnProperty.call(inputProfile, "name");
  const nextProfileName = String(
    hasProfileName && String(inputProfile.name || "").trim()
      ? inputProfile.name
      : existing.profile?.name || existing.name || email.split("@")[0]
  ).trim();
  const nextRecord = {
    ...existing,
    email,
    emailNormalized: email,
    name: String(input.name || nextProfileName || existing.name || email.split("@")[0]).trim(),
    phone: input.phone || existing.phone || finalPhone,
    phoneNormalized: finalPhone,
    password: finalPassword,
    address: hasAddressPayload ? input.address : (existing.address || {}),
    addresses: nextAddresses,
    defaultAddressId: nextDefaultAddressId,
    cart: Array.isArray(input.cart) ? input.cart : (Array.isArray(existing.cart) ? existing.cart : []),
    orders: Array.isArray(input.orders) ? input.orders : (Array.isArray(existing.orders) ? existing.orders : []),
    profile: {
      ...(existing.profile && typeof existing.profile === "object" ? existing.profile : {}),
      ...inputProfile,
      email,
      phone: input.phone || existing.phone || finalPhone,
      name: nextProfileName
    },
    status: String(input.status || existing.status || "active").trim().toLowerCase() || "active",
    createdAt: existing.createdAt || now,
    updatedAt: now
  };

  let authUser = null;
  try {
    if (admin === undefined) {
      admin = require("firebase-admin");
    }
    if (admin && !admin.apps.length) {
      admin.initializeApp();
    }
    const auth = admin && typeof admin.auth === "function" ? admin.auth() : null;
    if (auth) {
      try {
        authUser = await auth.getUserByEmail(email);
        if (password.length >= 6) {
          await auth.updateUser(authUser.uid, { password });
        }
      } catch (authError) {
        if (String(authError && authError.code || "").includes("user-not-found")) {
          if (finalPassword.length >= 6) {
            authUser = await auth.createUser({ email, password: finalPassword, ...(finalPhone ? { phoneNumber: "+91" + finalPhone } : {}) });
          }
        } else {
          throw authError;
        }
      }
      if (authUser && authUser.uid) nextRecord.uid = authUser.uid;
    }
  } catch (error) {
    addLog("Account Firebase Auth sync skipped: " + error.message, "warn");
  }

  users[email] = nextRecord;
  db.appState.users = users;
  recordUserActivity(db, {
    type: existing && existing.email ? "profile_updated" : "account_created",
    email,
    phone: finalPhone,
    status: "saved",
    details: { hasAddress: Boolean(nextRecord.address && Object.keys(nextRecord.address).length), addressCount: Array.isArray(nextRecord.addresses) ? nextRecord.addresses.length : 0 }
  });
  await writeDB(db);
  await writeTopLevelUsers({ [email]: nextRecord }).catch((error) => {
    addLog("Account Firestore user sync skipped: " + error.message, "warn");
  });
  return nextRecord;
}

app.post("/api/account/lookup", paymentRateLimit, async (req, res) => {
  try {
    const email = normalizeAccountEmail(req.body?.email);
    const phone = normalizeAccountPhone(req.body?.phone);
    if (!email) return res.status(400).json({ ok: false, error: "Email is required" });
    const user = await findAccountUser(email);
    if (!user) {
      const authUser = await findFirebaseAuthUserByEmail(email);
      if (!authUser) {
        return res.json({ ok: true, exists: false, maskedEmail: maskEmailAddress(email) });
      }
      const savedPhone = normalizeAccountPhone(authUser.phone || "");
      return res.json({
        ok: true,
        exists: true,
        profileMissing: true,
        phoneMatches: phone && savedPhone ? savedPhone === phone : false,
        maskedEmail: maskEmailAddress(authUser.email || email),
        maskedPhoneLast4: savedPhone ? savedPhone.slice(-4) : ""
      });
    }
    const savedPhone = normalizeAccountPhone(user.phone || user.phoneNormalized || user.profile?.phone || "");
    const phoneMatches = phone ? savedPhone === phone : false;
    res.json({
      ok: true,
      exists: true,
      phoneMatches,
      maskedEmail: maskEmailAddress(user.email || email),
      maskedPhoneLast4: savedPhone ? savedPhone.slice(-4) : ""
    });
  } catch (error) {
    addLog("Account lookup failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Account lookup failed" });
  }
});

app.post("/api/account/create", paymentRateLimit, async (req, res) => {
  try {
    const record = await upsertAccountUser(req.body || {});
    const db = await readDB();
    recordUserActivity(db, { type: "account_saved", email: record.email, phone: record.phone, status: "success", req });
    await writeDB(db);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const customerToken = createSignedCustomerToken(db, { email: record.email, phone: record.phone, uid: record.uid || record.userId, expiresAt });
    setCustomerSessionCookie(res, customerToken, expiresAt);
    res.json({ ok: true, existed: false, record, session: { token: customerToken, expiresAt, email: record.email } });
  } catch (error) {
    addLog("Account create failed: " + error.message, "error");
    res.status(error.statusCode || 500).json({ ok: false, error: error.message || "Account create failed" });
  }
});

app.post("/api/account/activity", paymentRateLimit, async (req, res) => {
  try {
    const email = normalizeAccountEmail(req.body?.email || req.body?.userId || "");
    const phone = normalizeAccountPhone(req.body?.phone || req.body?.mobile || "");
    const allowedTypes = new Set([
      "login",
      "logout",
      "account_created",
      "profile_updated",
      "address_updated",
      "product_added_to_cart",
      "cart_updated",
      "checkout_started",
      "coupon_applied",
      "payment_started",
      "payment_success",
      "payment_failed",
      "payment_cancelled",
      "order_created",
      "order_cancelled"
    ]);
    const type = String(req.body?.type || req.body?.action || "activity").trim().toLowerCase();
    if (!email && !phone) return res.status(400).json({ ok: false, error: "User identity is required" });
    if (!allowedTypes.has(type)) return res.status(400).json({ ok: false, error: "Unsupported activity type" });
    const db = await readDB();
    const activity = recordUserActivity(db, {
      type,
      email,
      phone,
      orderId: req.body?.orderId,
      paymentId: req.body?.paymentId || req.body?.razorpayPaymentId,
      status: req.body?.status || "saved",
      details: req.body?.details && typeof req.body.details === "object" ? req.body.details : {},
      req
    });
    if (email && type === "login") {
      db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};
      db.appState.users = db.appState.users && typeof db.appState.users === "object" ? db.appState.users : {};
      db.appState.users[email] = {
        ...(db.appState.users[email] || {}),
        email,
        phone: db.appState.users[email]?.phone || phone,
        phoneNormalized: normalizeAccountPhone(db.appState.users[email]?.phone || phone),
        lastLoginAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }
    await writeDB(db);
    let session = null;
    if (email && type === "login") {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const token = createSignedCustomerToken(db, { email, phone, expiresAt });
      setCustomerSessionCookie(res, token, expiresAt);
      session = { token, expiresAt, email };
    }
    res.json({ ok: true, activity, session });
  } catch (error) {
    addLog("Account activity save failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to save account activity" });
  }
});

app.post("/api/account/reset-password", paymentRateLimit, async (req, res) => {
  try {
    const email = normalizeAccountEmail(req.body?.email);
    const phone = normalizeAccountPhone(req.body?.phone);
    const password = String(req.body?.password || "");
    if (!email || !phone || password.length < 6) {
      return res.status(400).json({ ok: false, error: "Email, mobile number and valid password are required" });
    }
    if (!isValidIndianMobileNumber(phone)) {
      return res.status(400).json({ ok: false, error: "Please enter a valid Indian mobile number." });
    }
    const user = await findAccountUser(email);
    if (!user) return res.status(404).json({ ok: false, error: "No account found for this email" });
    const savedPhone = normalizeAccountPhone(user.phone || user.phoneNormalized || user.profile?.phone || "");
    if (!savedPhone || savedPhone !== phone) {
      return res.status(400).json({ ok: false, error: `Mobile number does not match. Saved mobile ends with ${savedPhone ? savedPhone.slice(-4) : "****"}` });
    }
    try {
      getFirestore();
    } catch (initError) {
      addLog("Firebase init before password reset failed: " + initError.message, "warn");
    }
    const auth = admin && typeof admin.auth === "function" ? admin.auth() : null;
    if (!auth) return res.status(500).json({ ok: false, error: "Firebase Auth unavailable" });
    let authUser = null;
    try {
      authUser = await auth.getUserByEmail(email);
      await auth.updateUser(authUser.uid, { password });
    } catch (authError) {
      const code = String(authError && authError.code || "").toLowerCase();
      if (!code.includes("user-not-found")) throw authError;
      authUser = await auth.createUser({ email, password });
    }
    const db = await readDB();
    const now = new Date().toISOString();
    db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};
    db.appState.users = db.appState.users && typeof db.appState.users === "object" ? db.appState.users : {};
    const previousRecord = db.appState.users[email] || user || {};
    const nextRecord = mergeAccountProfileRecord({
      ...previousRecord,
      uid: previousRecord.uid || authUser.uid || email,
      id: previousRecord.id || email,
      userId: previousRecord.userId || email,
      email,
      phone: previousRecord.phone || phone,
      phoneNormalized: phone,
      password,
      updatedAt: now,
      profile: {
        ...(previousRecord.profile && typeof previousRecord.profile === "object" ? previousRecord.profile : {}),
        email,
        phone: previousRecord.profile?.phone || previousRecord.phone || phone
      }
    }, previousRecord);
    db.appState.users[email] = nextRecord;
    recordUserActivity(db, {
      type: "password_reset",
      email,
      phone,
      status: "success",
      req
    });
    await writeDB(db);
    await writeTopLevelUsers({ [email]: nextRecord });
    if (USE_FIRESTORE) {
      const docId = String(user.docId || user.uid || authUser.uid || "").trim();
      if (docId) {
        await getFirestore().collection("users").doc(docId).set({
          email,
          phone: nextRecord.phone || phone,
          phoneNormalized: phone,
          password,
          updatedAt: now
        }, { merge: true });
      }
    }
    res.json({ ok: true, reset: true });
  } catch (error) {
    addLog("Account password reset failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Password reset failed" });
  }
});

app.get("/api/carts/:userId", paymentRateLimit, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
    const userId = String(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "User id required" });
    const db = await readDB();
    let data = {};
    try {
      let doc = USE_FIRESTORE ? await getFirestore().collection("carts").doc(safeDocId(userId)).get() : null;
      data = doc && doc.exists ? doc.data() || {} : {};
      if ((!doc || !doc.exists) && userId.includes("@") && USE_FIRESTORE) {
        const snap = await getFirestore().collection("carts").where("email", "==", normalizeAccountEmail(userId)).limit(1).get();
        if (!snap.empty) data = snap.docs[0].data() || {};
      }
      if ((!data || !Array.isArray(data.items) || !data.items.length) && USE_FIRESTORE) {
        const [byUserId, byUid, byLinkedUserId] = await Promise.all([
          getFirestore().collection("carts").where("userId", "==", userId).limit(1).get(),
          getFirestore().collection("carts").where("uid", "==", userId).limit(1).get(),
          getFirestore().collection("carts").where("linkedUserId", "==", userId).limit(1).get()
        ]);
        const match = [byUserId, byUid, byLinkedUserId].find((snap) => snap && !snap.empty);
        if (match) data = match.docs[0].data() || {};
      }
    } catch (readError) {
      addLog("Cart Firestore read skipped: " + readError.message, "warn");
    }
    if ((!data || !Array.isArray(data.items) || !data.items.length)) {
      const email = normalizeAccountEmail(data?.email || (userId.includes("@") ? userId : ""));
      const users = db.appState?.users && typeof db.appState.users === "object" ? { ...db.appState.users } : {};
      const topUsers = await readTopLevelFirestoreCollection("users");
      topUsers.forEach((user) => {
        const userEmail = normalizeAccountEmail(user.email || user.emailNormalized || user.id || user.docId || "");
        if (userEmail) users[userEmail] = mergeAccountProfileRecord(user, users[userEmail] || {});
      });
      const userRecord = email ? users[email] : Object.values(users).find((user) => {
        return user && typeof user === "object" && [
          user.uid,
          user.userId,
          user.id,
          user.docId
        ].some((value) => String(value || "").trim() === userId);
      });
      if (userRecord && Array.isArray(userRecord.cart)) {
        data = { ...(data || {}), items: userRecord.cart };
      }
    }
    res.json({ ok: true, cart: normalizeCartItems(data.items || []) });
  } catch (error) {
    addLog("Cart fetch failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to fetch cart" });
  }
});

app.post("/api/carts/:userId", paymentRateLimit, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
    const userId = String(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "User id required" });
    const items = normalizeCartItems(req.body?.items || req.body?.cart || []);
    const email = normalizeAccountEmail(req.body?.email || (userId.includes("@") ? userId : ""));
    const docId = safeDocId(req.body?.uid || req.body?.userId || userId);
    const payload = {
      userId: docId,
      uid: String(req.body?.uid || "").trim(),
      email,
      items,
      updatedAt: new Date().toISOString()
    };
    await getFirestore().collection("carts").doc(docId).set(payload, { merge: true });
    if (email && safeDocId(email) !== docId) {
      await getFirestore().collection("carts").doc(safeDocId(email)).set({
        ...payload,
        userId: email,
        email,
        linkedUserId: docId
      }, { merge: true });
      await getFirestore().collection("users").doc(safeDocId(email)).set({
        email,
        emailNormalized: email,
        uid: payload.uid || docId,
        userId: payload.uid || docId,
        cart: items,
        updatedAt: payload.updatedAt
      }, { merge: true });
    }
    if (email) {
      const db = await readDB();
      db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};
      db.appState.users = db.appState.users && typeof db.appState.users === "object" ? db.appState.users : {};
      db.appState.users[email] = { ...(db.appState.users[email] || {}), email, cart: items, updatedAt: payload.updatedAt };
      recordUserActivity(db, { type: "cart_updated", email, status: "saved", details: { itemCount: items.length }, req });
      await writeDB(db).catch((writeError) => addLog("Cart user mirror save skipped: " + writeError.message, "warn"));
    }
    res.json({ ok: true, cart: items });
  } catch (error) {
    addLog("Cart save failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to save cart" });
  }
});

app.get("/api/checkout-drafts/:userId", paymentRateLimit, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
    const userId = String(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "User id required" });
    let data = null;
    try {
      let doc = USE_FIRESTORE ? await getFirestore().collection("checkoutDrafts").doc(safeDocId(userId)).get() : null;
      data = doc && doc.exists ? doc.data() || {} : null;
      if (!data && userId.includes("@") && USE_FIRESTORE) {
        const snap = await getFirestore().collection("checkoutDrafts").where("email", "==", normalizeAccountEmail(userId)).limit(1).get();
        if (!snap.empty) data = snap.docs[0].data() || {};
      }
    } catch (readError) {
      addLog("Checkout draft Firestore read skipped: " + readError.message, "warn");
    }
    res.json({ ok: true, draft: data || null });
  } catch (error) {
    addLog("Checkout draft fetch failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to fetch checkout draft" });
  }
});

app.post("/api/checkout-drafts/:userId", paymentRateLimit, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
    const userId = String(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "User id required" });
    const docId = safeDocId(req.body?.uid || req.body?.userId || userId);
    const payload = {
      ...(req.body && typeof req.body === "object" ? req.body : {}),
      userId: docId,
      email: normalizeAccountEmail(req.body?.email || (userId.includes("@") ? userId : "")),
      cartSnapshot: normalizeCartItems(req.body?.cartSnapshot || req.body?.items || []),
      updatedAt: new Date().toISOString()
    };
    await getFirestore().collection("checkoutDrafts").doc(docId).set(payload, { merge: true });
    const email = payload.email;
    if (email) {
      const db = await readDB();
      recordUserActivity(db, { type: "checkout_started", email, status: "saved", details: { itemCount: payload.cartSnapshot.length, coupon: payload.coupon?.code || payload.appliedCoupon?.code || "" }, req });
      await writeDB(db).catch((writeError) => addLog("Checkout activity save skipped: " + writeError.message, "warn"));
    }
    res.json({ ok: true, draft: payload });
  } catch (error) {
    addLog("Checkout draft save failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to save checkout draft" });
  }
});

app.get("/api/app-state", async (req, res) => {
  try {
    const db = await readDB();
    const isAdmin = Boolean(findValidAdminSession(db, req));
    const siteContent = await readTopLevelSiteContent();
    const topUsers = isAdmin ? await readTopLevelFirestoreCollection("users") : [];
    if (Object.keys(siteContent).length) {
      db.appState = { ...db.appState, ...siteContent };
    }
    if (isAdmin && topUsers.length) {
      const usersMap = {};
      topUsers.forEach((user) => {
        const email = String(user.email || user.id || user.docId || "").trim().toLowerCase();
        if (email) usersMap[email] = user;
      });
      db.appState.users = { ...(db.appState.users || {}), ...usersMap };
    }
    if (Array.isArray(db.coupons) || Array.isArray(siteContent.coupons)) {
      db.appState.coupons = mergeRecordsById(siteContent.coupons || [], db.coupons || []).map((coupon) => normalizeCoupon(coupon)).slice(0, 50);
    }
    const rawKeys = String(req.query.keys || "").trim();
    let keys = rawKeys
      ? rawKeys.split(",").map((item) => item.trim()).filter(Boolean)
      : Object.keys(db.appState || {});
    if (!rawKeys && Array.isArray(db.coupons) && db.coupons.length && !keys.includes("coupons")) {
      keys.push("coupons");
    }
    if (!isAdmin) {
      keys = filterPublicAppStateKeys(keys);
    }
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
    const isAdmin = Boolean(findValidAdminSession(db, req));
    const siteContent = await readTopLevelSiteContent();
    if (Object.keys(siteContent).length) {
      db.appState = { ...db.appState, ...siteContent };
    }
    if (Array.isArray(db.coupons) || Array.isArray(siteContent.coupons)) {
      db.appState.coupons = mergeRecordsById(siteContent.coupons || [], db.coupons || []).map((coupon) => normalizeCoupon(coupon)).slice(0, 50);
    }
    if (isAdmin) {
      const topUsers = await readTopLevelFirestoreCollection("users");
      if (topUsers.length) {
        const usersMap = {};
        topUsers.forEach((user) => {
          const email = String(user.email || user.id || user.docId || "").trim().toLowerCase();
          if (email) usersMap[email] = user;
        });
        db.appState.users = { ...(db.appState.users || {}), ...usersMap };
      }
    }
    let keys = [
      "users",
      "homeContent",
      "adminCustomersUpdatedAt",
      "heroVideoUpdatedAt",
      "adminCoupons",
      "adminCoupon",
      "ORDER_STATUS_OVERRIDE_KEY",
      "PAYMENT_REVIEW_KEY",
      "CUSTOMER_PAUSE_KEY",
      "DELETED_CUSTOMERS_KEY"
    ];
    if (!isAdmin) {
      keys = filterPublicAppStateKeys(keys);
    }
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
    if (!requireDurablePersistence(res)) return;
    const db = await readDB();
    const state = req.body && typeof req.body.state === "object" ? req.body.state : {};
    const removeKeys = Array.isArray(req.body?.removeKeys) ? req.body.removeKeys : [];
    const isAdmin = Boolean(findValidAdminSession(db, req));
    if (!isAdmin && !isPublicAppStateWrite(state, removeKeys)) {
      auditAdminAction(db, req, "app-state.write", "blocked", { keys: Object.keys(state || {}), removeKeys });
      await writeDB(db);
      return res.status(401).json({ ok: false, error: "Admin session required for protected app state" });
    }
    db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};

    Object.keys(state).forEach((key) => {
      if (!key) return;
      db.appState[key] = normalizeAppStateValue(state[key]);
    });
    if (Array.isArray(state.coupons)) {
      db.coupons = state.coupons.map((coupon) => normalizeCoupon(coupon)).filter((coupon) => coupon.code).slice(0, 50);
      db.appState.coupons = db.coupons;
      await writeTopLevelSiteContentPatch({ coupons: db.coupons, homeContent: { coupons: db.coupons } });
    }
    if (state.users && typeof state.users === "object") {
      await writeTopLevelUsers(state.users);
    }

    removeKeys.forEach((key) => {
      if (!key) return;
      delete db.appState[key];
      if (key === "coupons") {
        db.coupons = [];
      }
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

app.post("/api/coupons", couponRateLimit, requireAdminSession, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
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
    auditAdminAction(db, req, "coupon.save", "success", { code: coupon.code });
    await writeDB(db);
    await writeTopLevelSiteContentPatch({ coupons: db.coupons, homeContent: { coupons: db.coupons } });
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

app.delete("/api/coupons/:code", couponRateLimit, requireAdminSession, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
    const code = String(req.params.code || "").trim().toUpperCase();
    const db = await readDB();
    db.coupons = db.coupons.filter((coupon) => String(coupon.code || "").trim().toUpperCase() !== code);
    auditAdminAction(db, req, "coupon.delete", "success", { code });
    await writeDB(db);
    await writeTopLevelSiteContentPatch({ coupons: db.coupons, homeContent: { coupons: db.coupons } });
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
    if (!requireDurablePersistence(res)) return;
    const incoming = normalizeOrderForDb(req.body || {});
    const db = await readDB();
    const isAdmin = Boolean(findValidAdminSession(db, req));
    const isVerifiedPaidOrder = String(incoming.paymentStatus || incoming.payment || "").toLowerCase().includes("paid")
      && Boolean(incoming.razorpayPaymentId || incoming.paymentId || incoming.payment_id || incoming.razorpay_order_id || incoming.razorpayOrderId);
    if (!isAdmin && !isVerifiedPaidOrder) {
      return res.status(403).json({ ok: false, error: "Verified payment is required before order creation" });
    }
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

    if (existingIndex > -1) db.orders[existingIndex] = order;
    else db.orders.unshift(order);
    db.orders = db.orders.slice(0, 5000);
    await mirrorOrderToCustomerProfile(db, order);
    recordUserActivity(db, {
      type: "order_created",
      email: order.email || order.customerEmail,
      phone: order.phone || order.customerPhone,
      orderId: order.id,
      paymentId: order.payment_id || order.paymentId || order.razorpayPaymentId || "",
      status: "saved",
      details: {
        source: isAdmin ? "admin" : "verified-payment",
        total: order.total || order.finalAmount || 0,
        itemCount: Array.isArray(order.items) ? order.items.length : 0
      },
      req
    });
    await writeDB(db);
    await writeTopLevelOrder(order);
    if (existingIndex < 0) {
      await sendOrderEmail(db, order, "Confirmed", "order-created").catch((emailError) => {
        addLog("Order confirmation email failed: " + emailError.message, "error");
      });
    }

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
    req.__customerSession = getCustomerSessionFromRequest(db, req);
    const orderId = String(req.params.id);
    const nestedOrder = db.orders.find((item) => String(item.id) === orderId);
    const topLevelOrders = await readTopLevelFirestoreCollection("orders");
    const topLevelOrder = topLevelOrders.find((item) => String(item.id || item.docId) === orderId);
    const order = topLevelOrder || nestedOrder ? { ...(nestedOrder || {}), ...(topLevelOrder || {}) } : null;
    if (!order) {
      return res.status(404).json({ ok: false, error: "Order not found" });
    }
    if (!findValidAdminSession(db, req) && !orderMatchesCustomerAccess(order, req)) {
      return res.status(403).json({ ok: false, error: "Order access verification required" });
    }
    res.json({ ok: true, order });
  } catch (error) {
    addLog("Order fetch failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to fetch order" });
  }
});

app.post("/api/orders/:id/cancel", paymentRateLimit, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
    const db = await readDB();
    req.__customerSession = getCustomerSessionFromRequest(db, req);
    const orderId = String(req.params.id || "");
    const index = findOrderIndex(db, (order) => String(order.id) === orderId);
    if (index < 0) return res.status(404).json({ ok: false, error: "Order not found" });

    const now = new Date().toISOString();
    const current = normalizeOrderForDb(db.orders[index] || {});
    if (!findValidAdminSession(db, req) && !orderMatchesCustomerAccess(current, req)) {
      return res.status(403).json({ ok: false, error: "Order access verification required" });
    }
    const normalizedStatus = normalizeEmailStatus(current.status || "");
    if (["Delivered", "Dispatched", "Out for Delivery"].includes(normalizedStatus)) {
      return res.status(409).json({ ok: false, error: "Cancellation is closed for this order. Please request return/support." });
    }
    const nextOrder = {
      ...current,
      status: "Cancelled",
      orderStatus: "Cancelled",
      cancelledBy: "user",
      cancelledByLabel: "User Cancelled",
      cancelledAt: now,
      paymentStatus: current.paymentStatus || current.payment || "Refund Initiated",
      payment: "Refund Initiated",
      refundStatus: current.refundStatus || "Refund Initiated",
      refundAmount: current.refundAmount || Math.round(toNumber(current.finalAmount || current.total || current.amount || 0)),
      refundDate: current.refundDate || now,
      refundMode: current.refundMode || "Original payment method",
      refundMessage: current.refundMessage || "Refund has been initiated after order cancellation.",
      statusHistory: [
        ...(Array.isArray(current.statusHistory) ? current.statusHistory : []),
        { status: "Cancelled", time: now, note: String(req.body?.note || "Cancelled by customer.").trim() }
      ],
      updatedAt: now
    };
    const refundResult = await createRazorpayRefundForOrder(nextOrder);
    nextOrder.razorpayRefundConfigured = refundResult.configured !== false;
    nextOrder.razorpayRefundStatus = refundResult.status;
    nextOrder.refundStatus = refundResult.status || nextOrder.refundStatus;
    nextOrder.refundRaw = refundResult.refund || nextOrder.refundRaw || null;
    if (refundResult.refund && refundResult.refund.id) {
      nextOrder.refundId = refundResult.refund.id;
      nextOrder.razorpayRefundId = refundResult.refund.id;
    }
    db.orders[index] = nextOrder;
    await mirrorOrderToCustomerProfile(db, nextOrder);
    recordUserActivity(db, {
      type: "order_cancelled",
      email: nextOrder.email || nextOrder.customerEmail,
      phone: nextOrder.phone || nextOrder.customerPhone,
      orderId: nextOrder.id,
      status: "cancelled",
      details: { cancelledBy: "user", refundStatus: nextOrder.refundStatus || "" },
      req
    });
    await writeDB(db);
    await writeTopLevelOrder(nextOrder);
    await sendOrderEmail(db, nextOrder, "Cancelled", "customer-cancel").catch((emailError) => {
      addLog("Customer cancel email failed: " + emailError.message, "error");
    });
    res.json({ ok: true, order: nextOrder, refund: refundResult });
  } catch (error) {
    addLog("Customer cancel failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to cancel order" });
  }
});

app.post("/api/orders/:id/return-request", paymentRateLimit, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
    const db = await readDB();
    req.__customerSession = getCustomerSessionFromRequest(db, req);
    const orderId = String(req.params.id || "");
    const index = findOrderIndex(db, (order) => String(order.id) === orderId);
    if (index < 0) return res.status(404).json({ ok: false, error: "Order not found" });
    const now = new Date().toISOString();
    const order = normalizeOrderForDb(db.orders[index] || {});
    if (!findValidAdminSession(db, req) && !orderMatchesCustomerAccess(order, req)) {
      return res.status(403).json({ ok: false, error: "Order access verification required" });
    }
    const requests = ensureReturnWorkflow(db);
    const existing = requests.find((item) => String(item.orderId) === orderId && !["Rejected", "Completed"].includes(String(item.status || "")));
    if (existing) return res.json({ ok: true, request: existing, order });
    const request = normalizeReturnRequest({
      orderId,
      userId: req.body?.userId || order.userId,
      type: req.body?.type || "Return",
      reason: req.body?.reason || req.body?.note,
      requestedAmount: req.body?.requestedAmount
    }, order);
    requests.unshift(request);
    db.orders[index] = {
      ...order,
      returnStatus: request.status,
      returnRequestId: request.id,
      statusHistory: [
        ...(Array.isArray(order.statusHistory) ? order.statusHistory : []),
        { status: "Return Requested", time: now, note: request.reason }
      ],
      updatedAt: now
    };
    await writeDB(db);
    await writeTopLevelOrder(db.orders[index]);
    await sendOrderEmail(db, db.orders[index], "Refund", "return-request").catch((emailError) => {
      addLog("Return request email failed: " + emailError.message, "error");
    });
    res.json({ ok: true, request, order: db.orders[index] });
  } catch (error) {
    addLog("Return request failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to submit return request" });
  }
});

app.post("/api/abandoned-cart", paymentRateLimit, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
    const db = await readDB();
    const carts = ensureAbandonedCarts(db);
    const incoming = req.body || {};
    const index = findAbandonedCartIndex(carts, incoming);
    const existing = index > -1 ? carts[index] : {};
    const cart = normalizeAbandonedCart(incoming, existing);
    const now = new Date().toISOString();
    if (!cart.items.length) {
      cart.status = "cleared";
      cart.history = [
        ...(Array.isArray(cart.history) ? cart.history : []),
        { status: "cleared", time: now, note: "Cart became empty." }
      ];
    } else if (String(existing.status || "").toLowerCase() !== "open") {
      cart.status = "open";
      cart.history = [
        ...(Array.isArray(cart.history) ? cart.history : []),
        { status: "open", time: now, note: "Cart activity resumed." }
      ];
    }
    if (index > -1) carts[index] = cart;
    else carts.unshift(cart);
    db.appState.abandonedCarts = carts.slice(0, 2000);
    await writeDB(db);
    res.json({ ok: true, cart });
  } catch (error) {
    addLog("Abandoned cart save failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to save abandoned cart" });
  }
});

app.post("/api/abandoned-cart/recovered", paymentRateLimit, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
    const db = await readDB();
    const carts = ensureAbandonedCarts(db);
    const index = findAbandonedCartIndex(carts, req.body || {});
    if (index < 0) return res.json({ ok: true, recovered: false });
    const now = new Date().toISOString();
    carts[index] = {
      ...carts[index],
      status: "recovered",
      recoveredAt: now,
      recoveredOrderId: String(req.body?.orderId || req.body?.id || carts[index].recoveredOrderId || "").trim(),
      updatedAt: now,
      history: [
        ...(Array.isArray(carts[index].history) ? carts[index].history : []),
        { status: "recovered", time: now, note: "Customer completed checkout." }
      ]
    };
    await writeDB(db);
    res.json({ ok: true, recovered: true, cart: carts[index] });
  } catch (error) {
    addLog("Abandoned cart recover failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to update abandoned cart" });
  }
});

app.get("/api/admin/abandoned-carts", requireAdminSession, async (req, res) => {
  try {
    const db = await readDB();
    res.json({ ok: true, carts: ensureAbandonedCarts(db) });
  } catch (error) {
    addLog("Abandoned carts fetch failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to fetch abandoned carts" });
  }
});

app.post("/api/admin/abandoned-carts/:id/remind", requireAdminSession, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
    const db = await readDB();
    const carts = ensureAbandonedCarts(db);
    const cartId = String(req.params.id || "").trim();
    const index = carts.findIndex((cart) => String(cart.id || "") === cartId);
    if (index < 0) return res.status(404).json({ ok: false, error: "Abandoned cart not found" });
    const response = await sendAbandonedCartEmail(db, carts[index]);
    if (!response.ok && response.skipped) {
      return res.status(400).json({ ok: false, error: response.reason || "Reminder email not configured" });
    }
    const now = new Date().toISOString();
    carts[index] = {
      ...carts[index],
      status: "reminded",
      reminderCount: Math.max(0, Math.round(toNumber(carts[index].reminderCount || 0))) + 1,
      lastReminderAt: now,
      updatedAt: now,
      history: [
        ...(Array.isArray(carts[index].history) ? carts[index].history : []),
        { status: "reminded", time: now, note: "Recovery reminder sent by admin." }
      ]
    };
    auditAdminAction(db, req, "abandoned-cart.remind", "success", { cartId });
    await writeDB(db);
    res.json({ ok: true, cart: carts[index], email: response });
  } catch (error) {
    addLog("Abandoned cart reminder failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to send abandoned cart reminder" });
  }
});

app.post("/api/admin/resend-config", requireAdminSession, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
    const apiKey = String(req.body?.apiKey || "").trim();
    const fromEmail = String(req.body?.fromEmail || "Swadra Organics <orders@swadraorganics.com>").trim();
    const replyTo = String(req.body?.replyTo || "").trim();
    if (!apiKey || !apiKey.startsWith("re_")) {
      return res.status(400).json({ ok: false, error: "Valid Resend API key is required" });
    }
    const db = await readDB();
    db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};
    db.appState.resendApiKey = apiKey;
    db.appState.resendFromEmail = fromEmail;
    db.appState.resendReplyTo = replyTo;
    auditAdminAction(db, req, "admin.resend-config.update", "success", { fromEmail, replyTo });
    await writeDB(db);
    addLog("Resend email config saved", "success");
    res.json({ ok: true, configured: true, fromEmail, replyTo });
  } catch (error) {
    addLog("Resend config save failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to save Resend config" });
  }
});

app.post("/api/orders/:id/packed", requireAdminSession, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
    const db = await readDB();
    const orderId = String(req.params.id || "");
    const index = findOrderIndex(db, (order) => String(order.id) === orderId);
    if (index < 0) return res.status(404).json({ ok: false, error: "Order not found" });

    let order = normalizeOrderForDb(db.orders[index] || {});
    if (!Array.isArray(order.statusHistory)) order.statusHistory = [];

    order.status = "Packed";
    order.statusHistory.push({ status: "Packed", time: new Date().toISOString(), note: "Packed by admin." });

    if (!order.awb && !order.trackingId && !order.shipment_id) {
      const shipmentResult = await createShiprocketShipmentForOrder(order);
      if (!shipmentResult.ok) {
        order.shiprocket = {
          status: "failed",
          error: shipmentResult.error,
          step: shipmentResult.step || "",
          raw: shipmentResult.raw || null,
          createResponse: shipmentResult.created || null,
          awbResponse: shipmentResult.assigned || null,
          failedAt: new Date().toISOString()
        };
      } else {
        const shipment = shipmentResult.shipment || {};
        const labelData = shipmentResult.label || {};
        const labelUrl = labelData?.label_url || labelData?.labelUrl || labelData?.data?.label_url || labelData?.data?.labelUrl || labelData?.response?.label_url || labelData?.response?.labelUrl || labelData?.data?.label_url_download || "";
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
          shiprocketLabelUrl: labelUrl,
          shiprocket: {
            status: "created",
            createdAt: new Date().toISOString(),
            labelStatus: shipmentResult.labelError ? "failed" : "created",
            labelError: shipmentResult.labelError || "",
            createResponse: shipmentResult.created,
            awbResponse: shipmentResult.assigned,
            labelResponse: shipmentResult.label || {}
          }
        };
      }
    }

    db.orders[index] = { ...order, updatedAt: new Date().toISOString() };
    auditAdminAction(db, req, "order.packed", "success", { orderId });
    await mirrorOrderToCustomerProfile(db, db.orders[index]);
    await writeDB(db);
    await writeTopLevelOrder(db.orders[index]);
    await sendOrderEmail(db, db.orders[index], "Packed", "packed-status").catch((emailError) => {
      addLog("Packed email failed: " + emailError.message, "error");
    });
    res.json({ ok: true, order: db.orders[index], shiprocket: db.orders[index].shiprocket || {} });
  } catch (error) {
    addLog("Packed->Shiprocket failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to process packed status" });
  }
});

app.patch("/api/orders/:id/status", requireAdminSession, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
    const db = await readDB();
    const orderId = String(req.params.id || "");
    const index = findOrderIndex(db, (order) => String(order.id) === orderId);
    if (index < 0) return res.status(404).json({ ok: false, error: "Order not found" });

    const current = normalizeOrderForDb(db.orders[index] || {});
    const nextStatus = normalizeEmailStatus(req.body?.status || current.status || "Confirmed");
    const now = new Date().toISOString();
    const historyEntry = {
      status: nextStatus,
      time: now,
      note: String(req.body?.note || "Updated by admin.").trim()
    };

    const paymentAttempt = findPaymentAttemptForOrder(db, current);
    const currentWithPayment = mergePaymentAttemptIntoOrder(current, paymentAttempt);

    const nextOrder = {
      ...currentWithPayment,
      status: nextStatus,
      orderStatus: nextStatus,
      statusHistory: [...(Array.isArray(current.statusHistory) ? current.statusHistory : []), historyEntry],
      updatedAt: now
    };

    if (nextStatus === "Cancelled") {
      nextOrder.cancelledAt = now;
      nextOrder.refundStatus = nextOrder.refundStatus || "Refund Initiated";
      nextOrder.paymentStatus = nextOrder.paymentStatus || nextOrder.payment || "Refund Initiated";
      nextOrder.payment = "Refund Initiated";
      nextOrder.refundAmount = nextOrder.refundAmount || Math.round(toNumber(nextOrder.finalAmount || nextOrder.payableAmount || nextOrder.total || nextOrder.amount || nextOrder.paidAmount || 0));
      nextOrder.refundDate = nextOrder.refundDate || now;
      nextOrder.refundMode = nextOrder.refundMode || "Original payment method";
      nextOrder.refundMessage = nextOrder.refundMessage || "Refund has been initiated after order cancellation.";
      const refundResult = await createRazorpayRefundForOrder(nextOrder);
      nextOrder.razorpayRefundConfigured = refundResult.configured !== false;
      nextOrder.razorpayRefundStatus = refundResult.status;
      nextOrder.refundStatus = refundResult.status || nextOrder.refundStatus;
      nextOrder.refundMessage = refundResult.ok
        ? (refundResult.skipped ? nextOrder.refundMessage : "Razorpay refund request has been created.")
        : (refundResult.message || "Razorpay refund could not be created right now.");
      nextOrder.refundRaw = refundResult.refund || nextOrder.refundRaw || null;
      if (refundResult.refund && refundResult.refund.id) {
        nextOrder.refundId = refundResult.refund.id;
        nextOrder.razorpayRefundId = refundResult.refund.id;
      }
      if (refundResult.refund && refundResult.refund.status) {
        nextOrder.razorpayRefundGatewayStatus = refundResult.refund.status;
      }
      if (paymentAttempt) {
        const attemptIndex = db.paymentAttempts.findIndex((attempt) => attempt === paymentAttempt);
        if (attemptIndex > -1) {
          db.paymentAttempts[attemptIndex] = {
            ...db.paymentAttempts[attemptIndex],
            status: "refunded",
            refundStatus: nextOrder.refundStatus,
            refundId: nextOrder.refundId || "",
            razorpayRefundId: nextOrder.razorpayRefundId || "",
            refundAmount: nextOrder.refundAmount || 0,
            refundRaw: nextOrder.refundRaw || null,
            updatedAt: now
          };
        }
      }
      nextOrder.statusHistory.push({
        status: nextOrder.refundStatus,
        time: now,
        note: nextOrder.refundMessage
      });
    }
    if (nextStatus === "Refund") {
      nextOrder.refundStatus = "Refund Initiated";
      nextOrder.refundDate = now;
    }

    if (String(req.body?.source || "").toLowerCase() === "user") {
      nextOrder.cancelledBy = "user";
      nextOrder.cancelledByLabel = "User Cancelled";
      const lastHistory = nextOrder.statusHistory[nextOrder.statusHistory.length - 1];
      if (lastHistory) lastHistory.note = String(req.body?.note || "User cancelled this order.").trim();
    } else if (nextStatus === "Cancelled") {
      nextOrder.cancelledBy = "admin";
      nextOrder.cancelledByLabel = "Admin Cancelled";
    }

    db.orders[index] = nextOrder;
    auditAdminAction(db, req, "order.status.update", "success", { orderId, status: nextStatus });
    await mirrorOrderToCustomerProfile(db, nextOrder);
    await writeDB(db);
    await writeTopLevelOrder(db.orders[index]);
    await sendOrderEmail(db, db.orders[index], nextStatus, "status-update").catch((emailError) => {
      addLog("Order status email failed: " + emailError.message, "error");
    });
    res.json({ ok: true, order: db.orders[index] });
  } catch (error) {
    addLog("Order status update failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to update order status" });
  }
});

app.get("/api/admin/return-requests", requireAdminSession, async (req, res) => {
  try {
    const db = await readDB();
    res.json({ ok: true, requests: ensureReturnWorkflow(db) });
  } catch (error) {
    addLog("Return requests fetch failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to fetch return requests" });
  }
});

app.patch("/api/admin/return-requests/:id", requireAdminSession, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
    const db = await readDB();
    const requestId = String(req.params.id || "");
    const requests = ensureReturnWorkflow(db);
    const requestIndex = requests.findIndex((item) => String(item.id) === requestId);
    if (requestIndex < 0) return res.status(404).json({ ok: false, error: "Return request not found" });
    const now = new Date().toISOString();
    const nextStatus = String(req.body?.status || "Approved").trim();
    const note = String(req.body?.note || "Updated by admin.").trim();
    const request = {
      ...requests[requestIndex],
      status: nextStatus,
      updatedAt: now,
      history: [
        ...(Array.isArray(requests[requestIndex].history) ? requests[requestIndex].history : []),
        { status: nextStatus, time: now, note }
      ]
    };
    requests[requestIndex] = request;
    const orderIndex = findOrderIndex(db, (order) => String(order.id) === String(request.orderId));
    let refundResult = null;
    if (orderIndex > -1) {
      const order = normalizeOrderForDb(db.orders[orderIndex] || {});
      const patch = {
        returnStatus: nextStatus,
        returnRequestId: request.id,
        statusHistory: [
          ...(Array.isArray(order.statusHistory) ? order.statusHistory : []),
          { status: "Return " + nextStatus, time: now, note }
        ],
        updatedAt: now
      };
      if (nextStatus.toLowerCase() === "approved") {
        patch.refundStatus = "Refund Initiated";
        patch.refundAmount = request.requestedAmount || Math.round(toNumber(order.finalAmount || order.total || order.amount || 0));
        patch.refundDate = now;
        patch.refundMode = order.refundMode || "Original payment method";
        patch.refundMessage = "Return request approved. Refund has been initiated.";
        refundResult = await createRazorpayRefundForOrder({ ...order, ...patch });
        patch.razorpayRefundConfigured = refundResult.configured !== false;
        patch.razorpayRefundStatus = refundResult.status;
        patch.refundStatus = refundResult.status || patch.refundStatus;
        patch.refundRaw = refundResult.refund || order.refundRaw || null;
        if (refundResult.refund && refundResult.refund.id) {
          patch.refundId = refundResult.refund.id;
          patch.razorpayRefundId = refundResult.refund.id;
        }
      }
      db.orders[orderIndex] = { ...order, ...patch };
      await sendOrderEmail(db, db.orders[orderIndex], "Refund", "return-request-admin").catch((emailError) => {
        addLog("Return admin email failed: " + emailError.message, "error");
      });
    }
    auditAdminAction(db, req, "return-request.update", "success", { requestId, status: nextStatus });
    await writeDB(db);
    if (orderIndex > -1) await writeTopLevelOrder(db.orders[orderIndex]);
    res.json({ ok: true, request, order: orderIndex > -1 ? db.orders[orderIndex] : null, refund: refundResult });
  } catch (error) {
    addLog("Return request update failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to update return request" });
  }
});

app.get("/api/orders", requireAdminSession, async (req, res) => {
  try {
    const db = await readDB();
    const topLevelOrders = await readTopLevelFirestoreCollection("orders");
    const topLevelAttempts = await readTopLevelFirestoreCollection("paymentAttempts");
    const attempts = mergeRecordsById(topLevelAttempts, Array.isArray(db.paymentAttempts) ? db.paymentAttempts : []);
    const orders = mergeRecoveredPaidAttemptOrders(
      mergeRecordsById(topLevelOrders, Array.isArray(db.orders) ? db.orders : []),
      attempts
    );
    res.json({
      ok: true,
      count: orders.length,
      orders
    });
  } catch (error) {
    addLog("Orders list fetch failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to fetch orders list" });
  }
});

app.get("/api/orders/user/:userId", async (req, res) => {
  try {
    const db = await readDB();
    req.__customerSession = getCustomerSessionFromRequest(db, req);
    const userId = decodeURIComponent(req.params.userId || "");
    const normalizedUserId = String(userId || "").trim().toLowerCase();
    const requester = getCustomerAccessFields(req);
    const lookupIdentities = getUniqueCustomerIdentities([userId, normalizedUserId, ...requester]);
    if (!findValidAdminSession(db, req) && !lookupIdentities.some((value) => requester.includes(value))) {
      return res.status(403).json({ ok: false, error: "Order access verification required" });
    }
    const topLevelOrders = await readTopLevelFirestoreCollection("orders");
    const users = { ...(db.appState?.users && typeof db.appState.users === "object" ? db.appState.users : {}) };
    const topUsers = await readTopLevelFirestoreCollection("users");
    topUsers.forEach((profile) => {
      const email = normalizeAccountEmail(profile.email || profile.id || profile.docId || "");
      if (email) users[email] = mergeAccountProfileRecord(profile, users[email] || {});
    });
    const profileOrders = [];
    Object.entries(users).forEach(([key, profile]) => {
      const profileIdentities = getUniqueCustomerIdentities([
        key,
        profile?.email,
        profile?.userId,
        profile?.uid,
        profile?.authUserId,
        profile?.firebaseUid,
        profile?.phone,
        profile?.mobile
      ]);
      const matchesProfile = profileIdentities.some((value) => lookupIdentities.includes(value));
      if (matchesProfile && Array.isArray(profile?.orders)) {
        profileOrders.push(...profile.orders);
      }
    });
    const topLevelAttempts = await readTopLevelFirestoreCollection("paymentAttempts");
    const attempts = mergeRecordsById(topLevelAttempts, Array.isArray(db.paymentAttempts) ? db.paymentAttempts : []);
    const allOrders = mergeRecoveredPaidAttemptOrders(
      mergeRecordsById(topLevelOrders, mergeRecordsById(db.orders || [], profileOrders)),
      attempts
    );
    const orders = allOrders.filter((order) => {
      const keys = getOrderCustomerIdentities(order);
      return keys.some((value) => lookupIdentities.includes(value));
    });
    if (!orders.length) {
      Object.values(await buildAdminUsersMap()).forEach((profile) => {
        const profileIdentities = getUniqueCustomerIdentities([
          profile?.email,
          profile?.userId,
          profile?.uid,
          profile?.id,
          profile?.phone,
          profile?.mobile
        ]);
        if (!profileIdentities.some((value) => lookupIdentities.includes(value))) return;
        if (Array.isArray(profile?.orders)) {
          profile.orders.forEach((order) => orders.push(order));
        }
      });
    }
    res.json({ ok: true, count: orders.length, orders });
  } catch (error) {
    addLog("User orders fetch failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to fetch user orders" });
  }
});

app.post("/api/payments/create-order", paymentRateLimit, inventorySerial, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
    const payload = req.body || {};
    const amount = Math.round(toNumber(payload.amount));

    if (amount <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Valid payment amount is required"
      });
    }

    const db = await readDB();
    cleanupInventoryLocks(db);
    const requestedOrderId = String(payload.orderId || "").trim();
    const orderIdTaken = requestedOrderId && []
      .concat(Array.isArray(db.orders) ? db.orders : [])
      .concat(Array.isArray(db.paymentAttempts) ? db.paymentAttempts : [])
      .some((item) => String(item?.id || item?.orderId || item?.localOrderId || "") === requestedOrderId);
    const orderId = requestedOrderId && !orderIdTaken ? requestedOrderId : getNextWebsiteOrderId(db);
    const snapshotItems = Array.isArray(payload.snapshot?.items)
      ? payload.snapshot.items
      : Array.isArray(payload.snapshot?.cart)
        ? payload.snapshot.cart
        : [];
    const items = snapshotItems;
    const validationErrors = [];
    const lockRows = [];
    for (const item of items) {
      const inventoryKey = getInventoryKey(item);
      if (!inventoryKey) continue;
      const qty = getItemQty(item);
      const stock = getItemStock(item);
      if (stock === null) continue;
      const reserved = getReservedQty(db, inventoryKey);
      const available = Math.max(0, stock - reserved);
      if (qty > available) {
        validationErrors.push({ item: item.name || item.productName || item.id || item.productId || "Item", requested: qty, available });
      } else {
        lockRows.push({ inventoryKey, qty, stock });
      }
    }
    if (validationErrors.length) {
      return res.status(409).json({ ok: false, error: "Some items are no longer available in requested quantity.", items: validationErrors });
    }
    const razorpay = await createRazorpayOrder({
      amount,
      currency: payload.currency || "INR",
      receipt: payload.receipt || "swadra_" + Date.now(),
      notes: {
        local_order_id: orderId,
        snapshot_hash: hashPayload(payload.snapshot || {}),
        source: "Swadra Website"
      }
    });

    const order = {
      id: orderId,
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
    const snapshotUser = payload.snapshot && typeof payload.snapshot === "object" ? payload.snapshot.user || payload.snapshot.email : "";
    recordUserActivity(db, {
      type: "payment_started",
      email: snapshotUser,
      orderId,
      status: order.status,
      details: { amountPaise: amount, itemCount: items.length },
      req
    });
    db.appState = db.appState && typeof db.appState === "object" ? db.appState : {};
    const existingLocks = Array.isArray(db.appState.inventoryLocks) ? db.appState.inventoryLocks : [];
    const nowIso = new Date().toISOString();
    const newLocks = lockRows.map((row) => ({
      orderId,
      inventoryKey: row.inventoryKey,
      qty: row.qty,
      stock: row.stock,
      status: "reserved",
      createdAt: nowIso,
      expiresAt: new Date(Date.now() + INVENTORY_LOCK_TTL_MS).toISOString()
    }));
    db.appState.inventoryLocks = [...existingLocks, ...newLocks].slice(-10000);
    db.paymentAttempts = db.paymentAttempts.slice(0, 1000);
    await writeDB(db);
    await writeTopLevelPaymentAttempt(order).catch((error) => {
      addLog("Payment create attempt Firestore mirror skipped: " + error.message, "warn");
    });
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
      verificationConfigured: isRazorpayConfigured(),
      razorpayConfigured: razorpay.configured,
      keyId: getRazorpayKeyId(),
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

app.post("/api/payments/verify", paymentRateLimit, async (req, res) => {
  try {
    const payload = req.body || {};
    const verification = verifyRazorpaySignature(payload);
    let paymentDetails = null;
    if (verification.verified && payload.razorpay_payment_id) {
      paymentDetails = await fetchRazorpayPaymentDetails(payload.razorpay_payment_id);
    }
    const db = await readDB();
    cleanupInventoryLocks(db);
    const attemptId = payload.razorpay_order_id || payload.localOrderId || "";
    const index = findPaymentAttemptIndexByRazorpay(db, {
      orderId: payload.razorpay_order_id || payload.localOrderId || "",
      paymentId: payload.razorpay_payment_id || ""
    });

    if (index > -1) {
      db.paymentAttempts[index] = {
        ...db.paymentAttempts[index],
        status: verification.verified ? "paid" : "verification_failed",
        razorpayPaymentId: payload.razorpay_payment_id || "",
        razorpaySignature: payload.razorpay_signature || "",
        verificationConfigured: verification.configured,
        verificationMessage: verification.message,
        razorpayPaymentDetails: paymentDetails && paymentDetails.ok ? paymentDetails.payment : null,
        paymentInstrument: paymentDetails && paymentDetails.instrument ? paymentDetails.instrument : null,
        updatedAt: new Date().toISOString()
      };
      await writeTopLevelPaymentAttempt(db.paymentAttempts[index]).catch((error) => {
        addLog("Payment attempt Firestore mirror skipped: " + error.message, "warn");
      });
    } else {
      const nextAttempt = {
        id: attemptId || makePaymentOrderId(),
        status: verification.verified ? "paid" : "verification_failed",
        razorpayPaymentId: payload.razorpay_payment_id || "",
        verificationConfigured: verification.configured,
        verificationMessage: verification.message,
        razorpayPaymentDetails: paymentDetails && paymentDetails.ok ? paymentDetails.payment : null,
        paymentInstrument: paymentDetails && paymentDetails.instrument ? paymentDetails.instrument : null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      db.paymentAttempts.unshift(nextAttempt);
      await writeTopLevelPaymentAttempt(nextAttempt).catch((error) => {
        addLog("Payment attempt Firestore mirror skipped: " + error.message, "warn");
      });
    }

    const paymentAttempt = index > -1 ? db.paymentAttempts[index] : {};
    const lockOrderId = pickInventoryLockOrderId(paymentAttempt, payload.localOrderId || attemptId);
    if (verification.verified) releaseInventoryLock(db, lockOrderId, "committed");
    else releaseInventoryLock(db, lockOrderId, "released");
    let order = null;
    if (verification.verified) {
      const draft = payload.orderDraft && typeof payload.orderDraft === "object" ? payload.orderDraft : null;
      if (!draft) {
        releaseInventoryLock(db, lockOrderId, "released");
        await writeDB(db);
        return res.status(400).json({
          ok: false,
          verified: true,
          error: "Verified payment cannot create order without order draft"
        });
      }
      const expectedAmount = Math.round(toNumber(paymentAttempt.amount || 0));
      const draftAmount = Math.round(toNumber(draft.finalAmount || draft.total || draft.amount || draft.paidAmount) * 100);
      if (expectedAmount > 0 && draftAmount > 0 && expectedAmount !== draftAmount) {
        if (index > -1) {
          db.paymentAttempts[index] = {
            ...db.paymentAttempts[index],
            status: "amount_mismatch",
            verificationMessage: "Payment amount did not match checkout total",
            updatedAt: new Date().toISOString()
          };
        }
        releaseInventoryLock(db, lockOrderId, "released");
        await writeDB(db);
        return res.status(409).json({
          ok: false,
          verified: true,
          error: "Payment amount did not match checkout total"
        });
      }
      const orderId = String(draft.id || payload.localOrderId || paymentAttempt.id || makePaymentOrderId());
      const existingIndex = findOrderIndex(db, (item) => String(item.id) === orderId);
      const existing = existingIndex > -1 ? db.orders[existingIndex] : {};
      order = normalizeOrderForDb({
        ...existing,
        ...draft,
        id: orderId,
        userId: String(draft.userId || draft.email || draft.customerEmail || ""),
        authUserId: String(draft.authUserId || draft.firebaseUid || ""),
        firebaseUid: String(draft.firebaseUid || draft.authUserId || ""),
        payment: "Paid Successfully",
        paymentStatus: "Paid Successfully",
        payment_id: payload.razorpay_payment_id || "",
        razorpay_order_id: payload.razorpay_order_id || "",
        razorpay_signature: payload.razorpay_signature || "",
        verification,
        paymentMethod: paymentDetails && paymentDetails.instrument ? paymentDetails.instrument.method : draft.paymentMethod || "online",
        paymentInstrument: paymentDetails && paymentDetails.instrument ? paymentDetails.instrument : draft.paymentInstrument || null,
        paymentInstrumentLabel: draft.paymentInstrumentLabel || "",
        razorpayPaymentDetails: paymentDetails && paymentDetails.ok ? paymentDetails.payment : null,
        status: "Confirmed",
        paymentCompletedAt: new Date().toISOString()
      });
      order.shiprocket = {
        ...(existing.shiprocket || {}),
        status: existing.shiprocket?.status || "pending"
      };
      if (existingIndex > -1) db.orders[existingIndex] = order;
      else db.orders.unshift(order);
      db.orders = db.orders.slice(0, 5000);
      if (index > -1) {
        db.paymentAttempts[index] = {
          ...db.paymentAttempts[index],
          createdOrderId: order.id
        };
      }
      const finalAttempt = index > -1 ? db.paymentAttempts[index] : db.paymentAttempts.find((attempt) => String(attempt.id || "") === String(attemptId || order.id));
      if (finalAttempt) {
        await writeTopLevelPaymentAttempt(finalAttempt).catch((error) => {
          addLog("Payment attempt Firestore mirror skipped: " + error.message, "warn");
        });
      }
      const orderUserIds = [
        order.authUserId,
        order.firebaseUid,
        draft.authUserId,
        draft.firebaseUid,
        order.userId,
        order.email,
        order.customerEmail
      ];
      await mirrorOrderToCustomerProfile(db, order);
      recordUserActivity(db, {
        type: "order_created",
        email: order.email || order.customerEmail,
        phone: order.phone || order.customerPhone,
        orderId: order.id,
        paymentId: payload.razorpay_payment_id || "",
        status: "success",
        details: { total: order.total, itemCount: Array.isArray(order.items) ? order.items.length : 0 },
        req
      });
      recordUserActivity(db, {
        type: "payment_success",
        email: order.email || order.customerEmail,
        phone: order.phone || order.customerPhone,
        orderId: order.id,
        paymentId: payload.razorpay_payment_id || "",
        status: "paid",
        details: { razorpayOrderId: payload.razorpay_order_id || "" },
        req
      });
      await writeTopLevelOrder(order);
      await deleteTopLevelUserDocs("carts", orderUserIds);
      await deleteTopLevelUserDocs("checkoutDrafts", orderUserIds);
    }
    if (!verification.verified) {
      recordUserActivity(db, {
        type: "payment_failed",
        orderId: attemptId,
        paymentId: payload.razorpay_payment_id || "",
        status: "verification_failed",
        details: { message: verification.message },
        req
      });
    }
    await writeDB(db);
    if (order) {
      await sendOrderEmail(db, order, "Confirmed", "order-created").catch((emailError) => {
        addLog("Order confirmation email failed: " + emailError.message, "error");
      });
    }
    addLog(`Payment verify ${verification.verified ? "passed" : "blocked"}: ${attemptId || "unknown"}`, verification.verified ? "success" : "warn");

    res.status(verification.verified ? 200 : 202).json({
      ok: verification.verified,
      ...verification
      ,
      paymentDetails: paymentDetails && paymentDetails.ok ? paymentDetails.payment : null,
      instrument: paymentDetails && paymentDetails.instrument ? paymentDetails.instrument : null,
      order,
      paymentLookupConfigured: paymentDetails ? paymentDetails.configured : isRazorpayConfigured(),
      paymentLookupMessage: paymentDetails ? paymentDetails.message : ""
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

app.post("/api/payments/webhook", webhookRateLimit, async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const signature = req.get("x-razorpay-signature") || "";
    const verification = verifyRazorpayWebhookSignature(rawBody, signature);
    if (!verification.verified) {
      addLog("Razorpay webhook rejected: " + verification.message, "error");
      return res.status(401).json({ ok: false, ...verification });
    }

    const payload = JSON.parse(rawBody.toString("utf8") || "{}");
    const event = String(payload.event || "").trim();
    const payment = getRazorpayWebhookEntity(payload, "payment");
    const refund = getRazorpayWebhookEntity(payload, "refund");
    const orderId = payment.order_id || refund.order_id || "";
    const paymentId = payment.id || refund.payment_id || "";
    const refundId = refund.id || "";
    const now = new Date().toISOString();
    const db = await readDB();

    const attemptIndex = findPaymentAttemptIndexByRazorpay(db, { orderId, paymentId, refundId });
    const paymentStatus = event.includes("failed")
      ? "failed"
      : event.includes("refund")
        ? "refunded"
        : event.includes("captured")
          ? "paid"
          : event || "webhook_received";

    const attemptPatch = {
      status: paymentStatus,
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpayWebhookEvent: event,
      razorpayWebhookAt: now,
      razorpayPaymentDetails: Object.keys(payment || {}).length ? payment : undefined,
      updatedAt: now
    };
    if (refundId) {
      attemptPatch.refundId = refundId;
      attemptPatch.razorpayRefundId = refundId;
      attemptPatch.refundStatus = refund.status || paymentStatus;
      attemptPatch.refundAmount = refund.amount ? Math.round(toNumber(refund.amount) / 100) : undefined;
      attemptPatch.refundRaw = refund;
    }

    if (attemptIndex > -1) {
      db.paymentAttempts[attemptIndex] = {
        ...db.paymentAttempts[attemptIndex],
        ...Object.fromEntries(Object.entries(attemptPatch).filter(([, value]) => value !== undefined))
      };
    } else {
      db.paymentAttempts.unshift({
        id: orderId || paymentId || refundId || makePaymentOrderId(),
        createdAt: now,
        ...Object.fromEntries(Object.entries(attemptPatch).filter(([, value]) => value !== undefined))
      });
    }

    const orderIndex = findOrderIndexByRazorpay(db, { orderId, paymentId, refundId });
    if (orderIndex > -1) {
      const current = db.orders[orderIndex];
      const history = Array.isArray(current.statusHistory) ? current.statusHistory : [];
      const orderPatch = {
        razorpayOrderId: current.razorpayOrderId || orderId,
        razorpayPaymentId: current.razorpayPaymentId || paymentId,
        razorpayWebhookEvent: event,
        razorpayWebhookAt: now,
        updatedAt: now
      };
      if (event.includes("payment.captured")) {
        orderPatch.payment = "Paid Successfully";
        orderPatch.paymentStatus = "Paid Successfully";
      }
      if (event.includes("payment.failed")) {
        orderPatch.payment = "Failed";
        orderPatch.paymentStatus = "Failed";
      }
      if (event.includes("refund")) {
        orderPatch.payment = "Refund Initiated";
        orderPatch.paymentStatus = "Refund Initiated";
        orderPatch.refundStatus = refund.status || "Refund Updated";
        orderPatch.refundId = refundId || current.refundId || "";
        orderPatch.razorpayRefundId = refundId || current.razorpayRefundId || "";
        orderPatch.refundAmount = refund.amount ? Math.round(toNumber(refund.amount) / 100) : current.refundAmount;
        orderPatch.refundRaw = refund;
      }
      db.orders[orderIndex] = {
        ...current,
        ...orderPatch,
        statusHistory: [
          ...history,
          {
            status: orderPatch.refundStatus || orderPatch.paymentStatus || event,
            time: now,
            note: "Razorpay webhook: " + event
          }
        ]
      };
    }

    const matchedAttempt = attemptIndex > -1 ? db.paymentAttempts[attemptIndex] : {};
    const lockOrderId = pickInventoryLockOrderId(matchedAttempt, orderId);
    if (paymentStatus === "paid") releaseInventoryLock(db, lockOrderId, "committed");
    if (paymentStatus === "failed" || paymentStatus === "refunded") releaseInventoryLock(db, lockOrderId, "released");
    db.paymentAttempts = db.paymentAttempts.slice(0, 1000);
    await writeDB(db);
    addLog("Razorpay webhook processed: " + (event || "unknown"), "success");
    res.json({ ok: true, event, paymentId, orderId, refundId, matchedOrder: orderIndex > -1 });
  } catch (error) {
    addLog("Razorpay webhook failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Razorpay webhook processing failed" });
  }
});

app.post("/api/payments/attempts", paymentRateLimit, async (req, res) => {
  try {
    if (!requireDurablePersistence(res)) return;
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

    recordUserActivity(db, {
      type: String(payload.status || "").toLowerCase() === "cancelled" ? "payment_cancelled" : "payment_attempt",
      email: normalizeAccountEmail(payload.email || payload.customerEmail || payload.user || payload.checkoutData?.email || ""),
      phone: normalizeAccountPhone(payload.phone || payload.customerPhone || payload.checkoutData?.phone || ""),
      orderId: id,
      paymentId: payload.paymentId || payload.razorpayPaymentId || payload.detail?.paymentId || payload.detail?.razorpay_payment_id || "",
      status: payload.status || "",
      details: { amount: payload.amount || 0 },
      req
    });
    db.paymentAttempts = db.paymentAttempts.slice(0, 1000);
    await writeDB(db);
    await writeTopLevelPaymentAttempt(attempt).catch((error) => {
      addLog("Payment attempt Firestore mirror skipped: " + error.message, "warn");
    });
    res.json({ ok: true, attempt });
  } catch (error) {
    addLog("Payment attempt save failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Failed to save payment attempt" });
  }
});

app.get("/api/payments/attempts", requireAdminSession, async (req, res) => {
  try {
    const db = await readDB();
    const topLevelAttempts = await readTopLevelFirestoreCollection("paymentAttempts");
    const attempts = mergeRecordsById(topLevelAttempts, db.paymentAttempts || []);
    res.json({
      ok: true,
      attempts
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: "Failed to load payment attempts" });
  }
});

app.post("/api/products", async (req, res) => {
  return productPersistenceDisabledResponse(res);
});

app.put("/api/products/:id", async (req, res) => {
  return productPersistenceDisabledResponse(res);
});

app.delete("/api/products/:id", async (req, res) => {
  return productPersistenceDisabledResponse(res);
});

app.post("/api/pricing/run", async (req, res) => {
  return res.status(410).json({
    ok: false,
    error: "Legacy backend pricing write disabled. Railway may analyze pricing, but product records must be updated in Firestore only."
  });
});

app.post("/api/products/:id/recalculate", async (req, res) => {
  return res.status(410).json({
    ok: false,
    error: "Legacy backend product recalculation disabled. Railway may calculate pricing, but product records must be updated in Firestore only."
  });
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

    try {
      browser = await createBrowser();
    } catch (browserError) {
      addLog("Browser launch failed for single competitor fetch, using HTML fallback: " + browserError.message, "warn");
      browser = null;
    }

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
    const incomingProducts = Array.isArray(payload.products) ? payload.products : [];
    if (!incomingProducts.length) {
      return res.status(400).json({
        ok: false,
        error: "Explicit products payload is required. Legacy backend product database is disabled."
      });
    }
    const productsToProcess = incomingProducts.map((product) => normalizeProduct(product, product));

    try {
      browser = await createBrowser();
    } catch (browserError) {
      addLog("Browser launch failed for product-name search, using HTML fallback: " + browserError.message, "warn");
      browser = null;
    }
    const updatedProducts = [];

    for (const product of productsToProcess) {
      const result = await syncCompetitorPricesForProduct(product, {
        searchMode: payload.searchMode || "product_name_size",
        searchTarget: payload.searchTarget || "all"
      }, browser);

      updatedProducts.push(result.product);
    }
    addLog(`Product-name auto search completed for ${updatedProducts.length} products without persistence`, "success");

    res.json({
      ok: true,
      count: updatedProducts.length,
      products: updatedProducts
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
    const products = Array.isArray(payload.products) ? payload.products.map((product) => normalizeProduct(product, product)) : [];
    if (!products.length) {
      return res.status(400).json({
        ok: false,
        error: "Explicit products payload is required. Legacy backend product database is disabled."
      });
    }
    const updatedProducts = [];

    try {
      browser = await createBrowser();
    } catch (browserError) {
      addLog("Browser launch failed for bulk competitor sync, using HTML fallback: " + browserError.message, "warn");
      browser = null;
    }

    for (const product of products) {
      const result = await syncCompetitorPricesForProduct(product, {
        searchMode: payload.searchMode || "product_name_size",
        searchTarget: payload.searchTarget || "all"
      }, browser);
      updatedProducts.push(result.product);
    }
    addLog(`Bulk competitor price sync completed for ${updatedProducts.length} products without persistence`, "success");

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

app.get("/api/shiprocket/config", requireAdminSession, async (req, res) => {
  const config = getShiprocketConfig();
  res.json({
    ok: true,
    configured: Boolean(config.SHIPROCKET_TOKEN || (config.SHIPROCKET_EMAIL && config.SHIPROCKET_PASSWORD)),
    mode: config.SHIPROCKET_TOKEN ? "token" : (config.SHIPROCKET_EMAIL && config.SHIPROCKET_PASSWORD ? "login" : "missing")
  });
});

app.get("/api/shiprocket/auth-token", requireAdminSession, async (req, res) => {
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

app.post("/api/shiprocket/webhook", webhookRateLimit, async (req, res) => {
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
    await sendOrderEmail(db, db.orders[index], event.status, "shiprocket-webhook").catch((emailError) => {
      addLog("Shiprocket update email failed: " + emailError.message, "error");
    });
    addLog(`Shiprocket webhook updated order ${db.orders[index].id}: ${event.status}`, "info");
    res.json({ ok: true, matched: true, order: db.orders[index] });
  } catch (error) {
    addLog("Shiprocket webhook failed: " + error.message, "error");
    res.status(500).json({ ok: false, error: "Webhook processing failed" });
  }
});

app.use((error, req, res, next) => {
  console.error("[express error]", req.method, req.originalUrl, error);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

const ROOT_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Swadra Backend</title>
    <style>
      body { font-family: Arial, sans-serif; background: #f8f5f2; color: #222; padding: 40px; }
      .box { max-width: 800px; margin: auto; background: #fff; padding: 24px; border-radius: 18px; box-shadow: 0 10px 28px rgba(0,0,0,0.08); }
      h1 { color: #7a3d3d; margin-top: 0; }
      code { background: #f1ece8; padding: 3px 6px; border-radius: 6px; }
      ul { line-height: 1.8; }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>Swadra Secure Backend Running</h1>
      <p>Railway is restricted to secure server-side tasks. Product catalog storage stays in Firestore and product images stay in Cloudinary.</p>
      <ul>
        <li><code>GET /health</code></li>
        <li><code>GET /api/logs</code></li>
        <li><code>GET /api/admin/config</code></li>
        <li><code>POST /api/admin/login</code></li>
        <li><code>POST /api/admin/logout</code></li>
        <li><code>POST /api/admin/logout-all</code></li>
        <li><code>GET /api/admin/backup/export</code></li>
        <li><code>GET /api/admin/reconciliation-reports</code></li>
        <li><code>POST /api/admin/reconciliation-reports</code></li>
        <li><code>POST /api/admin/credentials</code></li>
        <li><code>GET /api/coupons</code></li>
        <li><code>POST /api/coupons</code></li>
        <li><code>DELETE /api/coupons/:code</code></li>
        <li><code>GET /api/app-state</code></li>
        <li><code>GET /api/app-state/bootstrap</code></li>
        <li><code>POST /api/app-state</code></li>
        <li><code>POST /api/orders</code></li>
        <li><code>GET /api/orders/:id</code></li>
        <li><code>POST /api/orders/:id/cancel</code></li>
        <li><code>POST /api/orders/:id/return-request</code></li>
        <li><code>GET /api/orders/user/:userId</code></li>
        <li><code>POST /api/abandoned-cart</code></li>
        <li><code>POST /api/abandoned-cart/recovered</code></li>
        <li><code>GET /api/admin/abandoned-carts</code></li>
        <li><code>POST /api/admin/abandoned-carts/:id/remind</code></li>
        <li><code>GET /api/admin/return-requests</code></li>
        <li><code>PATCH /api/admin/return-requests/:id</code></li>
        <li><code>POST /api/payments/create-order</code></li>
        <li><code>POST /api/payments/verify</code></li>
        <li><code>POST /api/payments/webhook</code></li>
        <li><code>POST /api/payments/attempts</code></li>
        <li><code>GET /api/payments/attempts</code></li>
        <li><code>POST /api/pricing/fetch-competitor-prices</code></li>
        <li><code>POST /api/pricing/search-by-product-name</code></li>
        <li><code>POST /api/pricing/fetch-all-competitor-prices</code></li>
        <li><code>GET /api/shiprocket/config</code></li>
        <li><code>GET /api/shiprocket/auth-token</code></li>
        <li><code>GET /api/shiprocket/track/:awb</code></li>
        <li><code>POST /api/shiprocket/webhook</code></li>
        <li><code>GET|POST|PUT|DELETE /api/products</code> disabled</li>
        <li><code>POST /api/pricing/run</code> disabled</li>
        <li><code>POST /api/products/:id/recalculate</code> disabled</li>
      </ul>
    </div>
  </body>
</html>`;

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#7a3d3d"/><text x="16" y="21" text-anchor="middle" font-size="16" font-family="Arial" fill="#fff">S</text></svg>`;

function buildCorsHeaders(req, extraHeaders = {}) {
  const origin = normalizeOrigin(req.headers.origin || "");
  const allowOrigin = (
    !origin ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ||
    ALLOWED_ORIGINS.has(origin)
  )
    ? (origin || "*")
    : "";
  return {
    ...(allowOrigin ? { "Access-Control-Allow-Origin": allowOrigin } : {}),
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-session-token",
    Vary: "Origin",
    ...extraHeaders
  };
}

function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, buildCorsHeaders(req));
    res.end();
    return true;
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ROOT_HTML);
    return true;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, buildCorsHeaders(req, {
      "Content-Type": "application/json; charset=utf-8"
    }));
    res.end(JSON.stringify({
      ok: true,
      status: USE_FIRESTORE || !IS_HOSTED_RUNTIME ? "online" : "degraded",
      persistence: USE_FIRESTORE ? "firestore" : "memory",
      hosted: IS_HOSTED_RUNTIME,
      time: new Date().toISOString()
    }));
    return true;
  }

  if (req.method === "GET" && req.url === "/favicon.ico") {
    res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
    res.end(FAVICON_SVG);
    return true;
  }

  app(req, res);
  return true;
}

function startServer() {
  const server = http.createServer(handleRequest);
  server.listen(PORT, HOST, () => {
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

  return server;
}

module.exports = {
  app,
  handleRequest,
  startServer
};

if (require.main === module) {
  startServer();
}
