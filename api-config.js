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
  window.SWADRA_PRODUCTS_API_URLS = window.SWADRA_PRODUCTS_API_URLS || [
    base + "/api/products"
  ];
  if(isLocal){
    window.SWADRA_PRODUCTS_API_URLS.push("http://localhost:3000/api/products");
  }
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
    adminProducts: true,
    adminProductsByCategory: true,
    swadraBackendProductsCache: true,
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
})();
