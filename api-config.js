(function(){
  var DEFAULT_REMOTE_BASE = "https://swadra-backend-production.up.railway.app";
  var SITE_ORIGIN = String(window.location.origin || "").trim().replace(/\/+$/, "");

  function normalizeUrl(url){
    return String(url || "").trim().replace(/\/+$/, "");
  }

  function isUnsafeProductionBase(url){
    var normalized = normalizeUrl(url);
    if(!normalized) return false;
    var isLocalBase = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized);
    if(isLocalBase) return false;
    return normalized === SITE_ORIGIN;
  }

  function readConfiguredBackendBase(){
    try{
      var saved = JSON.parse(localStorage.getItem("swadra_backend_panel_settings_v2") || "{}");
      var configured = normalizeUrl(saved.backendUrl || "");
      if(isUnsafeProductionBase(configured)){
        return "";
      }
      return configured;
    }catch(error){
      return "";
    }
  }

  var isLocal = ["localhost", "127.0.0.1"].indexOf(window.location.hostname) > -1;
  var base = window.SWADRA_API_BASE;
  if(!base){
    base = readConfiguredBackendBase();
  }
  if(!base){
    base = isLocal ? "http://127.0.0.1:3000" : DEFAULT_REMOTE_BASE;
  }

  if(!isLocal && isUnsafeProductionBase(base)){
    base = DEFAULT_REMOTE_BASE;
  }

  base = String(base || "").replace(/\/$/, "");
  window.SWADRA_API_BASE = base;
  // Product master data is intentionally not routed through legacy backend endpoints.
  // Firestore is the only authoritative product database and Cloudinary is the only image store.
  window.SWADRA_PRODUCTS_API_URLS = [];
  window.SWADRA_ADMIN_LOGIN_URL = base + "/api/admin/login";
  window.SWADRA_ADMIN_CONFIG_URL = base + "/api/admin/config";
  window.SWADRA_ADMIN_CREDENTIALS_URL = base + "/api/admin/credentials";
  window.SWADRA_COUPONS_API_URL = base + "/api/coupons";
  window.SWADRA_APP_STATE_URL = base + "/api/app-state";
  window.SWADRA_APP_STATE_BOOTSTRAP_URL = base + "/api/app-state/bootstrap";

  var persistentKeys = {
    users: true,
    cart: true,
    currentUser: true,
    redirectAfterLogin: true,
    tempUser: true,
    otp: true,
    dashboardPasswordOtp: true,
    userPhone: true,
    checkoutData: true,
    cartSummary: true,
    couponDiscount: true,
    couponAdjustedCart: true,
    subtotal: true,
    delivery: true,
    discount: true,
    mrpTotal: true,
    gstTotal: true,
    finalTotal: true,
    checkoutUpiId: true,
    currentOrderId: true,
    supportOrderId: true,
    orderCounts: true,
    name: true,
    email: true,
    phone: true,
    address: true,
    homeContent: true,
    offers: true,
    swadraHeaderSearch: true,
    adminProductsUpdatedAt: true,
    adminCustomersUpdatedAt: true,
    customers: true,
    customersUpdatedAt: true,
    heroVideoUpdatedAt: true,
    heroImagesUpdatedAt: true,
    adminCoupons: true,
    adminCoupon: true,
    swadraPaymentSession: true,
    swadraPaymentAttempts: true,
    swadraPaymentAnalytics: true,
    ORDER_STATUS_OVERRIDE_KEY: true,
    PAYMENT_REVIEW_KEY: true,
    CUSTOMER_PAUSE_KEY: true,
    DELETED_CUSTOMERS_KEY: true
  };
  var syncTimer = null;
  var pendingState = {};
  var pendingRemove = {};
  var applyingRemoteState = false;

  function safeParse(value, fallback){
    if(value === null || value === undefined || value === "") return fallback;
    try{ return JSON.parse(value); }catch(e){ return fallback; }
  }

  function safeStringify(value){
    if(value === undefined) return "null";
    if(typeof value === "string") return value;
    try{ return JSON.stringify(value); }catch(e){ return "null"; }
  }

  function readStoredValue(key){
    var raw = localStorage.getItem(key);
    if(raw === null) return null;
    if(raw === "true") return true;
    if(raw === "false") return false;
    if(raw !== "" && !isNaN(raw) && String(Number(raw)) === raw) return Number(raw);
    try{ return JSON.parse(raw); }catch(e){ return raw; }
  }

  function writeLocalValue(key, value){
    if(value === undefined || value === null){
      localStorage.removeItem(key);
      return;
    }
    if(typeof value === "string"){
      localStorage.setItem(key, value);
      return;
    }
    localStorage.setItem(key, JSON.stringify(value));
  }

  function syncCartFromUsers(){
    var currentUser = localStorage.getItem("currentUser");
    if(!currentUser) return;
    var users = safeParse(localStorage.getItem("users"), {});
    if(users && users[currentUser] && Array.isArray(users[currentUser].cart)){
      localStorage.setItem("cart", JSON.stringify(users[currentUser].cart));
    }
  }

  function queueSync(key, value, remove){
    if(!persistentKeys[key]) return;
    if(remove){
      delete pendingState[key];
      pendingRemove[key] = true;
    }else{
      pendingState[key] = value;
      delete pendingRemove[key];
    }
    if(syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(flushSync, 250);
  }

  function flushSync(){
    syncTimer = null;
    var state = pendingState;
    var removeKeys = Object.keys(pendingRemove);
    pendingState = {};
    pendingRemove = {};
    if(!Object.keys(state).length && !removeKeys.length) return;
    fetch(window.SWADRA_APP_STATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: state, removeKeys: removeKeys }),
      keepalive: true
    }).catch(function(){});
  }

  function bootstrapRemoteState(){
    try{
      var xhr = new XMLHttpRequest();
      xhr.open("GET", window.SWADRA_APP_STATE_BOOTSTRAP_URL, false);
      xhr.send(null);
      if(xhr.status < 200 || xhr.status >= 300) return;
      var response = safeParse(xhr.responseText, {});
      if(!response || !response.ok || !response.state) return;
      applyingRemoteState = true;
      Object.keys(response.state).forEach(function(key){
        writeLocalValue(key, response.state[key]);
      });
      syncCartFromUsers();
    }catch(e){
    }finally{
      applyingRemoteState = false;
    }
  }

  function wrapLocalStorage(){
    if(!window.localStorage) return;
    var originalSetItem = localStorage.setItem.bind(localStorage);
    var originalRemoveItem = localStorage.removeItem.bind(localStorage);

    localStorage.setItem = function(key, value){
      originalSetItem(key, value);

      if(applyingRemoteState) return;

      if(key === "cart"){
        var currentUser = localStorage.getItem("currentUser");
        if(currentUser){
          var users = safeParse(localStorage.getItem("users"), {});
          if(!users[currentUser] || typeof users[currentUser] !== "object"){
            users[currentUser] = {};
          }
          users[currentUser].cart = safeParse(value, []);
          originalSetItem("users", JSON.stringify(users));
          queueSync("users", users, false);
        }
      }

      if(persistentKeys[key]){
        queueSync(key, readStoredValue(key), false);
      }
    };

    localStorage.removeItem = function(key){
      originalRemoveItem(key);

      if(applyingRemoteState) return;

      if(key === "cart"){
        var currentUser = localStorage.getItem("currentUser");
        if(currentUser){
          var users = safeParse(localStorage.getItem("users"), {});
          if(users[currentUser] && typeof users[currentUser] === "object"){
            users[currentUser].cart = [];
            originalSetItem("users", JSON.stringify(users));
            queueSync("users", users, false);
          }
        }
      }

      if(persistentKeys[key]){
        queueSync(key, null, true);
      }
    };
  }

  bootstrapRemoteState();
  wrapLocalStorage();

  var firebaseConfig = {
    apiKey: "AIzaSyCJbp-RNZTeV0u0k1UzDL2DCXvVkq4Az5I",
    authDomain: "swadra-organics-db127.firebaseapp.com",
    projectId: "swadra-organics-db127",
    storageBucket: "swadra-organics-db127.appspot.com",
    messagingSenderId: "830329896896",
    appId: "1:830329896896:web:b5c36aa527f3d04439d225"
  };
  var firestoreDb = null;
  var firebaseInitError = null;
  var cloudinaryEndpoint = "https://api.cloudinary.com/v1_1/djimhrjf/image/upload";
  var cloudinaryPreset = "swadra_products";

  function initFirebaseIfNeeded(){
    if(firestoreDb || firebaseInitError) return firestoreDb;
    try{
      if(!window.firebase || typeof window.firebase.initializeApp !== "function" || typeof window.firebase.firestore !== "function"){
        throw new Error("Firebase scripts not loaded");
      }
      if(!window.firebase.apps || !window.firebase.apps.length){
        window.firebase.initializeApp(firebaseConfig);
      }
      firestoreDb = window.firebase.firestore();
    }catch(error){
      firebaseInitError = error;
      console.error("firebase init failed", error);
    }
    return firestoreDb;
  }

  function normalizeProductRecord(product, fallbackId){
    var item = product && typeof product === "object" ? product : {};
    var rawImages = Array.isArray(item.images) ? item.images : [];
    var imageUrl = String(item.imageUrl || item.image || rawImages[0] || "").trim();
    var images = rawImages
      .map(function(value){ return String(value || "").trim(); })
      .filter(Boolean)
      .slice(0,4);
    if(!images.length && imageUrl){
      images = [imageUrl];
    }
    if(images.length && !imageUrl){
      imageUrl = images[0];
    }
    var summary = String(item.summary || item.productSummary || item.description || item.desc || "").trim();
    var normalizedId = item.id !== undefined && item.id !== null && String(item.id).trim() ? item.id : fallbackId;
    return {
      id: normalizedId,
      docId: String(item.docId || normalizedId || fallbackId || "").trim(),
      name: String(item.name || item.productName || "").trim(),
      price: Number(item.price ?? item.sellingPrice ?? 0) || 0,
      mrp: Number(item.mrp ?? item.price ?? item.sellingPrice ?? 0) || 0,
      category: String(item.category || "").trim(),
      size: String(item.size || item.productSize || "").trim(),
      stockQty: Number(item.stockQty ?? item.stock ?? 0) || 0,
      availability: String(item.availability || (item.outOfStock ? "Out of Stock" : "Available") || "Available"),
      summary: summary,
      productSummary: summary,
      description: summary,
      image: imageUrl,
      imageUrl: imageUrl,
      images: images,
      bestseller: !!item.bestseller,
      combo: !!item.combo,
      special: !!item.special,
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null
    };
  }

  async function fetchFirestoreProducts(){
    var db = initFirebaseIfNeeded();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    var snapshot = await db.collection("products").get();
    var products = [];
    snapshot.forEach(function(doc){
      products.push(normalizeProductRecord(doc.data(), doc.id));
    });
    return products;
  }

  async function uploadImagesToCloudinary(files){
    var list = Array.isArray(files) ? files.filter(Boolean) : [];
    var uploaded = [];
    for(var i=0;i<list.length;i++){
      var file = list[i];
      var formData = new FormData();
      formData.append("file", file);
      formData.append("upload_preset", cloudinaryPreset);
      var response = await fetch(cloudinaryEndpoint, {
        method: "POST",
        body: formData
      });
      var data = await response.json().catch(function(){ return {}; });
      if(!response.ok || !data.secure_url){
        throw new Error((data && data.error && data.error.message) || "Cloudinary upload failed");
      }
      uploaded.push(String(data.secure_url).trim());
    }
    return uploaded;
  }

  async function saveFirestoreProduct(product){
    var db = initFirebaseIfNeeded();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    var normalized = normalizeProductRecord(product, product && product.id);
    if(/^data:image\//i.test(String(normalized.image || ""))){
      throw new Error("Base64 product images are blocked. Upload to Cloudinary first.");
    }
    if((normalized.images || []).some(function(image){ return /^data:image\//i.test(String(image || "")); })){
      throw new Error("Base64 product images are blocked. Upload to Cloudinary first.");
    }
    if(normalized.id === undefined || normalized.id === null || String(normalized.id).trim() === ""){
      normalized.id = Date.now();
    }
    normalized.docId = String(normalized.docId || normalized.id);
    normalized.image = String(normalized.imageUrl || normalized.image || "").trim();
    normalized.imageUrl = normalized.image;
    normalized.images = Array.isArray(normalized.images) && normalized.images.length ? normalized.images.slice(0,4) : (normalized.image ? [normalized.image] : []);
    var nowIso = new Date().toISOString();
    var payload = {
      id: normalized.id,
      name: normalized.name,
      price: normalized.price,
      mrp: normalized.mrp,
      category: normalized.category,
      size: normalized.size,
      stockQty: normalized.stockQty,
      availability: normalized.availability,
      summary: normalized.summary,
      productSummary: normalized.productSummary,
      description: normalized.description,
      image: normalized.image,
      imageUrl: normalized.imageUrl,
      images: normalized.images,
      bestseller: normalized.bestseller,
      combo: normalized.combo,
      special: normalized.special,
      updatedAt: nowIso
    };
    if(normalized.createdAt){
      payload.createdAt = normalized.createdAt;
    }else{
      payload.createdAt = nowIso;
    }
    await db.collection("products").doc(normalized.docId).set(payload, { merge:true });
    return normalizeProductRecord(payload, normalized.docId);
  }

  async function deleteFirestoreProduct(id){
    var db = initFirebaseIfNeeded();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    await db.collection("products").doc(String(id)).delete();
    return true;
  }

  window.SWADRA_PRODUCT_DATA = {
    firebaseConfig: firebaseConfig,
    normalizeProduct: normalizeProductRecord,
    initFirebaseIfNeeded: initFirebaseIfNeeded,
    uploadImagesToCloudinary: uploadImagesToCloudinary,
    fetchFirestoreProducts: fetchFirestoreProducts,
    fetchProducts: async function(){
      return fetchFirestoreProducts();
    },
    saveProduct: saveFirestoreProduct,
    deleteProduct: deleteFirestoreProduct
  };
})();
