const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const DB_PATH = path.join(__dirname, "db.json");
const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION || "appData";
const FIRESTORE_DOCUMENT = process.env.FIRESTORE_DOCUMENT || "swadra";
const FIRESTORE_LISTS = ["products", "orders", "paymentAttempts", "logs"];

function normalizeDB(data) {
  const now = new Date().toISOString();
  const db = data && typeof data === "object" ? data : {};
  return {
    products: Array.isArray(db.products) ? db.products : [],
    orders: Array.isArray(db.orders) ? db.orders : [],
    paymentAttempts: Array.isArray(db.paymentAttempts) ? db.paymentAttempts : [],
    logs: Array.isArray(db.logs) ? db.logs : [],
    meta: {
      ...(db.meta && typeof db.meta === "object" ? db.meta : {}),
      migratedAt: now,
      updatedAt: now
    }
  };
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`db.json not found at ${DB_PATH}`);
  }

  if (!admin.apps.length) {
    admin.initializeApp();
  }

  const raw = fs.readFileSync(DB_PATH, "utf8");
  const db = normalizeDB(JSON.parse(raw || "{}"));

  const firestore = admin.firestore();
  const rootRef = firestore.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOCUMENT);
  await rootRef.set({ meta: db.meta }, { merge: true });

  for (const name of FIRESTORE_LISTS) {
    const items = db[name] || [];
    let batch = firestore.batch();
    let count = 0;

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index] || {};
      const id = String(item.id || item.orderId || item.attemptId || `${name}_${index}`).replace(/\//g, "_");
      batch.set(rootRef.collection(name).doc(id), { ...item, id: item.id || id }, { merge: false });
      count += 1;

      if (count >= 400) {
        await batch.commit();
        batch = firestore.batch();
        count = 0;
      }
    }

    if (count > 0) {
      await batch.commit();
    }
  }

  console.log(`Migrated db.json to Firestore root: ${FIRESTORE_COLLECTION}/${FIRESTORE_DOCUMENT}`);
  console.log("Subcollections: products, orders, paymentAttempts, logs");
  console.log(`products=${db.products.length}, orders=${db.orders.length}, paymentAttempts=${db.paymentAttempts.length}, logs=${db.logs.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
