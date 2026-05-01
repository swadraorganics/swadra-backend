(function(){
  if("serviceWorker" in navigator && /^https?:$/.test(location.protocol) && !window.__swadraPwaRegistered){
    window.__swadraPwaRegistered = true;
    window.addEventListener("load", function(){
      navigator.serviceWorker.register("/sw.js").catch(function(error){
        console.warn("Swadra service worker registration failed", error);
      });
    });
  }

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

  var runtimeSessionStore = window.__swadraRuntimeSessionStore = window.__swadraRuntimeSessionStore || {};
  var runtimeLocalStore = window.__swadraRuntimeLocalStore = window.__swadraRuntimeLocalStore || {};
  var runtimeReviewStore = window.__swadraRuntimeReviewStore = window.__swadraRuntimeReviewStore || {};
  var runtimeBackendPanelSettings = window.__swadraBackendPanelSettings = window.__swadraBackendPanelSettings || {};
  var WINDOW_NAME_STATE_KEY = "__swadraRuntimeState__";

  function readWindowNameState(){
    try{
      var rawName = String(window.name || "").trim();
      if(!rawName) return {};
      var parsed = JSON.parse(rawName);
      return parsed && typeof parsed === "object" ? parsed : {};
    }catch(error){
      return {};
    }
  }

  function writeWindowNameState(nextState){
    try{
      window.name = JSON.stringify(nextState && typeof nextState === "object" ? nextState : {});
    }catch(error){
      // Ignore serialization failures so browsing flow keeps working.
    }
  }

  function syncRuntimeStoresFromWindowName(){
    var payload = readWindowNameState();
    var persistedState = payload && typeof payload === "object" ? payload[WINDOW_NAME_STATE_KEY] : null;
    if(!persistedState || typeof persistedState !== "object"){
      return;
    }
    var persistedSession = persistedState.session && typeof persistedState.session === "object" ? persistedState.session : {};
    var persistedLocal = persistedState.local && typeof persistedState.local === "object" ? persistedState.local : {};
    Object.keys(persistedSession).forEach(function(key){
      if(!Object.prototype.hasOwnProperty.call(runtimeSessionStore, key)){
        runtimeSessionStore[key] = String(persistedSession[key]);
      }
    });
    Object.keys(persistedLocal).forEach(function(key){
      if(!Object.prototype.hasOwnProperty.call(runtimeLocalStore, key)){
        runtimeLocalStore[key] = String(persistedLocal[key]);
      }
    });
  }

  function persistRuntimeStoresToWindowName(){
    var payload = readWindowNameState();
    payload[WINDOW_NAME_STATE_KEY] = {
      session: Object.assign({}, runtimeSessionStore),
      local: Object.assign({}, runtimeLocalStore)
    };
    writeWindowNameState(payload);
  }

  syncRuntimeStoresFromWindowName();

  function readConfiguredBackendBase(){
    var configured = normalizeUrl(runtimeBackendPanelSettings.backendUrl || "");
    if(isUnsafeProductionBase(configured)){
      return "";
    }
    return configured;
  }

  var isLocal = ["localhost", "127.0.0.1"].indexOf(window.location.hostname) > -1;
  var base = window.SWADRA_API_BASE;
  if(!base){
    base = readConfiguredBackendBase();
  }
  if(!base){
    base = DEFAULT_REMOTE_BASE;
  }

  if(!isLocal && isUnsafeProductionBase(base)){
    base = DEFAULT_REMOTE_BASE;
  }

  base = String(base || "").replace(/\/$/, "");
  window.SWADRA_API_BASE = base;
  window.SWADRA_SECURE_API_BASE = base;
  window.SWADRA_BUILD_SECURE_API_URL = function(path){
    var cleanPath = String(path || "").trim();
    if(!cleanPath) return base;
    return base + (cleanPath.charAt(0) === "/" ? cleanPath : "/" + cleanPath);
  };
  // Product master data is intentionally not routed through legacy backend endpoints.
  // Firestore is the only authoritative product database and Cloudinary is the only image store.
  window.SWADRA_PRODUCTS_API_URLS = [];
  window.SWADRA_ADMIN_LOGIN_URL = base + "/api/admin/login";
  window.SWADRA_ADMIN_CONFIG_URL = base + "/api/admin/config";
  window.SWADRA_ADMIN_CREDENTIALS_URL = base + "/api/admin/credentials";
  window.SWADRA_COUPONS_API_URL = base + "/api/coupons";
  window.SWADRA_APP_STATE_URL = base + "/api/app-state";

  function installGlobalSeoSafety(){
    if(typeof document === "undefined" || document.__swadraSeoSafetyInstalled) return;
    document.__swadraSeoSafetyInstalled = true;
    var pathName = String(window.location.pathname || "").split("/").pop().toLowerCase();
    var noindexPages = {
      "admin-callbacks.html": true,
      "admin-coupons.html": true,
      "admin-customers.html": true,
      "admin-dashboard.html": true,
      "admin-extra.html": true,
      "admin-home.html": true,
      "admin-index.html": true,
      "admin-order-sheet.html": true,
      "admin-orders.html": true,
      "admin-payments.html": true,
      "admin-products.html": true,
      "admin-profit.html": true,
      "admin-recovery.html": true,
      "admin-shiprocket.html": true,
      "account.html": true,
      "cart.html": true,
      "checkout.html": true,
      "dashboard.html": true,
      "invoice.html": true,
      "order.html": true,
      "payment.html": true,
      "trackorder.html": true,
      "offline.html": true,
      "404.html": true
    };
    if(/^backend\//i.test(String(window.location.pathname || ""))){
      noindexPages[pathName] = true;
    }
    function ensureMeta(selectorAttr, key, value){
      var selector = selectorAttr === "property" ? 'meta[property="' + key + '"]' : 'meta[name="' + key + '"]';
      var el = document.head.querySelector(selector);
      if(!el){
        el = document.createElement("meta");
        el.setAttribute(selectorAttr, key);
        document.head.appendChild(el);
      }
      el.setAttribute("content", value);
    }
    if(noindexPages[pathName]){
      ensureMeta("name", "robots", "noindex,nofollow,noarchive");
    }
    if(!document.head.querySelector('meta[property="og:site_name"]')){
      ensureMeta("property", "og:site_name", "Swadra Organics");
    }
    if(!document.head.querySelector('meta[name="twitter:card"]')){
      ensureMeta("name", "twitter:card", "summary_large_image");
    }
  }

  installGlobalSeoSafety();

  function installAccessibilityEnhancements(){
    if(typeof document === "undefined" || document.__swadraA11yInstalled) return;
    document.__swadraA11yInstalled = true;

    function injectA11yStyles(){
      if(document.getElementById("swadraA11yStyles")) return;
      var style = document.createElement("style");
      style.id = "swadraA11yStyles";
      style.textContent = [
        ".swadra-sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important;}",
        "a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,[tabindex]:focus-visible{outline:3px solid #ffbf47!important;outline-offset:3px!important;box-shadow:0 0 0 5px rgba(122,61,61,.22)!important;}",
        "[aria-invalid='true']{border-color:#c62828!important;box-shadow:0 0 0 3px rgba(198,40,40,.12)!important;}",
        ".swadra-field-error{margin-top:6px;color:#c62828;font-size:12px;font-weight:700;line-height:1.35;}"
      ].join("");
      document.head.appendChild(style);
    }

    function humanizeControlName(value){
      return String(value || "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, function(ch){ return ch.toUpperCase(); });
    }

    function getControlLabel(control){
      if(!control) return "";
      var explicit = control.getAttribute("aria-label") || control.getAttribute("title");
      if(explicit) return explicit;
      var id = control.id || "";
      if(id){
        var escapedId = window.CSS && typeof window.CSS.escape === "function"
          ? window.CSS.escape(id)
          : String(id).replace(/"/g, '\\"');
        var label = document.querySelector('label[for="' + escapedId + '"]');
        if(label && label.textContent.trim()) return label.textContent.trim();
      }
      var wrappingLabel = control.closest && control.closest("label");
      if(wrappingLabel && wrappingLabel.textContent.trim()) return wrappingLabel.textContent.trim();
      return control.getAttribute("placeholder") || humanizeControlName(control.name || control.id || control.type || "Field");
    }

    function ensureControlA11y(control){
      if(!control || control.__swadraA11yEnhanced) return;
      if(control.type === "hidden") return;
      control.__swadraA11yEnhanced = true;
      var tag = String(control.tagName || "").toLowerCase();
      var label = getControlLabel(control);
      if(label && !control.getAttribute("aria-label") && !control.getAttribute("aria-labelledby")){
        control.setAttribute("aria-label", label);
      }
      if((tag === "input" || tag === "textarea" || tag === "select") && !control.id){
        control.id = "swadra-field-" + Math.random().toString(36).slice(2, 10);
      }
      if(control.required && !control.getAttribute("aria-required")){
        control.setAttribute("aria-required", "true");
      }
      if(tag === "button" && !label && !control.textContent.trim()){
        control.setAttribute("aria-label", "Action");
      }
      control.addEventListener("invalid", function(){
        control.setAttribute("aria-invalid", "true");
        var message = control.validationMessage || "Please check this field.";
        var errorId = control.id + "-error";
        var error = document.getElementById(errorId);
        if(!error){
          error = document.createElement("div");
          error.id = errorId;
          error.className = "swadra-field-error";
          error.setAttribute("role", "alert");
          control.insertAdjacentElement("afterend", error);
        }
        error.textContent = message;
        control.setAttribute("aria-describedby", [control.getAttribute("aria-describedby"), errorId].filter(Boolean).join(" "));
      });
      control.addEventListener("input", function(){
        if(control.getAttribute("aria-invalid") === "true" && control.checkValidity && control.checkValidity()){
          control.removeAttribute("aria-invalid");
          var error = document.getElementById(control.id + "-error");
          if(error) error.textContent = "";
        }
      });
    }

    function ensureLiveRegions(){
      ["status","message","msg","adminLoginStatus","cartNotice","paymentStatus","requestStatus"].forEach(function(id){
        var el = document.getElementById(id);
        if(el && !el.getAttribute("aria-live")){
          el.setAttribute("aria-live", "polite");
          el.setAttribute("role", "status");
        }
      });
    }

    function enhanceAll(root){
      var scope = root && root.querySelectorAll ? root : document;
      scope.querySelectorAll("input,select,textarea,button").forEach(ensureControlA11y);
      scope.querySelectorAll("img:not([alt])").forEach(function(img){
        img.setAttribute("alt", "Swadra Organics image");
      });
      ensureLiveRegions();
    }

    injectA11yStyles();
    if(document.readyState === "loading"){
      document.addEventListener("DOMContentLoaded", function(){ enhanceAll(document); }, { once:true });
    }else{
      enhanceAll(document);
    }
    if(typeof MutationObserver === "function"){
      var observer = new MutationObserver(function(mutations){
        mutations.forEach(function(mutation){
          mutation.addedNodes.forEach(function(node){
            if(node && node.nodeType === 1) enhanceAll(node);
          });
        });
      });
      if(document.body) observer.observe(document.body, { childList:true, subtree:true });
      else document.addEventListener("DOMContentLoaded", function(){ observer.observe(document.body, { childList:true, subtree:true }); }, { once:true });
    }
  }

  installAccessibilityEnhancements();

  var ADMIN_SESSION_KEY = "swadra_admin_session_v1";
  function readWindowNameState(){
    try{
      var raw = String(window.name || "");
      if(!raw || raw.charAt(0) !== "{") return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    }catch(error){
      return {};
    }
  }
  function writeWindowNameState(nextState){
    try{
      var state = nextState && typeof nextState === "object" ? nextState : {};
      window.name = Object.keys(state).length ? JSON.stringify(state) : "";
    }catch(error){}
  }
  function getWindowNameAdminSession(){
    var state = readWindowNameState();
    var session = state[ADMIN_SESSION_KEY];
    return session && typeof session === "object" ? session : null;
  }
  function readAdminToken(){
    try{
      var raw = runtimeSessionStore[ADMIN_SESSION_KEY] || "";
      var parsed = raw ? JSON.parse(raw) : null;
      var token = String(parsed && parsed.token || "").trim();
      if(token) return token;
      var windowSession = getWindowNameAdminSession();
      return String(windowSession && windowSession.token || "").trim();
    }catch(error){
      var fallbackSession = getWindowNameAdminSession();
      return String(fallbackSession && fallbackSession.token || "").trim();
    }
  }
  window.SWADRA_SET_ADMIN_TOKEN = function(session){
    try{
      var payload = session && typeof session === "object" ? session : {};
      var token = String(payload.token || "").trim();
      if(!token) return;
      var saved = {
        ok: true,
        username: String(payload.username || "admin"),
        role: String(payload.role || "owner"),
        token: token,
        expiresAt: String(payload.expiresAt || ""),
        loginAt: Date.now()
      };
      runtimeSessionStore[ADMIN_SESSION_KEY] = JSON.stringify(saved);
      var state = readWindowNameState();
      state[ADMIN_SESSION_KEY] = saved;
      writeWindowNameState(state);
    }catch(error){}
  };
  window.SWADRA_CLEAR_ADMIN_TOKEN = function(){
    try{
      delete runtimeSessionStore[ADMIN_SESSION_KEY];
      var state = readWindowNameState();
      delete state[ADMIN_SESSION_KEY];
      writeWindowNameState(state);
    }catch(error){}
  };
  if(!window.__swadraAdminFetchPatched && window.fetch){
    window.__swadraAdminFetchPatched = true;
    var nativeFetch = window.fetch.bind(window);
    window.fetch = function(input, init){
      var url = typeof input === "string" ? input : (input && input.url ? input.url : "");
      var target = String(url || "");
      var normalizedTarget = target.indexOf(base) === 0 ? target.slice(base.length) : target;
      var isAdminApi = target.indexOf(base + "/api/admin/") === 0 ||
        target.indexOf(base + "/api/orders") === 0 ||
        target.indexOf(base + "/api/logs") === 0 ||
        target.indexOf(base + "/api/app-state") === 0 ||
        target.indexOf(base + "/api/coupons") === 0 ||
        target.indexOf(base + "/api/payments/attempts") === 0 ||
        target.indexOf(base + "/api/shiprocket/config") === 0 ||
        target.indexOf(base + "/api/shiprocket/auth-token") === 0 ||
        normalizedTarget.indexOf("/api/admin/") === 0 ||
        normalizedTarget.indexOf("/api/orders") === 0 ||
        normalizedTarget.indexOf("/api/logs") === 0 ||
        normalizedTarget.indexOf("/api/app-state") === 0 ||
        normalizedTarget.indexOf("/api/coupons") === 0 ||
        normalizedTarget.indexOf("/api/payments/attempts") === 0 ||
        normalizedTarget.indexOf("/api/shiprocket/config") === 0 ||
        normalizedTarget.indexOf("/api/shiprocket/auth-token") === 0;
      if(isAdminApi){
        init = init || {};
        init.credentials = "include";
        var token = readAdminToken();
        if(token){
          var headers = new Headers(init.headers || (input && input.headers) || {});
          headers.set("Authorization", "Bearer " + token);
          init.headers = headers;
        }
      }
      return nativeFetch(input, init).then(function(response){
        if(isAdminApi && response && response.status === 401 && !/admin-index\.html$/i.test(window.location.pathname || "")){
          window.location.href = "admin-index.html";
        }
        return response;
      });
    };
  }

  var rawSessionGet = function(key){
    return Object.prototype.hasOwnProperty.call(runtimeSessionStore, key) ? String(runtimeSessionStore[key]) : null;
  };
  var rawSessionSet = function(key, value){
    runtimeSessionStore[key] = String(value);
    persistRuntimeStoresToWindowName();
  };
  var rawSessionRemove = function(key){
    delete runtimeSessionStore[key];
    persistRuntimeStoresToWindowName();
  };
  var rawLocalGet = function(key){
    return Object.prototype.hasOwnProperty.call(runtimeLocalStore, key) ? String(runtimeLocalStore[key]) : null;
  };
  var rawLocalSet = function(key, value){
    runtimeLocalStore[key] = String(value);
    persistRuntimeStoresToWindowName();
  };
  var rawLocalRemove = function(key){
    delete runtimeLocalStore[key];
    persistRuntimeStoresToWindowName();
  };
  var usersCache = {};
  var usersCacheRequest = null;
  var usersCacheLoaded = false;
  var USERS_COLLECTION = "users";
  var CARTS_COLLECTION = "carts";
  var CHECKOUT_DRAFTS_COLLECTION = "checkoutDrafts";
  var ORDERS_COLLECTION = "orders";
  var AUTH_QUERY_KEY = "authUser";

  function parseUrl(input){
    try{
      return new URL(String(input || ""), window.location.href);
    }catch(error){
      return null;
    }
  }

  function getSameOriginReferrerPath(){
    var parsed = parseUrl(document.referrer || "");
    if(!parsed || parsed.origin !== window.location.origin) return "";
    var path = parsed.pathname.replace(/^\//, "") + parsed.search + parsed.hash;
    if(/(^|\/)account\.html(\?|#|$)/i.test(path)) return "";
    return path;
  }

  function tryParseJson(value, fallback){
    try{
      var parsed = JSON.parse(value);
      return parsed == null ? fallback : parsed;
    }catch(error){
      return fallback;
    }
  }

  function cloneValue(value){
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  function normalizeEmailValue(value){
    return String(value || "").trim().toLowerCase();
  }

  function normalizePhoneValue(value){
    return String(value || "").replace(/\D/g, "").trim();
  }

  function compactCartItem(item){
    var source = item && typeof item === "object" ? item : {};
    return {
      id: source.id != null ? String(source.id) : String(source.name || Date.now()),
      name: String(source.name || "").trim(),
      qty: Math.max(1, Number(source.qty || source.quantity || 1) || 1),
      price: Number(source.price || 0) || 0,
      mrp: Number(source.mrp || source.price || 0) || 0,
      size: String(source.size || "").trim(),
      image: String(source.image || "").trim(),
      images: Array.isArray(source.images) ? source.images.map(function(entry){ return String(entry || "").trim(); }).filter(Boolean).slice(0, 4) : []
    };
  }

  function sanitizeUserRecord(user, emailKey){
    var source = user && typeof user === "object" ? user : {};
    var email = normalizeEmailValue(source.email || source.profile && source.profile.email || emailKey || "");
    var phone = String(source.phone || source.profile && source.profile.phone || "").trim();
    var phoneNormalized = normalizePhoneValue(phone);
    var profileName = String(source.profile && source.profile.name || source.name || (email ? email.split("@")[0] : "")).trim();
    var nowIso = new Date().toISOString();
    return {
      id: String(source.id || source.userId || source.uid || email || ("user_" + Date.now())).trim(),
      userId: String(source.userId || source.uid || source.id || email || ("user_" + Date.now())).trim(),
      uid: String(source.uid || source.userId || source.id || email || ("user_" + Date.now())).trim(),
      email: email,
      emailNormalized: email,
      phone: phone,
      phoneNormalized: phoneNormalized,
      password: String(source.password || "").trim(),
      address: source.address && typeof source.address === "object" ? cloneValue(source.address) : {},
      addresses: Array.isArray(source.addresses) ? cloneValue(source.addresses) : [],
      defaultAddressId: String(source.defaultAddressId || "").trim(),
      profile: {
        name: profileName,
        email: email,
        phone: phone
      },
      cart: Array.isArray(source.cart) ? source.cart.map(compactCartItem) : [],
      orders: Array.isArray(source.orders) ? cloneValue(source.orders) : [],
      payments: Array.isArray(source.payments) ? cloneValue(source.payments) : [],
      invoices: Array.isArray(source.invoices) ? cloneValue(source.invoices) : [],
      tracking: Array.isArray(source.tracking) ? cloneValue(source.tracking) : [],
      status: String(source.status || source.accountStatus || "active").trim().toLowerCase() || "active",
      createdAt: source.createdAt || source.registeredAt || source.signupAt || nowIso,
      updatedAt: source.updatedAt || source.modifiedAt || source.createdAt || nowIso,
      lastLoginAt: source.lastLoginAt || null
    };
  }

  function sanitizeUsersMap(value){
    var input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    var next = {};
    Object.keys(input).forEach(function(key){
      var record = sanitizeUserRecord(input[key], key);
      if(record.email){
        next[record.email] = record;
      }
    });
    return next;
  }

  ["users", "orders", "adminOrders", "swadraOrders", "customerOrders", "allOrders"].forEach(function(key){
    rawLocalRemove(key);
  });

  function getSessionValue(key){
    return rawSessionGet(key);
  }

  function setSessionValue(key, value){
    if(value === undefined || value === null || value === ""){
      rawSessionRemove(key);
      return "";
    }
    var text = String(value);
    rawSessionSet(key, text);
    return text;
  }

  function getAuthEmailFromUrl(url){
    var parsed = parseUrl(url || window.location.href);
    if(!parsed) return "";
    return normalizeEmailValue(parsed.searchParams.get(AUTH_QUERY_KEY) || "");
  }

  function buildUrlWithAuth(path, options){
    var parsed = parseUrl(path || window.location.href);
    if(!parsed) return String(path || "");
    var config = options && typeof options === "object" ? options : {};
    var authEmail = normalizeEmailValue(config.authUser !== undefined ? config.authUser : getSessionValue("currentUser"));
    if(authEmail){
      parsed.searchParams.set(AUTH_QUERY_KEY, authEmail);
    }else{
      parsed.searchParams.delete(AUTH_QUERY_KEY);
    }
    if(config.redirect){
      parsed.searchParams.set("redirect", String(config.redirect));
    }else if(config.clearRedirect){
      parsed.searchParams.delete("redirect");
    }
    if(parsed.origin === window.location.origin){
      return parsed.pathname.replace(/^\//, "") + parsed.search + parsed.hash;
    }
    return parsed.toString();
  }

  function syncAuthUserFromUrl(){
    var email = getAuthEmailFromUrl(window.location.href);
    if(email){
      rawSessionSet("currentUser", email);
    }
    return email;
  }

  function ensureAuthUserInUrl(){
    var authEmail = normalizeEmailValue(getSessionValue("currentUser"));
    if(!authEmail) return;
    var parsed = parseUrl(window.location.href);
    if(!parsed) return;
    if(normalizeEmailValue(parsed.searchParams.get(AUTH_QUERY_KEY) || "") === authEmail) return;
    parsed.searchParams.set(AUTH_QUERY_KEY, authEmail);
    try{
      window.history.replaceState({}, "", parsed.pathname + parsed.search + parsed.hash);
    }catch(error){}
  }

  function syncInternalLinksWithAuth(root){
    var scope = root && typeof root.querySelectorAll === "function" ? root : document;
    if(!scope || typeof scope.querySelectorAll !== "function") return;
    var authEmail = normalizeEmailValue(getSessionValue("currentUser"));
    scope.querySelectorAll("a[href]").forEach(function(anchor){
      var href = String(anchor.getAttribute("href") || "").trim();
      if(!href || href.charAt(0) === "#" || /^mailto:|^tel:|^javascript:/i.test(href)) return;
      var parsed = parseUrl(href);
      if(!parsed || parsed.origin !== window.location.origin) return;
      if(authEmail){
        parsed.searchParams.set(AUTH_QUERY_KEY, authEmail);
      }else{
        parsed.searchParams.delete(AUTH_QUERY_KEY);
      }
      anchor.setAttribute("href", parsed.pathname.replace(/^\//, "") + parsed.search + parsed.hash);
    });
  }

  function getCurrentUserEmail(){
    var auth = initFirebaseAuthIfNeeded();
    var firebaseUser = auth && auth.currentUser ? normalizeEmailValue(auth.currentUser.email || "") : "";
    if(firebaseUser){
      setSessionValue("currentUser", firebaseUser);
    }
    syncAuthUserFromUrl();
    return String(getSessionValue("currentUser") || "").trim().toLowerCase();
  }

  function getCurrentFirebaseUser(){
    var auth = initFirebaseAuthIfNeeded();
    return auth && auth.currentUser ? auth.currentUser : null;
  }

  function getCurrentUserId(){
    var user = getCurrentFirebaseUser();
    return user && user.uid ? String(user.uid) : "";
  }

  function getAuthUsers(){
    return sanitizeUsersMap(usersCache);
  }

  async function loadUsersCache(forceRefresh){
    var db = initFirestore();
    if(!db){
      throw new Error("Firestore unavailable");
    }
    if(usersCacheLoaded && !forceRefresh){
      return getAuthUsers();
    }
    if(usersCacheRequest){
      return usersCacheRequest;
    }
    usersCacheRequest = db.collection(USERS_COLLECTION).get().then(function(snapshot){
      var next = {};
      snapshot.forEach(function(doc){
        var data = doc.data() || {};
        var user = sanitizeUserRecord(Object.assign({}, data, { uid: data.uid || doc.id }), data.email || "");
        if(user.email){
          user.uid = String(data.uid || doc.id || "");
          next[user.email] = user;
        }
      });
      usersCache = next;
      usersCacheLoaded = true;
      return getAuthUsers();
    }).catch(async function(error){
      var code = String(error && error.code || "").toLowerCase();
      if(code === "permission-denied" || code === "unauthenticated"){
        return fetchUsersFromBackendFallback();
      }
      throw error;
    }).finally(function(){
      usersCacheRequest = null;
    });
    return usersCacheRequest;
  }

  async function fetchUsersFromBackendFallback(){
    var response = await fetch(base + "/api/app-state?keys=users", { cache:"no-store" });
    var data = await response.json().catch(function(){ return {}; });
    var state = data && data.state && typeof data.state === "object" ? data.state : {};
    var next = sanitizeUsersMap(state.users || {});
    usersCache = next;
    usersCacheLoaded = true;
    return getAuthUsers();
  }

  async function saveAuthUsers(users){
    var db = initFirestore();
    var nextUsers = sanitizeUsersMap(users);
    usersCache = nextUsers;
    usersCacheLoaded = true;
    if(!db){
      throw new Error("Firestore unavailable");
    }
    var batch = db.batch();
    Object.keys(nextUsers).forEach(function(email){
      var record = nextUsers[email] || {};
      var docId = normalizeEmailValue(record.email || email);
      if(docId){
        batch.set(db.collection(USERS_COLLECTION).doc(docId), record, { merge: true });
      }
    });
    await batch.commit();
    return getAuthUsers();
  }

  async function saveAuthUserRecord(user){
    var db = initFirestore();
    var record = sanitizeUserRecord(user, user && user.email);
    if(!record.email){
      throw new Error("User email is required");
    }
    record.updatedAt = new Date().toISOString();
    if(!record.createdAt){
      record.createdAt = record.updatedAt;
    }
    var firebaseUser = getCurrentFirebaseUser();
    var uid = String(record.uid || (firebaseUser && normalizeEmailValue(firebaseUser.email || "") === record.email ? firebaseUser.uid : "") || "").trim();
    if(uid){
      record.uid = uid;
    }
    usersCache[record.email] = record;
    usersCacheLoaded = true;
    if(!db){
      throw new Error("Firestore unavailable");
    }
    await db.collection(USERS_COLLECTION).doc(record.email).set(record, { merge: true });
    return cloneValue(record);
  }

  async function deleteAuthUserRecord(email){
    var normalizedEmail = String(email || "").trim().toLowerCase();
    if(!normalizedEmail) return;
    var db = initFirestore();
    delete usersCache[normalizedEmail];
    if(!db){
      await saveUsersToBackendFallback(usersCache);
      return;
    }
    try{
      await db.collection(USERS_COLLECTION).doc(normalizedEmail).delete();
    }catch(error){
      var code = String(error && error.code || "").toLowerCase();
      if(code !== "permission-denied" && code !== "unauthenticated"){
        throw error;
      }
      await saveUsersToBackendFallback(usersCache);
    }
  }

  async function saveUsersToBackendFallback(users){
    var response = await fetch(base + "/api/app-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: { users: sanitizeUsersMap(users) } })
    });
    var data = await response.json().catch(function(){ return {}; });
    if(!response.ok || data.ok === false){
      throw new Error(data && data.error ? data.error : "Failed to save users");
    }
  }

  function getCurrentUserRecord(){
    var email = getCurrentUserEmail();
    var users = getAuthUsers();
    return email && users[email] ? users[email] : null;
  }

  async function fetchCurrentAuthUserRecord(){
    var db = initFirestore();
    var firebaseUser = getCurrentFirebaseUser();
    if(!db || !firebaseUser || !firebaseUser.uid){
      return getCurrentUserRecord();
    }
    var snapshot = await db.collection(USERS_COLLECTION).doc(normalizeEmailValue(firebaseUser.email || "")).get();
    if(!snapshot.exists && firebaseUser.uid){
      snapshot = await db.collection(USERS_COLLECTION).doc(firebaseUser.uid).get();
    }
    if(!snapshot.exists){
      return getCurrentUserRecord();
    }
    var record = sanitizeUserRecord(Object.assign({}, snapshot.data() || {}, {
      uid: firebaseUser.uid,
      email: (snapshot.data() || {}).email || firebaseUser.email || ""
    }), firebaseUser.email || "");
    if(record.email){
      record.uid = firebaseUser.uid;
      usersCache[record.email] = record;
      usersCacheLoaded = true;
    }
    return cloneValue(record);
  }

  async function findUserRecordByIdentifiers(email, phone, options){
    var config = options && typeof options === "object" ? options : {};
    var normalizedEmail = normalizeEmailValue(email);
    var normalizedPhone = normalizePhoneValue(phone);
    var currentRecord = await fetchCurrentAuthUserRecord().catch(function(){ return null; });
    if(currentRecord){
      if(normalizedEmail && normalizeEmailValue(currentRecord.email) === normalizedEmail){
        return cloneValue(currentRecord);
      }
      if(normalizedPhone && normalizePhoneValue(currentRecord.phone || currentRecord.phoneNormalized) === normalizedPhone){
        return cloneValue(currentRecord);
      }
    }
    await loadUsersCache(!!config.forceRefresh).catch(function(){ return getAuthUsers(); });
    var users = getAuthUsers();
    if(normalizedEmail && users[normalizedEmail]){
      return cloneValue(users[normalizedEmail]);
    }
    var entries = Object.keys(users);
    for(var i = 0; i < entries.length; i += 1){
      var record = users[entries[i]];
      if(!record) continue;
      if(normalizedPhone && normalizePhoneValue(record.phone || record.phoneNormalized) === normalizedPhone){
        return cloneValue(record);
      }
    }
    return null;
  }

  function setCurrentUserSession(email){
    var normalizedEmail = String(email || "").trim().toLowerCase();
    if(!normalizedEmail){
      clearCurrentUserSession();
      return "";
    }
    var users = getAuthUsers();
    var user = users[normalizedEmail] || null;
    setSessionValue("currentUser", normalizedEmail);
    setSessionValue("userPhone", user && user.phone ? user.phone : "");
    ensureAuthUserInUrl();
    syncInternalLinksWithAuth(document);
    return normalizedEmail;
  }

  function clearCurrentUserSession(){
    ["currentUser", "userPhone", "tempUser", "otp"].forEach(function(key){
      rawSessionRemove(key);
    });
  }

  function getRedirectAfterLogin(){
    var stored = String(getSessionValue("redirectAfterLogin") || "").trim();
    if(stored) return stored;
    var parsed = parseUrl(window.location.href);
    var queryRedirect = parsed ? String(parsed.searchParams.get("redirect") || "").trim() : "";
    if(queryRedirect) return queryRedirect;
    return getSameOriginReferrerPath();
  }

  function setRedirectAfterLogin(path){
    var normalizedPath = String(path || "").trim();
    if(!normalizedPath){
      rawSessionRemove("redirectAfterLogin");
      return "";
    }
    setSessionValue("redirectAfterLogin", normalizedPath);
    return normalizedPath;
  }

  function consumeRedirectAfterLogin(defaultPath){
    var redirectTo = getRedirectAfterLogin() || String(defaultPath || "dashboard.html");
    rawSessionRemove("redirectAfterLogin");
    return buildUrlWithAuth(redirectTo, { authUser: getCurrentUserEmail(), clearRedirect: true });
  }

  function compactAuthCartItems(cart){
    return (Array.isArray(cart) ? cart : []).map(compactCartItem);
  }

  function getBusinessDocId(value){
    return String(value || "").trim().toLowerCase();
  }

  function resolveUserBusinessDocId(userId){
    var source = String(userId || "").trim();
    if(!source) return "";
    var currentFirebaseUser = getCurrentFirebaseUser();
    var normalizedEmail = normalizeEmailValue(source);
    if(currentFirebaseUser && currentFirebaseUser.uid && normalizeEmailValue(currentFirebaseUser.email || "") === normalizedEmail){
      return String(currentFirebaseUser.uid);
    }
    var users = getAuthUsers();
    if(normalizedEmail && users[normalizedEmail] && users[normalizedEmail].uid){
      return String(users[normalizedEmail].uid);
    }
    return getBusinessDocId(source);
  }

  function sanitizeCheckoutDraftRecord(draft, userId){
    var source = draft && typeof draft === "object" ? draft : {};
    var normalizedUserId = resolveUserBusinessDocId(source.userId || userId || "");
    return {
      userId: normalizedUserId,
      address: source.address && typeof source.address === "object" ? cloneValue(source.address) : {},
      pincode: sanitizeText(source.pincode || source.address && source.address.pincode || ""),
      city: sanitizeText(source.city || source.address && source.address.city || ""),
      state: sanitizeText(source.state || source.address && source.address.state || ""),
      deliveryDetails: source.deliveryDetails && typeof source.deliveryDetails === "object" ? cloneValue(source.deliveryDetails) : null,
      appliedCoupon: source.appliedCoupon && typeof source.appliedCoupon === "object" ? cloneValue(source.appliedCoupon) : (source.coupon && typeof source.coupon === "object" ? cloneValue(source.coupon) : null),
      coupon: source.coupon && typeof source.coupon === "object" ? cloneValue(source.coupon) : (source.appliedCoupon && typeof source.appliedCoupon === "object" ? cloneValue(source.appliedCoupon) : null),
      cartSnapshot: compactAuthCartItems(source.cartSnapshot || source.items || []),
      summary: source.summary && typeof source.summary === "object" ? cloneValue(source.summary) : {},
      updatedAt: source.updatedAt || new Date().toISOString()
    };
  }

  async function fetchFirestoreCart(userId){
    var normalizedUserId = resolveUserBusinessDocId(userId);
    if(!normalizedUserId) return [];
    var db = initFirestore();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    var snapshot = await db.collection(CARTS_COLLECTION).doc(normalizedUserId).get();
    if(!snapshot.exists) return [];
    var data = snapshot.data() || {};
    return compactAuthCartItems(data.items || []);
  }

  async function saveFirestoreCart(userId, items){
    var normalizedUserId = resolveUserBusinessDocId(userId);
    if(!normalizedUserId) throw new Error("User id required for cart save");
    var db = initFirestore();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    var compactItems = compactAuthCartItems(items);
    await db.collection(CARTS_COLLECTION).doc(normalizedUserId).set({
      userId: normalizedUserId,
      items: compactItems,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    var currentEmail = normalizeEmailValue(userId);
    var currentRecord = currentEmail ? (getAuthUsers()[currentEmail] || null) : getCurrentUserRecord();
    if(currentRecord){
      currentRecord.cart = compactItems.slice();
      currentRecord.updatedAt = new Date().toISOString();
      saveAuthUserRecord(currentRecord).catch(function(error){
        console.error("cart mirror save failed", error);
      });
    }
    return compactItems;
  }

  async function clearFirestoreCart(userId){
    return saveFirestoreCart(userId, []);
  }

  async function fetchCheckoutDraft(userId){
    var normalizedUserId = resolveUserBusinessDocId(userId);
    if(!normalizedUserId) return null;
    var db = initFirestore();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    var snapshot = await db.collection(CHECKOUT_DRAFTS_COLLECTION).doc(normalizedUserId).get();
    if(!snapshot.exists) return null;
    return sanitizeCheckoutDraftRecord(snapshot.data() || {}, normalizedUserId);
  }

  async function saveCheckoutDraft(userId, draft){
    var normalizedUserId = resolveUserBusinessDocId(userId);
    if(!normalizedUserId) throw new Error("User id required for checkout draft save");
    var db = initFirestore();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    var payload = sanitizeCheckoutDraftRecord(draft, normalizedUserId);
    payload.updatedAt = new Date().toISOString();
    await db.collection(CHECKOUT_DRAFTS_COLLECTION).doc(normalizedUserId).set(payload, { merge: true });
    return payload;
  }

  async function clearCheckoutDraft(userId){
    var normalizedUserId = resolveUserBusinessDocId(userId);
    if(!normalizedUserId) return;
    var db = initFirestore();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    await db.collection(CHECKOUT_DRAFTS_COLLECTION).doc(normalizedUserId).delete().catch(function(){});
  }

  function findOrderCustomerEmail(order){
    var source = order && typeof order === "object" ? order : {};
    return normalizeEmailValue(
      source.customerEmail ||
      source.userEmail ||
      source.email ||
      source.userId ||
      source.user ||
      source.shipping && source.shipping.email ||
      source.billing && source.billing.email ||
      ""
    );
  }

  function findOrderCustomerPhone(order){
    var source = order && typeof order === "object" ? order : {};
    return String(
      source.customerPhone ||
      source.phone ||
      source.mobile ||
      source.shipping && (source.shipping.phone || source.shipping.mobile) ||
      source.billing && (source.billing.phone || source.billing.mobile) ||
      ""
    ).trim();
  }

  function buildOrderAddress(order){
    var source = order && typeof order === "object" ? order : {};
    var shipping = source.shipping && typeof source.shipping === "object" ? cloneValue(source.shipping) : {};
    var directAddress = source.address && typeof source.address === "object" ? cloneValue(source.address) : {};
    if(Object.keys(directAddress).length){
      shipping = Object.assign({}, directAddress, shipping);
    }
    var addressText = String(
      shipping.address ||
      (typeof source.address === "string" ? source.address : "") ||
      [shipping.house, shipping.area, shipping.postoffice, shipping.city, shipping.district, shipping.state, shipping.pincode].filter(Boolean).join(", ")
    ).trim();
    if(!addressText && !Object.keys(shipping).length) return {};
    return Object.assign({
      id: String(shipping.id || source.addressId || "addr_order_" + String(source.id || Date.now())),
      address: addressText
    }, shipping);
  }

  function mergeRecordList(list, incoming, matchKeys){
    var next = Array.isArray(list) ? cloneValue(list) : [];
    var record = incoming && typeof incoming === "object" ? cloneValue(incoming) : null;
    if(!record) return next;
    var keys = Array.isArray(matchKeys) && matchKeys.length ? matchKeys : ["id"];
    var index = next.findIndex(function(item){
      if(!item || typeof item !== "object") return false;
      return keys.some(function(key){
        return record[key] && item[key] && String(record[key]) === String(item[key]);
      });
    });
    if(index >= 0) next[index] = Object.assign({}, next[index], record);
    else next.unshift(record);
    return next.slice(0, 300);
  }

  function buildPaymentFromOrder(order){
    var source = order && typeof order === "object" ? order : {};
    var orderId = String(source.id || source.orderId || "").trim();
    var paymentId = String(source.payment_id || source.paymentId || source.razorpay_payment_id || source.razorpayPaymentId || orderId).trim();
    return {
      id: paymentId || orderId,
      paymentId: paymentId,
      orderId: orderId,
      email: findOrderCustomerEmail(source),
      phone: findOrderCustomerPhone(source),
      amount: Number(source.finalAmount || source.total || source.amount || 0) || 0,
      status: String(source.payment || source.paymentStatus || source.status || "").trim(),
      method: String(source.paymentMethod || source.paymentInstrumentLabel || "online").trim(),
      razorpayOrderId: String(source.razorpay_order_id || source.razorpayOrderId || "").trim(),
      refundStatus: String(source.refundStatus || "").trim(),
      refundAmount: Number(source.refundAmount || 0) || 0,
      createdAt: source.paymentCompletedAt || source.createdAt || source.date || new Date().toISOString(),
      updatedAt: source.updatedAt || new Date().toISOString()
    };
  }

  function buildInvoiceFromOrder(order){
    var source = order && typeof order === "object" ? order : {};
    var orderId = String(source.id || source.orderId || "").trim();
    return {
      id: String(source.invoiceId || source.invoiceNumber || orderId).trim(),
      invoiceId: String(source.invoiceId || source.invoiceNumber || orderId).trim(),
      orderId: orderId,
      email: findOrderCustomerEmail(source),
      phone: findOrderCustomerPhone(source),
      amount: Number(source.finalAmount || source.total || source.amount || 0) || 0,
      status: String(source.invoiceStatus || "ready").trim(),
      url: "invoice.html?orderId=" + encodeURIComponent(orderId),
      createdAt: source.paymentCompletedAt || source.createdAt || source.date || new Date().toISOString(),
      updatedAt: source.updatedAt || new Date().toISOString()
    };
  }

  function buildTrackingFromOrder(order){
    var source = order && typeof order === "object" ? order : {};
    var orderId = String(source.id || source.orderId || "").trim();
    return {
      id: String(source.trackingId || source.awb || source.awb_code || orderId).trim(),
      orderId: orderId,
      email: findOrderCustomerEmail(source),
      phone: findOrderCustomerPhone(source),
      status: String(source.shiprocketStatus || source.deliveryStatus || source.status || "Confirmed").trim(),
      awb: String(source.awb || source.awb_code || source.trackingId || "").trim(),
      shipmentId: String(source.shipment_id || source.shipmentId || "").trim(),
      courier: String(source.courier || source.courierName || "").trim(),
      url: "trackorder.html?orderId=" + encodeURIComponent(orderId),
      updatedAt: source.updatedAt || new Date().toISOString()
    };
  }

  async function syncOrderIntoUserProfile(order){
    var source = order && typeof order === "object" ? cloneValue(order) : {};
    var email = findOrderCustomerEmail(source);
    if(!email) return null;
    var users = await loadUsersCache(true).catch(function(){ return getAuthUsers(); });
    var user = sanitizeUserRecord(users[email] || { email: email }, email);
    var phone = findOrderCustomerPhone(source);
    if(phone){
      user.phone = user.phone || phone;
      user.phoneNormalized = normalizePhoneValue(user.phone);
      user.profile.phone = user.profile.phone || phone;
    }
    var address = buildOrderAddress(source);
    if(Object.keys(address).length){
      var addressId = String(address.id || "addr_order_" + String(source.id || Date.now()));
      address.id = addressId;
      user.addresses = mergeRecordList(user.addresses, address, ["id", "address"]);
      if(!user.defaultAddressId) user.defaultAddressId = addressId;
      if(!user.address || !user.address.house && !user.address.address){
        user.address = cloneValue(address);
      }
    }
    user.orders = mergeRecordList(user.orders, source, ["id", "orderId"]);
    user.payments = mergeRecordList(user.payments, buildPaymentFromOrder(source), ["id", "paymentId", "orderId"]);
    user.invoices = mergeRecordList(user.invoices, buildInvoiceFromOrder(source), ["id", "invoiceId", "orderId"]);
    user.tracking = mergeRecordList(user.tracking, buildTrackingFromOrder(source), ["id", "awb", "orderId"]);
    user.updatedAt = new Date().toISOString();
    return saveAuthUserRecord(user);
  }

  async function saveFirestoreOrder(orderId, payload){
    var normalizedOrderId = sanitizeText(orderId || payload && payload.id || "");
    if(!normalizedOrderId) throw new Error("Order id required");
    var db = initFirestore();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    var orderPayload = payload && typeof payload === "object" ? cloneValue(payload) : {};
    orderPayload.id = normalizedOrderId;
    orderPayload.updatedAt = new Date().toISOString();
    if(!orderPayload.createdAt){
      orderPayload.createdAt = orderPayload.updatedAt;
    }
    await db.collection(ORDERS_COLLECTION).doc(normalizedOrderId).set(orderPayload, { merge: true });
    await syncOrderIntoUserProfile(orderPayload).catch(function(error){
      console.error("user ecommerce profile sync failed", error);
    });
    return orderPayload;
  }

  async function fetchFirestoreOrder(orderId){
    var normalizedOrderId = sanitizeText(orderId || "");
    if(!normalizedOrderId) return null;
    var db = initFirestore();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    var snapshot = await db.collection(ORDERS_COLLECTION).doc(normalizedOrderId).get();
    if(!snapshot.exists) return null;
    return cloneValue(snapshot.data() || null);
  }

  async function fetchAllFirestoreOrders(){
    var db = initFirestore();
    if(!db) return fetchOrdersFromBackendFallback();
    try{
      var snapshot = await db.collection(ORDERS_COLLECTION).get();
      var orders = [];
      snapshot.forEach(function(doc){
        var data = doc.data() || {};
        orders.push(cloneValue(Object.assign({}, data, { id: data.id || doc.id })));
      });
      return orders;
    }catch(error){
      var code = String(error && error.code || "").toLowerCase();
      if(code === "permission-denied" || code === "unauthenticated"){
        return fetchOrdersFromBackendFallback();
      }
      throw error;
    }
  }

  async function fetchOrdersFromBackendFallback(){
    var response = await fetch(base + "/api/orders", { cache:"no-store" });
    var data = await response.json().catch(function(){ return {}; });
    if(response.ok && Array.isArray(data.orders)){
      return cloneValue(data.orders);
    }
    return [];
  }

  function setCartMergeNotice(payload){
    if(!payload || !payload.mergedCount){
      rawSessionRemove("swadraCartMergeNotice");
      return null;
    }
    var notice = {
      mergedCount: Math.max(0, Number(payload.mergedCount || 0) || 0),
      cartCount: Math.max(0, Number(payload.cartCount || 0) || 0),
      message: String(payload.message || "").trim()
    };
    rawSessionSet("swadraCartMergeNotice", JSON.stringify(notice));
    return notice;
  }

  function consumeCartMergeNotice(){
    var saved = tryParseJson(rawSessionGet("swadraCartMergeNotice"), null);
    rawSessionRemove("swadraCartMergeNotice");
    return saved;
  }

  function mergeGuestCartIntoUser(email){
    var normalizedEmail = String(email || "").trim().toLowerCase();
    if(!normalizedEmail) return [];
    var users = getAuthUsers();
    var user = users[normalizedEmail];
    if(!user) return [];
    var userCart = compactAuthCartItems(user.cart || []);
    users[normalizedEmail].cart = compactAuthCartItems(userCart);
    setCartMergeNotice(null);
    return users[normalizedEmail].cart.slice();
  }

  function getGuestCart(){
    return [];
  }

  function saveGuestCart(items){
    return [];
  }

  function clearGuestCart(){
    return [];
  }

  async function createOrUpdateUserAccount(payload){
    var source = payload && typeof payload === "object" ? payload : {};
    var email = normalizeEmailValue(source.email);
    var phone = String(source.phone || "").trim();
    var normalizedPhone = normalizePhoneValue(phone);
    if(!email){
      throw new Error("Email is required");
    }
    var existingUser = await findUserRecordByIdentifiers(email, phone, { forceRefresh: !!source.forceRefresh }).catch(function(){
      return null;
    }) || {};
    var existingEmail = normalizeEmailValue(existingUser.email);
    if(existingEmail && existingEmail !== email && source.preventDuplicate !== false){
      return {
        record: cloneValue(existingUser),
        existed: true,
        duplicateField: existingUser.phoneNormalized === normalizedPhone ? "phone" : "email"
      };
    }
    var firebaseUid = getCurrentUserId();
    var nextRecord = sanitizeUserRecord({
      id: firebaseUid || existingUser.id || existingUser.userId || existingUser.uid || email,
      userId: firebaseUid || existingUser.userId || existingUser.uid || existingUser.id || email,
      uid: firebaseUid || existingUser.uid || existingUser.userId || existingUser.id || "",
      email: existingEmail || email,
      phone: String(source.phone || existingUser.phone || "").trim(),
      password: String(source.password || existingUser.password || "").trim(),
      address: source.address !== undefined ? source.address : existingUser.address,
      addresses: source.addresses !== undefined ? source.addresses : existingUser.addresses,
      defaultAddressId: source.defaultAddressId !== undefined ? source.defaultAddressId : existingUser.defaultAddressId,
      profile: Object.assign({}, existingUser.profile || {}, source.profile || {}, {
        email: existingEmail || email,
        phone: String(source.phone || existingUser.phone || "").trim(),
        name: String(source.profile && source.profile.name || existingUser.profile && existingUser.profile.name || (existingEmail || email).split("@")[0]).trim()
      }),
      cart: source.cart !== undefined ? source.cart : existingUser.cart,
      orders: source.orders !== undefined ? source.orders : existingUser.orders,
      status: source.status !== undefined ? source.status : (existingUser.status || "active"),
      lastLoginAt: source.lastLoginAt !== undefined ? source.lastLoginAt : existingUser.lastLoginAt,
      createdAt: source.createdAt !== undefined ? source.createdAt : (existingUser.createdAt || new Date().toISOString()),
      updatedAt: new Date().toISOString()
    }, existingEmail || email);
    var savedRecord = await saveAuthUserRecord(nextRecord);
    if(existingEmail && existingEmail !== savedRecord.email){
      delete usersCache[existingEmail];
    }
    return {
      record: savedRecord,
      existed: !!existingEmail
    };
  }

  function signInUser(email){
    var normalizedEmail = setCurrentUserSession(email);
    if(!normalizedEmail) return null;
    mergeGuestCartIntoUser(normalizedEmail);
    var currentRecord = getCurrentUserRecord();
    if(currentRecord){
      currentRecord.lastLoginAt = new Date().toISOString();
      currentRecord.updatedAt = currentRecord.lastLoginAt;
      saveAuthUserRecord(currentRecord).catch(function(error){
        console.error("last login save failed", error);
      });
    }
    return getCurrentUserRecord();
  }

  async function signInUserWithPassword(email, password){
    var auth = initFirebaseAuthIfNeeded();
    if(!auth || typeof auth.signInWithEmailAndPassword !== "function"){
      throw new Error("Firebase Auth unavailable");
    }
    var result = await auth.signInWithEmailAndPassword(String(email || "").trim(), String(password || ""));
    var user = result && result.user ? result.user : auth.currentUser;
    var normalizedEmail = setCurrentUserSession(user && user.email ? user.email : email);
    var currentRecord = await fetchCurrentAuthUserRecord();
    if(currentRecord){
      currentRecord.lastLoginAt = new Date().toISOString();
      currentRecord.updatedAt = currentRecord.lastLoginAt;
      await saveAuthUserRecord(currentRecord);
    }
    return normalizedEmail;
  }

  async function registerUserWithPassword(payload){
    var source = payload && typeof payload === "object" ? payload : {};
    var email = String(source.email || "").trim();
    var password = String(source.password || "");
    if(!email || !password){
      throw new Error("Email and password are required");
    }
    var auth = initFirebaseAuthIfNeeded();
    if(!auth || typeof auth.createUserWithEmailAndPassword !== "function"){
      throw new Error("Firebase Auth unavailable");
    }
    var result = await auth.createUserWithEmailAndPassword(email, password);
    if(result && result.user){
      setCurrentUserSession(result.user.email || email);
    }
    return result;
  }

  async function ensureAuthAccountForLegacyUser(email, password){
    var auth = initFirebaseAuthIfNeeded();
    if(!auth || typeof auth.fetchSignInMethodsForEmail !== "function"){
      throw new Error("Firebase Auth unavailable");
    }
    var normalizedEmail = String(email || "").trim();
    var methods = await auth.fetchSignInMethodsForEmail(normalizedEmail).catch(function(error){
      var code = String(error && error.code || "");
      if(code === "auth/invalid-email") throw error;
      return [];
    });
    if(Array.isArray(methods) && methods.length){
      return signInUserWithPassword(normalizedEmail, password);
    }
    await registerUserWithPassword({ email: normalizedEmail, password: password });
    return normalizedEmail;
  }

  async function fetchSignInMethodsForEmail(email){
    var auth = initFirebaseAuthIfNeeded();
    if(!auth || typeof auth.fetchSignInMethodsForEmail !== "function"){
      return [];
    }
    var normalizedEmail = String(email || "").trim().toLowerCase();
    if(!normalizedEmail) return [];
    return auth.fetchSignInMethodsForEmail(normalizedEmail).catch(function(error){
      var code = String(error && error.code || "").toLowerCase();
      if(code === "auth/invalid-email") throw error;
      return [];
    });
  }

  async function updateUserPassword(email, currentPassword, nextPassword){
    var normalizedEmail = String(email || "").trim();
    var newPassword = String(nextPassword || "");
    if(!normalizedEmail || !newPassword){
      throw new Error("Email and new password are required");
    }
    var auth = initFirebaseAuthIfNeeded();
    if(!auth || typeof auth.signInWithEmailAndPassword !== "function"){
      throw new Error("Firebase Auth unavailable");
    }
    var current = auth.currentUser;
    var currentEmail = normalizeEmailValue(current && current.email || "");
    if(current && currentEmail === normalizeEmailValue(normalizedEmail) && typeof current.updatePassword === "function"){
      await current.updatePassword(newPassword);
      setCurrentUserSession(normalizedEmail);
      return normalizedEmail;
    }
    await ensureAuthAccountForLegacyUser(normalizedEmail, currentPassword);
    var refreshed = auth.currentUser;
    if(refreshed && typeof refreshed.updatePassword === "function"){
      await refreshed.updatePassword(newPassword);
    }
    setCurrentUserSession(normalizedEmail);
    return normalizedEmail;
  }

  var phoneOtpRecaptchaVerifier = null;
  var phoneOtpConfirmationResult = null;
  var phoneOtpContainerId = "";

  function normalizeIndianPhoneNumber(phone){
    var digits = String(phone || "").replace(/\D/g, "");
    if(digits.length === 12 && digits.indexOf("91") === 0){
      digits = digits.slice(2);
    }
    return digits;
  }

  function ensurePhoneOtpContainer(containerId){
    var id = String(containerId || "firebaseOtpMount").trim() || "firebaseOtpMount";
    var mount = document.getElementById(id);
    if(!mount){
      mount = document.createElement("div");
      mount.id = id;
      document.body.appendChild(mount);
    }
    mount.style.position = "relative";
    mount.style.left = "auto";
    mount.style.top = "auto";
    mount.style.width = "100%";
    mount.style.minHeight = "1px";
    mount.style.opacity = "1";
    mount.style.pointerEvents = "auto";
    mount.style.overflow = "visible";
    return mount;
  }

  function getPhoneOtpVerifier(containerId){
    var auth = initFirebaseAuthIfNeeded();
    if(!auth || !window.firebase || !window.firebase.auth || typeof window.firebase.auth.RecaptchaVerifier !== "function"){
      throw new Error("Firebase phone auth unavailable");
    }
    var id = String(containerId || "firebaseOtpMount").trim() || "firebaseOtpMount";
    ensurePhoneOtpContainer(id);
    if(phoneOtpRecaptchaVerifier && phoneOtpContainerId === id){
      return phoneOtpRecaptchaVerifier;
    }
    if(phoneOtpRecaptchaVerifier && typeof phoneOtpRecaptchaVerifier.clear === "function"){
      try{
        phoneOtpRecaptchaVerifier.clear();
      }catch(error){}
    }
    phoneOtpRecaptchaVerifier = new window.firebase.auth.RecaptchaVerifier(id, {
      size: "normal",
      callback: function(){},
      "expired-callback": function(){
        phoneOtpConfirmationResult = null;
      }
    });
    phoneOtpContainerId = id;
    return phoneOtpRecaptchaVerifier;
  }

  async function sendPhoneOtp(phone, options){
    var auth = initFirebaseAuthIfNeeded();
    if(!auth || typeof auth.signInWithPhoneNumber !== "function"){
      throw new Error("Firebase phone auth unavailable");
    }
    auth.languageCode = "en";
    var normalizedPhone = normalizeIndianPhoneNumber(phone);
    if(!/^\d{10}$/.test(normalizedPhone)){
      throw new Error("Valid mobile number is required");
    }
    var config = options && typeof options === "object" ? options : {};
    var verifier = getPhoneOtpVerifier(config.containerId || "firebaseOtpMount");
    try{
      if(typeof verifier.render === "function"){
        await verifier.render();
      }
      await new Promise(function(resolve){ setTimeout(resolve, 250); });
      phoneOtpConfirmationResult = await auth.signInWithPhoneNumber("+91" + normalizedPhone, verifier);
    }catch(error){
      phoneOtpConfirmationResult = null;
      if(window.grecaptcha && typeof window.grecaptcha.reset === "function"){
        try{
          window.grecaptcha.reset();
        }catch(resetError){}
      }
      if(phoneOtpRecaptchaVerifier && typeof phoneOtpRecaptchaVerifier.clear === "function"){
        try{
          phoneOtpRecaptchaVerifier.clear();
        }catch(clearError){}
      }
      phoneOtpRecaptchaVerifier = null;
      phoneOtpContainerId = "";
      throw error;
    }
    return {
      ok: true,
      phone: normalizedPhone
    };
  }

  async function verifyPhoneOtp(code){
    if(!phoneOtpConfirmationResult || typeof phoneOtpConfirmationResult.confirm !== "function"){
      throw new Error("OTP session expired. Please request a new OTP.");
    }
    var otpCode = String(code || "").trim();
    if(!otpCode){
      throw new Error("OTP is required");
    }
    var result = await phoneOtpConfirmationResult.confirm(otpCode);
    phoneOtpConfirmationResult = null;
    var auth = initFirebaseAuthIfNeeded();
    if(auth && typeof auth.signOut === "function"){
      auth.signOut().catch(function(error){
        console.error("phone otp temporary signout failed", error);
      });
    }
    return {
      ok: true,
      user: result && result.user ? result.user : null
    };
  }

  function resetPhoneOtp(){
    phoneOtpConfirmationResult = null;
    if(window.grecaptcha && typeof window.grecaptcha.reset === "function"){
      try{
        window.grecaptcha.reset();
      }catch(error){}
    }
  }

  function signOutUser(options){
    clearCurrentUserSession();
    rawSessionRemove("redirectAfterLogin");
    var auth = initFirebaseAuthIfNeeded();
    if(auth && typeof auth.signOut === "function"){
      auth.signOut().catch(function(error){
        console.error("firebase signout failed", error);
      });
    }
    try{
      var parsed = parseUrl(window.location.href);
      if(parsed){
        parsed.searchParams.delete(AUTH_QUERY_KEY);
        window.history.replaceState({}, "", parsed.pathname + parsed.search + parsed.hash);
      }
    }catch(error){}
    syncInternalLinksWithAuth(document);
  }

  async function authReady(){
    await ensureFirebaseAuthSync();
    return fetchCurrentAuthUserRecord().catch(function(){
      return getCurrentUserRecord();
    });
  }

  window.SWADRA_AUTH = {
    ready: authReady,
    refreshUsers: function(){ return loadUsersCache(true); },
    getUsers: getAuthUsers,
    saveUsers: saveAuthUsers,
    saveUserRecord: saveAuthUserRecord,
    deleteUserRecord: deleteAuthUserRecord,
    getCurrentUserEmail: getCurrentUserEmail,
    getCurrentUserId: getCurrentUserId,
    getCurrentFirebaseUser: getCurrentFirebaseUser,
    getCurrentUser: getCurrentUserEmail,
    getCurrentUserRecord: getCurrentUserRecord,
    setCurrentUserSession: setCurrentUserSession,
    clearCurrentUserSession: clearCurrentUserSession,
    getRedirectAfterLogin: getRedirectAfterLogin,
    setRedirectAfterLogin: setRedirectAfterLogin,
    consumeRedirectAfterLogin: consumeRedirectAfterLogin,
    buildUrlWithAuth: buildUrlWithAuth,
    syncInternalLinksWithAuth: syncInternalLinksWithAuth,
    mergeGuestCartIntoUser: mergeGuestCartIntoUser,
    getGuestCart: getGuestCart,
    saveGuestCart: saveGuestCart,
    clearGuestCart: clearGuestCart,
    consumeCartMergeNotice: consumeCartMergeNotice,
    createOrUpdateUserAccount: createOrUpdateUserAccount,
    findUserByEmailOrPhone: findUserRecordByIdentifiers,
    sendPhoneOtp: sendPhoneOtp,
    verifyPhoneOtp: verifyPhoneOtp,
    resetPhoneOtp: resetPhoneOtp,
    signInUser: signInUser,
    signInUserWithPassword: signInUserWithPassword,
    registerUserWithPassword: registerUserWithPassword,
    fetchSignInMethodsForEmail: fetchSignInMethodsForEmail,
    ensureAuthAccountForLegacyUser: ensureAuthAccountForLegacyUser,
    updateUserPassword: updateUserPassword,
    signOutUser: signOutUser
  };

  var firebaseConfig = {
    apiKey: "AIzaSyCJBp-RNZTeVOu0k1UzDL2DCXvkVq4Az5I",
    authDomain: "swadra-organics-db127.firebaseapp.com",
    projectId: "swadra-organics-db127",
    storageBucket: "swadra-organics-db127.firebasestorage.app",
    messagingSenderId: "830329896896",
    appId: "1:830329896896:web:b5c36aa527f3d04439d225"
  };
  var firestoreDb = null;
  var firebaseAuth = null;
  var authInitPromise = null;
  var firebaseInitError = null;
  var cloudinaryEndpoint = "https://api.cloudinary.com/v1_1/djimihrjf/image/upload";
  var cloudinaryAutoEndpoint = "https://api.cloudinary.com/v1_1/djimihrjf/auto/upload";
  var cloudinaryVideoEndpoint = "https://api.cloudinary.com/v1_1/djimihrjf/video/upload";
  var cloudinaryPreset = "swadra_products";
  var firestoreProductsCache = null;
  var firestoreProductsCacheAt = 0;
  var firestoreProductsRequest = null;
  var FIRESTORE_PRODUCTS_TTL_MS = 60000;
  var siteContentCache = null;
  var siteContentCacheAt = 0;
  var siteContentRequest = null;
  var SITE_CONTENT_TTL_MS = 30000;
  var SITE_CONTENT_COLLECTION = "siteContent";
  var SITE_CONTENT_DOCUMENT = "homepage";
  var firebaseInitWarned = false;
  var firebaseAuthInitWarned = false;

  function warnOnceFirebase(type, error){
    if(type === "firebase" && firebaseInitWarned) return;
    if(type === "auth" && firebaseAuthInitWarned) return;
    if(type === "firebase") firebaseInitWarned = true;
    if(type === "auth") firebaseAuthInitWarned = true;
    console.warn(type === "auth" ? "firebase auth unavailable" : "firebase unavailable", error);
  }

  function isCloudinaryImage(url){
    return /^https?:\/\/res\.cloudinary\.com\/djimihrjf\/image\/upload\//i.test(String(url || "").trim());
  }

  function getOptimizedCloudinaryUrl(url, options){
    var source = String(url || "").trim();
    if(!isCloudinaryImage(source)) return source;
    if(/\/f_auto,q_auto(?::[a-z]+)?\//i.test(source)) return source;
    var config = options && typeof options === "object" ? options : {};
    var width = Number(config.width || 0) || 0;
    var height = Number(config.height || 0) || 0;
    var crop = String(config.crop || (width || height ? "fill" : "")).trim();
    var transforms = ["f_auto", "q_auto"];
    if(width > 0) transforms.push("w_" + Math.round(width));
    if(height > 0) transforms.push("h_" + Math.round(height));
    if(crop) transforms.push("c_" + crop);
    return source.replace("/image/upload/", "/image/upload/" + transforms.join(",") + "/");
  }

  function optimizeProductImages(imageUrl, images){
    var primary = getOptimizedCloudinaryUrl(imageUrl, { width: 720 });
    var list = (Array.isArray(images) ? images : [])
      .map(function(entry){ return getOptimizedCloudinaryUrl(entry, { width: 720 }); })
      .filter(Boolean)
      .slice(0, 4);
    if(!list.length && primary){
      list = [primary];
    }
    if(list.length && !primary){
      primary = list[0];
    }
    return {
      imageUrl: primary,
      images: list
    };
  }

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
      warnOnceFirebase("firebase", error);
    }
    return firestoreDb;
  }

  function initFirebaseAuthIfNeeded(){
    if(firebaseAuth || firebaseInitError) return firebaseAuth;
    try{
      if(!window.firebase || typeof window.firebase.auth !== "function"){
        throw new Error("Firebase auth scripts not loaded");
      }
      initFirebaseIfNeeded();
      firebaseAuth = window.firebase.auth();
      if(firebaseAuth && typeof firebaseAuth.setPersistence === "function" && window.firebase.auth.Auth.Persistence){
        firebaseAuth.setPersistence(window.firebase.auth.Auth.Persistence.NONE).catch(function(error){
          console.warn("firebase auth persistence failed", error);
        });
      }
    }catch(error){
      firebaseInitError = firebaseInitError || error;
      warnOnceFirebase("auth", error);
    }
    return firebaseAuth;
  }

  function ensureFirebaseAuthSync(){
    if(authInitPromise) return authInitPromise;
    authInitPromise = new Promise(function(resolve){
      var auth = initFirebaseAuthIfNeeded();
      if(!auth || typeof auth.onAuthStateChanged !== "function"){
        resolve(null);
        return;
      }
      auth.onAuthStateChanged(function(user){
        var email = normalizeEmailValue(user && user.email || "");
        if(email){
          setSessionValue("currentUser", email);
          ensureAuthUserInUrl();
          syncInternalLinksWithAuth(document);
        }else if(!getSessionValue("currentUser")){
          clearCurrentUserSession();
          syncInternalLinksWithAuth(document);
        }
        resolve(user || null);
      }, function(){
        resolve(null);
      });
    });
    return authInitPromise;
  }

  function initFirestore(){
    return initFirebaseIfNeeded();
  }

  function sanitizeText(value){
    return String(value == null ? "" : value).trim();
  }

  function preferPositiveNumber(){
    for(var i = 0; i < arguments.length; i += 1){
      var value = Number(arguments[i]);
      if(Number.isFinite(value) && value > 0){
        return value;
      }
    }
    return 0;
  }

  function hasOwn(source, key){
    return !!source && Object.prototype.hasOwnProperty.call(source, key);
  }

  function firstDefined(){
    for(var i = 0; i < arguments.length; i += 1){
      if(arguments[i] !== undefined && arguments[i] !== null){
        return arguments[i];
      }
    }
    return undefined;
  }

  function firstNonEmptyText(){
    for(var i = 0; i < arguments.length; i += 1){
      var value = sanitizeText(arguments[i]);
      if(value){
        return value;
      }
    }
    return "";
  }

  function preferDefinedNumber(){
    for(var i = 0; i < arguments.length; i += 1){
      if(arguments[i] === undefined || arguments[i] === null || arguments[i] === "") continue;
      var value = Number(arguments[i]);
      if(Number.isFinite(value)){
        return value;
      }
    }
    return 0;
  }

  var SHIPPING_PICKUP = {
    pickupPincode: "126102",
    pickupCity: "Jind",
    pickupState: "Haryana",
    customerChargeMultiplier: 0.5,
    hiddenDeliveryBuffer: 5
  };

  function getShippingSettings(){
    var state = siteContentCache && typeof siteContentCache === "object" ? siteContentCache : {};
    var direct = state.shippingSettings && typeof state.shippingSettings === "object" ? state.shippingSettings : {};
    var home = state.homeContent && state.homeContent.shippingSettings && typeof state.homeContent.shippingSettings === "object" ? state.homeContent.shippingSettings : {};
    return Object.assign({}, home, direct);
  }

  function getEffectiveShippingPickup(){
    var settings = getShippingSettings();
    return {
      pickupPincode: String(settings.pickupPincode || SHIPPING_PICKUP.pickupPincode).replace(/\D/g, "").slice(0, 6),
      pickupCity: String(settings.pickupCity || SHIPPING_PICKUP.pickupCity || "").trim(),
      pickupState: String(settings.pickupState || SHIPPING_PICKUP.pickupState || "").trim(),
      customerChargeMultiplier: Math.max(0, Number(settings.customerChargeMultiplier !== undefined ? settings.customerChargeMultiplier : SHIPPING_PICKUP.customerChargeMultiplier) || SHIPPING_PICKUP.customerChargeMultiplier),
      hiddenDeliveryBuffer: Math.max(0, Math.round(Number(settings.hiddenDeliveryBuffer !== undefined ? settings.hiddenDeliveryBuffer : SHIPPING_PICKUP.hiddenDeliveryBuffer) || SHIPPING_PICKUP.hiddenDeliveryBuffer))
    };
  }

  function getShippingEtaRules(){
    var settings = getShippingSettings();
    var defaultRules = {
      within_city: [1, 2],
      metro: [2, 4],
      regional: [3, 5],
      rest_of_india: [4, 7],
      special_region: [6, 10]
    };
    var custom = settings.etaRules && typeof settings.etaRules === "object" ? settings.etaRules : {};
    Object.keys(defaultRules).forEach(function(key){
      var row = custom[key];
      if(row && typeof row === "object"){
        defaultRules[key] = [
          Math.max(1, Math.round(Number(row.min || row[0] || defaultRules[key][0]) || defaultRules[key][0])),
          Math.max(1, Math.round(Number(row.max || row[1] || defaultRules[key][1]) || defaultRules[key][1]))
        ];
        if(defaultRules[key][1] < defaultRules[key][0]) defaultRules[key][1] = defaultRules[key][0];
      }
    });
    return defaultRules;
  }

  var ICARRY_SURFACE_RATE_CHART = [
    {
      courier: "Amazon",
      baseWeightKg: 0.5,
      additionalStepKg: 0.5,
      zones: {
        within_city: { base: 32.45, additional: 19.47 },
        regional: { base: 35.04, additional: 23.36 },
        metro: { base: 38.94, additional: 25.96 },
        rest_of_india: { base: 42.83, additional: 25.96 },
        special_region: { base: 55.71, additional: 28.56 }
      }
    },
    {
      courier: "Amazon",
      baseWeightKg: 2,
      additionalStepKg: 1,
      zones: {
        within_city: { base: 86.97, additional: 15.58 },
        regional: { base: 101.24, additional: 19.47 },
        metro: { base: 112.93, additional: 22.07 },
        rest_of_india: { base: 116.82, additional: 22.07 },
        special_region: { base: 137.59, additional: 25.96 }
      }
    },
    {
      courier: "Amazon",
      baseWeightKg: 5,
      additionalStepKg: 1,
      zones: {
        within_city: { base: 133.69, additional: 11.68 },
        regional: { base: 159.65, additional: 14.28 },
        metro: { base: 179.12, additional: 15.58 },
        rest_of_india: { base: 183.02, additional: 15.58 },
        special_region: { base: 215.47, additional: 18.17 }
      }
    },
    {
      courier: "Delhivery",
      baseWeightKg: 0.25,
      additionalStepKg: 0.25,
      zones: {
        within_city: { base: 31.15, additional: 31.15 },
        regional: { base: 35.05, additional: 35.05 },
        metro: { base: 37.64, additional: 37.64 },
        rest_of_india: { base: 41.54, additional: 41.54 },
        special_region: { base: 54.52, additional: 54.52 }
      }
    },
    {
      courier: "Delhivery",
      baseWeightKg: 0.5,
      additionalStepKg: 0.5,
      zones: {
        within_city: { base: 34.27, additional: 24.28 },
        regional: { base: 38.56, additional: 27.13 },
        metro: { base: 37.64, additional: 28.56 },
        rest_of_india: { base: 45.69, additional: 31.42 },
        special_region: { base: 59.97, additional: 41.4 }
      }
    },
    {
      courier: "Delhivery",
      baseWeightKg: 1,
      additionalStepKg: 1,
      zones: {
        within_city: { base: 58.54, additional: 58.54 },
        regional: { base: 65.68, additional: 65.68 },
        metro: { base: 69.96, additional: 69.96 },
        rest_of_india: { base: 77.1, additional: 77.1 },
        special_region: { base: 101.38, additional: 101.38 }
      }
    },
    {
      courier: "Delhivery",
      baseWeightKg: 2,
      additionalStepKg: 1,
      zones: {
        within_city: { base: 82.81, additional: 32.84 },
        regional: { base: 102.81, additional: 41.4 },
        metro: { base: 107.73, additional: 47.11 },
        rest_of_india: { base: 123.31, additional: 54.25 },
        special_region: { base: 179.12, additional: 78.53 }
      }
    },
    {
      courier: "Delhivery",
      baseWeightKg: 5,
      additionalStepKg: 1,
      zones: {
        within_city: { base: 135.64, additional: 25.7 },
        regional: { base: 169.91, additional: 28.56 },
        metro: { base: 237.01, additional: 37.12 },
        rest_of_india: { base: 251.29, additional: 42.83 },
        special_region: { base: 305.55, additional: 51.4 }
      }
    },
    {
      courier: "Delhivery",
      baseWeightKg: 10,
      additionalStepKg: 1,
      zones: {
        within_city: { base: 199.89, additional: 17.13 },
        regional: { base: 249.87, additional: 21.42 },
        metro: { base: 349.81, additional: 27.13 },
        rest_of_india: { base: 371.23, additional: 31.41 },
        special_region: { base: 449.76, additional: 42.83 }
      }
    },
    {
      courier: "Delhivery",
      baseWeightKg: 20,
      additionalStepKg: 1,
      zones: {
        within_city: { base: 356.95, additional: 17.13 },
        regional: { base: 414.06, additional: 21.42 },
        metro: { base: 606.82, additional: 27.13 },
        rest_of_india: { base: 656.79, additional: 31.41 },
        special_region: { base: 828.12, additional: 42.83 }
      }
    },
    {
      courier: "Shree Maruti",
      baseWeightKg: 0.5,
      additionalStepKg: 0.5,
      zones: {
        within_city: { base: 25.96, additional: 19.47 },
        regional: { base: 32.45, additional: 24.66 },
        metro: { base: 36.34, additional: 31.15 },
        rest_of_india: { base: 45.34, additional: 37.64 },
        special_region: { base: 68.79, additional: 64.9 }
      }
    },
    {
      courier: "Shree Maruti",
      baseWeightKg: 1,
      additionalStepKg: 1,
      zones: {
        within_city: { base: 42.83, additional: 19.47 },
        regional: { base: 57.11, additional: 22.07 },
        metro: { base: 64.9, additional: 32.45 },
        rest_of_india: { base: 83.07, additional: 29.85 },
        special_region: { base: 94.75, additional: 64.9 }
      }
    },
    {
      courier: "Shree Maruti",
      baseWeightKg: 2,
      additionalStepKg: 1,
      zones: {
        within_city: { base: 62.3, additional: 18.17 },
        regional: { base: 72.68, additional: 22.07 },
        metro: { base: 96.05, additional: 24.66 },
        rest_of_india: { base: 110.33, additional: 29.85 },
        special_region: { base: 159.65, additional: 36.34 }
      }
    },
    {
      courier: "Ekart",
      baseWeightKg: 0.5,
      additionalStepKg: 0.5,
      zones: {
        within_city: { base: 34.27, additional: 34.27 },
        regional: { base: 38.56, additional: 38.56 },
        metro: { base: 39.97, additional: 39.97 },
        rest_of_india: { base: 51.4, additional: 51.4 },
        special_region: { base: 54.25, additional: 54.25 }
      }
    },
    {
      courier: "Ekart",
      baseWeightKg: 1,
      additionalStepKg: 1,
      zones: {
        within_city: { base: 47.11, additional: 47.11 },
        regional: { base: 52.83, additional: 52.83 },
        metro: { base: 62.82, additional: 62.82 },
        rest_of_india: { base: 74.25, additional: 74.25 },
        special_region: { base: 94.24, additional: 94.24 }
      }
    },
    {
      courier: "Ekart",
      baseWeightKg: 2,
      additionalStepKg: 1,
      zones: {
        within_city: { base: 75.67, additional: 28.56 },
        regional: { base: 87.1, additional: 34.27 },
        metro: { base: 102.81, additional: 39.97 },
        rest_of_india: { base: 125.64, additional: 51.4 },
        special_region: { base: 148.49, additional: 54.25 }
      }
    },
    {
      courier: "Xpressbees",
      baseWeightKg: 0.25,
      additionalStepKg: 0.25,
      zones: {
        within_city: { base: 31.15, additional: 31.15 },
        regional: { base: 31.15, additional: 31.15 },
        metro: { base: 37.64, additional: 37.64 },
        rest_of_india: { base: 37.64, additional: 37.64 },
        special_region: { base: 57.2, additional: 57.2 }
      }
    },
    {
      courier: "Xpressbees",
      baseWeightKg: 0.5,
      additionalStepKg: 0.5,
      zones: {
        within_city: { base: 32.99, additional: 13.2 },
        regional: { base: 35.2, additional: 15.4 },
        metro: { base: 42.9, additional: 17.61 },
        rest_of_india: { base: 48.4, additional: 24.19 },
        special_region: { base: 57.21, additional: 28.59 }
      }
    },
    {
      courier: "Xpressbees",
      baseWeightKg: 1,
      additionalStepKg: 1,
      zones: {
        within_city: { base: 41.8, additional: 27.51 },
        regional: { base: 46.2, additional: 32.99 },
        metro: { base: 59.4, additional: 36.31 },
        rest_of_india: { base: 69.3, additional: 39.6 },
        special_region: { base: 83.6, additional: 44 }
      }
    },
    {
      courier: "Xpressbees",
      baseWeightKg: 2,
      additionalStepKg: 1,
      zones: {
        within_city: { base: 70.4, additional: 17.61 },
        regional: { base: 77, additional: 19.8 },
        metro: { base: 83.6, additional: 22.01 },
        rest_of_india: { base: 92.41, additional: 26.4 },
        special_region: { base: 110.01, additional: 32.99 }
      }
    },
    {
      courier: "Xpressbees",
      baseWeightKg: 5,
      additionalStepKg: 1,
      zones: {
        within_city: { base: 110.01, additional: 15.4 },
        regional: { base: 121, additional: 17.61 },
        metro: { base: 137.49, additional: 19.8 },
        rest_of_india: { base: 153.99, additional: 19.8 },
        special_region: { base: 187.01, additional: 26.4 }
      }
    },
    {
      courier: "Xpressbees",
      baseWeightKg: 10,
      additionalStepKg: 1,
      zones: {
        within_city: { base: 165, additional: 14.3 },
        regional: { base: 187.01, additional: 15.4 },
        metro: { base: 203.5, additional: 16.5 },
        rest_of_india: { base: 220, additional: 17.61 },
        special_region: { base: 296.99, additional: 23.1 }
      }
    }
  ];

  var SHIPPING_SPECIAL_STATES = {
    "arunachal pradesh": true,
    "assam": true,
    "manipur": true,
    "meghalaya": true,
    "mizoram": true,
    "nagaland": true,
    "sikkim": true,
    "tripura": true,
    "andaman and nicobar islands": true,
    "andaman & nicobar islands": true,
    "lakshadweep": true
  };

  var SHIPPING_REGIONAL_STATES = {
    "haryana": true,
    "punjab": true,
    "chandigarh": true,
    "rajasthan": true,
    "uttar pradesh": true,
    "uttarakhand": true,
    "himachal pradesh": true,
    "delhi": true,
    "nct of delhi": true,
    "jammu and kashmir": true,
    "ladakh": true
  };

  var SHIPPING_METRO_CITIES = {
    "mumbai": true,
    "navi mumbai": true,
    "thane": true,
    "kolkata": true,
    "chennai": true,
    "bengaluru": true,
    "bangalore": true,
    "hyderabad": true,
    "pune": true,
    "ahmedabad": true
  };

  function roundCurrency(value){
    var amount = Number(value || 0);
    if(!Number.isFinite(amount)) return 0;
    return Math.round(amount * 100) / 100;
  }

  function normalizeShippingText(value){
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function sanitizeShippingPincode(value){
    return String(value || "").replace(/\D/g, "").slice(0, 6);
  }

  function getShippingFreeDeliveryThreshold(explicitThreshold){
    if(explicitThreshold !== undefined && explicitThreshold !== null && explicitThreshold !== ""){
      return Math.max(0, Math.round(Number(explicitThreshold) || 0));
    }
    var fromCache = siteContentCache && siteContentCache.homeContent ? (siteContentCache.homeContent.freeDeliveryThreshold ?? siteContentCache.homeContent.freeDeliveryMinimum) : undefined;
    if(fromCache === undefined && siteContentCache){
      fromCache = siteContentCache.freeDeliveryThreshold ?? siteContentCache.freeDeliveryMinimum;
    }
    return Math.max(0, Math.round(Number(fromCache !== undefined ? fromCache : 499) || 499));
  }

  function getShippingDeliveryCharge(explicitCharge){
    if(explicitCharge !== undefined && explicitCharge !== null && explicitCharge !== ""){
      return Math.max(0, Math.round(Number(explicitCharge) || 0));
    }
    var fromCache = siteContentCache && siteContentCache.homeContent ? siteContentCache.homeContent.deliveryCharge : undefined;
    if(fromCache === undefined && siteContentCache){
      fromCache = siteContentCache.deliveryCharge;
    }
    return Math.max(0, Math.round(Number(fromCache !== undefined ? fromCache : 199) || 199));
  }

  function parseWeightFromText(value){
    var text = String(value || "").trim().toLowerCase();
    if(!text) return 0;
    var match = text.match(/(\d+(?:\.\d+)?)\s*(kg|kgs|kilogram|kilograms|g|gm|gms|gram|grams|ml|millilitre|milliliter|millilitres|milliliters|l|lt|ltr|litre|liter|litres|liters)\b/);
    if(!match) return 0;
    var amount = Number(match[1]) || 0;
    var unit = match[2] || "";
    if(!amount) return 0;
    if(/^(kg|kgs|kilogram|kilograms)$/.test(unit)) return amount;
    if(/^(g|gm|gms|gram|grams)$/.test(unit)) return amount / 1000;
    if(/^(ml|millilitre|milliliter|millilitres|milliliters)$/.test(unit)) return amount / 1000;
    if(/^(l|lt|ltr|litre|liter|litres|liters)$/.test(unit)) return amount;
    return 0;
  }

  function parseLooseWeightValue(value){
    if(value === undefined || value === null || value === "") return 0;
    if(typeof value === "string"){
      var fromText = parseWeightFromText(value);
      if(fromText > 0) return fromText;
    }
    var amount = Number(value);
    if(!Number.isFinite(amount) || amount <= 0) return 0;
    if(amount > 20) return amount / 1000;
    return amount;
  }

  function extractItemWeightKg(item, productLookup){
    var source = item && typeof item === "object" ? item : {};
    var lookup = productLookup && typeof productLookup === "object" ? productLookup : {};
    var merged = Object.assign({}, lookup, source);
    var explicitWeight = preferDefinedNumber(
      merged.shippingWeightKg,
      merged.weightKg,
      parseLooseWeightValue(merged.shippingWeight),
      parseLooseWeightValue(merged.weight)
    );
    if(explicitWeight > 0){
      return explicitWeight;
    }
    var textWeight = parseWeightFromText(
      merged.weightText ||
      merged.size ||
      merged.productSize ||
      merged.variant ||
      merged.productName ||
      merged.name
    );
    if(textWeight > 0){
      return textWeight;
    }
    return 0.5;
  }

  function createProductLookup(products){
    var byId = {};
    var byName = {};
    (Array.isArray(products) ? products : []).forEach(function(product){
      if(!product || typeof product !== "object") return;
      var id = String(product.id || product.productId || "").trim();
      var name = normalizeShippingText(product.name || product.productName || "");
      if(id && !byId[id]) byId[id] = product;
      if(name && !byName[name]) byName[name] = product;
    });
    return { byId: byId, byName: byName };
  }

  function detectShippingZone(address){
    var data = address && typeof address === "object" ? address : {};
    var pickup = getEffectiveShippingPickup();
    var pincode = sanitizeShippingPincode(data.pincode || data.deliveryPincode || data.pin || data.postalCode);
    var city = normalizeShippingText(data.city || data.deliveryCity || data.district);
    var state = normalizeShippingText(data.state || data.deliveryState);
    var estimated = false;
    if(pincode === pickup.pickupPincode || city === normalizeShippingText(pickup.pickupCity)){
      return { zone: "within_city", label: "Within City", estimated: false };
    }
    if(!pincode && !state && !city){
      estimated = true;
    }
    if(state && SHIPPING_SPECIAL_STATES[state]){
      return { zone: "special_region", label: "Special Region", estimated: estimated };
    }
    if(city && SHIPPING_METRO_CITIES[city]){
      return { zone: "metro", label: "Metro", estimated: estimated };
    }
    if(state && SHIPPING_REGIONAL_STATES[state]){
      return { zone: "regional", label: "Regional", estimated: estimated };
    }
    return { zone: "rest_of_india", label: "Rest of India", estimated: true || estimated };
  }

  function calculateCourierSurfaceRate(courierConfig, zoneKey, chargeableWeight){
    if(!courierConfig || !courierConfig.zones || !courierConfig.zones[zoneKey]) return Infinity;
    var zoneRates = courierConfig.zones[zoneKey];
    var weight = Math.max(Number(chargeableWeight || 0), 0);
    var baseWeight = Math.max(Number(courierConfig.baseWeightKg || 0), 0.25);
    var additionalStep = Math.max(Number(courierConfig.additionalStepKg || 0), 0.25);
    if(weight <= 0) weight = baseWeight;
    var total = Number(zoneRates.base || 0);
    if(weight > baseWeight){
      var additionalSteps = Math.ceil((weight - baseWeight) / additionalStep);
      total += additionalSteps * Number(zoneRates.additional || 0);
    }
    return roundCurrency(total);
  }

  function getDeliveryEtaDays(zoneKey, pincode, cartItems){
    var cleanPin = sanitizeShippingPincode(pincode);
    var defaultDays = getShippingEtaRules();
    var days = defaultDays[zoneKey] ? defaultDays[zoneKey].slice() : defaultDays.rest_of_india.slice();
    var prefix = cleanPin ? Number(cleanPin.slice(0, 2)) : 0;
    if(prefix >= 11 && prefix <= 14) days = [1, 3];
    else if(prefix >= 15 && prefix <= 16) days = [2, 4];
    else if(prefix >= 17 && prefix <= 19) days = [4, 7];
    else if(prefix >= 70 && prefix <= 79) days = [5, 9];
    else if(prefix >= 80 && prefix <= 85) days = [4, 7];
    else if(prefix >= 90 && prefix <= 99) days = [5, 9];
    var needsExtraHandling = (Array.isArray(cartItems) ? cartItems : []).some(function(item){
      var text = normalizeShippingText([
        item && (item.category || item.productCategory || ""),
        item && (item.name || item.productName || ""),
        item && (item.shippingClass || item.deliveryClass || "")
      ].join(" "));
      return /ghee|oil|glass|fragile|bulk|heavy/.test(text);
    });
    if(needsExtraHandling) days = [days[0] + 1, days[1] + 1];
    return { min: days[0], max: days[1] };
  }

  function formatDeliveryEtaLabel(etaDays){
    var eta = etaDays && typeof etaDays === "object" ? etaDays : { min: 4, max: 7 };
    if(Number(eta.min) === Number(eta.max)) return "Delivery ETA: " + eta.min + " day";
    return "Delivery ETA: " + eta.min + "-" + eta.max + " days";
  }

  async function estimateSurfaceDelivery(input){
    var options = input && typeof input === "object" ? input : {};
    var cartItems = Array.isArray(options.cartItems) ? options.cartItems : [];
    var subtotal = Math.max(0, Number(options.subtotal || 0));
    var freeDeliveryThreshold = getShippingFreeDeliveryThreshold(options.freeDeliveryThreshold);
    var configuredDeliveryCharge = getShippingDeliveryCharge(options.deliveryCharge);
    var deliveryAddress = options.deliveryAddress && typeof options.deliveryAddress === "object" ? options.deliveryAddress : {};
    var providedProducts = Array.isArray(options.products) ? options.products : null;
    var products = providedProducts;
    if(!products){
      try{
        products = await fetchFirestoreProducts();
      }catch(error){
        products = [];
      }
    }
    var productLookup = createProductLookup(products);
    var pickup = getEffectiveShippingPickup();
    var chargeableWeight = roundCurrency(cartItems.reduce(function(total, item){
      var record = item && typeof item === "object" ? item : {};
      var qty = Math.max(1, Number(record.qty || record.quantity || 1) || 1);
      var byId = record.id ? productLookup.byId[String(record.id)] : null;
      var byName = !byId ? productLookup.byName[normalizeShippingText(record.name || record.productName || "")] : null;
      return total + (extractItemWeightKg(record, byId || byName || {}) * qty);
    }, 0));
    if(chargeableWeight <= 0){
      chargeableWeight = roundCurrency(cartItems.length ? cartItems.length * 0.5 : 0.5);
    }
    var zoneInfo = detectShippingZone(deliveryAddress);
    var zoneKey = zoneInfo.zone;
    var deliveryPincode = sanitizeShippingPincode(deliveryAddress.pincode || deliveryAddress.deliveryPincode);
    var etaDays = getDeliveryEtaDays(zoneKey, deliveryPincode, cartItems);
    var courierCharges = ICARRY_SURFACE_RATE_CHART.map(function(courierConfig){
      return {
        courier: courierConfig.courier,
        slabWeightKg: courierConfig.baseWeightKg,
        charge: calculateCourierSurfaceRate(courierConfig, zoneKey, chargeableWeight)
      };
    }).filter(function(entry){
      return Number.isFinite(entry.charge) && entry.charge > 0;
    });
    courierCharges.sort(function(a, b){ return a.charge - b.charge; });
    var lowest = courierCharges[0] || { courier: "", charge: 0, slabWeightKg: 0 };
    var freeDeliveryApplied = subtotal >= freeDeliveryThreshold || subtotal === 0;
    var customerDeliveryBeforeBuffer = freeDeliveryApplied ? 0 : roundCurrency(lowest.charge * pickup.customerChargeMultiplier);
    var finalCustomerDeliveryCharge = freeDeliveryApplied ? 0 : Math.round(customerDeliveryBeforeBuffer + pickup.hiddenDeliveryBuffer);
    if(!freeDeliveryApplied && finalCustomerDeliveryCharge <= 0){
      finalCustomerDeliveryCharge = configuredDeliveryCharge;
    }
    return {
      pickupPincode: pickup.pickupPincode,
      pickupCity: pickup.pickupCity,
      pickupState: pickup.pickupState,
      deliveryPincode: deliveryPincode,
      deliveryCity: String(deliveryAddress.city || deliveryAddress.deliveryCity || deliveryAddress.district || "").trim(),
      deliveryState: String(deliveryAddress.state || deliveryAddress.deliveryState || "").trim(),
      zone: zoneInfo.label,
      zoneKey: zoneKey,
      etaDays: etaDays,
      etaLabel: formatDeliveryEtaLabel(etaDays),
      chargeableWeight: roundCurrency(chargeableWeight),
      lowestCourierCharge: roundCurrency(lowest.charge),
      customerChargeMultiplier: pickup.customerChargeMultiplier,
      customerDeliveryBeforeBuffer: roundCurrency(customerDeliveryBeforeBuffer),
      hiddenDeliveryBuffer: pickup.hiddenDeliveryBuffer,
      finalCustomerDeliveryCharge: Math.max(0, Number(finalCustomerDeliveryCharge || 0)),
      freeDeliveryApplied: !!freeDeliveryApplied,
      finalDeliveryCharge: freeDeliveryApplied ? 0 : Math.max(0, Number(finalCustomerDeliveryCharge || 0)),
      configuredDeliveryCharge: configuredDeliveryCharge,
      freeDeliveryThreshold: freeDeliveryThreshold,
      estimated: !!zoneInfo.estimated,
      selectedCourierInternal: lowest.courier || "",
      availableCourierChargesInternal: courierCharges
    };
  }

  function getNumericDeliveryCharge(deliveryValue){
    if(deliveryValue && typeof deliveryValue === "object"){
      return Math.max(0, Math.round(Number(deliveryValue.finalDeliveryCharge || deliveryValue.finalCustomerDeliveryCharge || 0) || 0));
    }
    return Math.max(0, Math.round(Number(deliveryValue || 0) || 0));
  }

  function resolveWebsiteSellingPrice(product){
    var item = product && typeof product === "object" ? product : {};
    var fetchedPrice = preferDefinedNumber(item.price, item.sellingPrice);
    var offlinePrice = preferDefinedNumber(item.offlinePrice, 0);
    var floorPrice = preferDefinedNumber(item.floorPrice, 0);
    var fallbackPrice = offlinePrice > 0 ? offlinePrice : floorPrice;
    if(fetchedPrice <= 0){
      return Math.max(fallbackPrice, floorPrice);
    }
    if(floorPrice > 0 && fetchedPrice < floorPrice){
      return Math.max(fallbackPrice, floorPrice);
    }
    return fetchedPrice;
  }

  function resolveWebsiteMrp(product, sellingPrice){
    return Math.max(
      preferDefinedNumber(product && product.mrp, 0),
      preferDefinedNumber(product && product.originalPrice, 0),
      preferDefinedNumber(sellingPrice, 0)
    );
  }

  function chooseProductField(incoming, existing, keys){
    var list = Array.isArray(keys) ? keys : [keys];
    if(incoming && typeof incoming === "object"){
      for(var i = 0; i < list.length; i += 1){
        if(hasOwn(incoming, list[i])){
          return incoming[list[i]];
        }
      }
    }
    if(existing && typeof existing === "object"){
      for(var j = 0; j < list.length; j += 1){
        if(hasOwn(existing, list[j])){
          return existing[list[j]];
        }
      }
    }
    return undefined;
  }

  function mergeProductRecordForSave(incoming, existing){
    var nextIncoming = incoming && typeof incoming === "object" ? incoming : {};
    var current = existing && typeof existing === "object" ? existing : {};
    var merged = Object.assign({}, current, nextIncoming);

    var summaryValue = firstNonEmptyText(
      chooseProductField(nextIncoming, null, ["summary", "productSummary", "description", "desc"]),
      chooseProductField(current, null, ["summary", "productSummary", "description", "desc"])
    );
    if(summaryValue){
      merged.summary = summaryValue;
      merged.productSummary = summaryValue;
      merged.description = summaryValue;
    }

    var mergedImages = sanitizeStringArray(firstDefined(
      chooseProductField(nextIncoming, null, "images"),
      chooseProductField(current, null, "images")
    )).slice(0, 4);
    var imageValue = firstNonEmptyText(
      chooseProductField(nextIncoming, null, ["image", "imageUrl"]),
      mergedImages[0],
      chooseProductField(current, null, ["image", "imageUrl"])
    );
    if(!mergedImages.length && imageValue){
      mergedImages = [imageValue];
    }
    merged.image = imageValue;
    merged.imageUrl = imageValue;
    merged.images = mergedImages;

    merged.offlinePrice = preferDefinedNumber(
      chooseProductField(nextIncoming, null, "offlinePrice"),
      chooseProductField(current, null, "offlinePrice")
    );
    merged.price = preferDefinedNumber(
      chooseProductField(nextIncoming, null, ["price", "sellingPrice"]),
      chooseProductField(current, null, ["price", "sellingPrice"])
    );
    merged.sellingPrice = preferDefinedNumber(
      chooseProductField(nextIncoming, null, ["sellingPrice", "price"]),
      chooseProductField(current, null, ["sellingPrice", "price"])
    );
    merged.mrp = preferDefinedNumber(
      chooseProductField(nextIncoming, null, "mrp"),
      chooseProductField(current, null, "mrp"),
      merged.price,
      merged.sellingPrice
    );
    merged.floorPrice = preferDefinedNumber(
      chooseProductField(nextIncoming, null, "floorPrice"),
      chooseProductField(current, null, "floorPrice")
    );
    merged.lowestCompetitor = preferDefinedNumber(
      chooseProductField(nextIncoming, null, "lowestCompetitor"),
      chooseProductField(current, null, "lowestCompetitor")
    );
    merged.amazonPrice = preferDefinedNumber(
      chooseProductField(nextIncoming, null, "amazonPrice"),
      chooseProductField(current, null, "amazonPrice")
    );
    merged.flipkartPrice = preferDefinedNumber(
      chooseProductField(nextIncoming, null, "flipkartPrice"),
      chooseProductField(current, null, "flipkartPrice")
    );
    merged.otherPrice = preferDefinedNumber(
      chooseProductField(nextIncoming, null, "otherPrice"),
      chooseProductField(current, null, "otherPrice")
    );

    return merged;
  }

  function sanitizeStringArray(list){
    return (Array.isArray(list) ? list : [])
      .map(function(entry){ return sanitizeText(entry); })
      .filter(Boolean);
  }

  function sanitizeContentImage(value){
    var url = sanitizeText(value);
    if(!url) return "";
    if(/^data:/i.test(url)) return "";
    return url;
  }

  function sanitizeCustomerRecord(item, index){
    var source = item && typeof item === "object" ? item : {};
    return {
      id: sanitizeText(source.id || ("customer-" + index)),
      name: sanitizeText(source.name || "Customer"),
      product: sanitizeText(source.product || "Swadra Product"),
      review: sanitizeText(source.review || ""),
      customerImg: sanitizeContentImage(source.customerImg),
      productImg: sanitizeContentImage(source.productImg),
      createdAt: source.createdAt || null
    };
  }

  function sanitizeFamilyCard(item, index){
    var source = item && typeof item === "object" ? item : {};
    return {
      id: sanitizeText(source.id || ("family-card-" + index)),
      name: sanitizeText(source.name || "Swadra Family"),
      image: sanitizeContentImage(source.image),
      createdAt: source.createdAt || null
    };
  }

  function sanitizeCouponRecord(item, index){
    var source = item && typeof item === "object" ? item : {};
    var code = sanitizeText(source.code || "").toUpperCase();
    var discount = Math.max(0, Math.min(100, Number(source.discount || 0) || 0));
    var minimumAmount = Math.max(0, Math.round(Number(source.minimumAmount || source.minAmount || 0) || 0));
    var status = String(source.status || "active").toLowerCase() === "inactive" ? "inactive" : "active";
    return {
      id: sanitizeText(source.id || code || ("coupon-" + index)),
      code: code,
      discount: discount,
      minimumAmount: minimumAmount,
      status: status,
      createdAt: source.createdAt || null,
      updatedAt: source.updatedAt || null
    };
  }

  function createEmptySiteContent(){
    return {
      homeContent: {},
      offers: [],
      heroImages: [],
      customers: [],
      familyCards: [],
      coupons: [],
      supportRequests: [],
      policyPages: {},
      analytics: { ga4Id: "", metaPixelId: "" },
      websiteOffline: false,
      swadra_home_family_story_v1: {}
    };
  }

  function normalizeSiteContentPayload(payload){
    var source = payload && typeof payload === "object" ? payload : {};
    var homeContent = source.homeContent && typeof source.homeContent === "object" ? cloneValue(source.homeContent) : {};
    var offers = sanitizeStringArray(source.offers || homeContent.offers);
    var heroImages = sanitizeStringArray(source.heroImages || homeContent.heroImages).map(sanitizeContentImage).filter(Boolean);
    var customers = (Array.isArray(source.customers || homeContent.customers) ? (source.customers || homeContent.customers) : [])
      .map(sanitizeCustomerRecord)
      .filter(function(item){ return item.customerImg || item.productImg || item.review; });
    var familyCards = (Array.isArray(source.familyCards || homeContent.familyCards) ? (source.familyCards || homeContent.familyCards) : [])
      .map(sanitizeFamilyCard)
      .filter(function(item){ return item.image || item.name; });
    var coupons = (Array.isArray(source.coupons || homeContent.coupons) ? (source.coupons || homeContent.coupons) : [])
      .map(sanitizeCouponRecord)
      .filter(function(item){ return item.code && item.discount > 0; });
    var supportRequests = Array.isArray(source.supportRequests || homeContent.supportRequests)
      ? cloneValue(source.supportRequests || homeContent.supportRequests)
      : [];
    var analytics = source.analytics && typeof source.analytics === "object"
      ? cloneValue(source.analytics)
      : (homeContent.analytics && typeof homeContent.analytics === "object" ? cloneValue(homeContent.analytics) : { ga4Id: "", metaPixelId: "" });
    var policyPages = source.policyPages && typeof source.policyPages === "object"
      ? cloneValue(source.policyPages)
      : (homeContent.policyPages && typeof homeContent.policyPages === "object" ? cloneValue(homeContent.policyPages) : {});
    var storyCounter = source.swadra_home_family_story_v1 && typeof source.swadra_home_family_story_v1 === "object"
      ? cloneValue(source.swadra_home_family_story_v1)
      : {};
    if(homeContent.swadra_home_family_story_v1 && typeof homeContent.swadra_home_family_story_v1 === "object"){
      storyCounter = Object.assign({}, cloneValue(homeContent.swadra_home_family_story_v1), storyCounter);
    }
    var hasTopLevelWebsiteOffline = source.websiteOffline !== undefined;
    var hasHomeContentWebsiteOffline = homeContent.websiteOffline !== undefined;
    var websiteOffline = hasTopLevelWebsiteOffline
      ? !!source.websiteOffline
      : (hasHomeContentWebsiteOffline ? !!homeContent.websiteOffline : false);

    homeContent.offers = offers.slice();
    homeContent.heroImages = heroImages.slice();
    homeContent.customers = customers.slice();
    homeContent.familyCards = familyCards.slice();
    homeContent.coupons = coupons.slice();
    homeContent.supportRequests = supportRequests.slice();
    homeContent.analytics = cloneValue(analytics);
    homeContent.policyPages = cloneValue(policyPages);
    homeContent.websiteOffline = websiteOffline;
    homeContent.swadra_home_family_story_v1 = cloneValue(storyCounter);

    if(homeContent.heroVideoSrc){
      homeContent.heroVideoSrc = sanitizeContentImage(homeContent.heroVideoSrc);
    }
    if(storyCounter.image){
      storyCounter.image = sanitizeContentImage(storyCounter.image);
    }

    return {
      homeContent: homeContent,
      offers: offers,
      heroImages: heroImages,
      customers: customers,
      familyCards: familyCards,
      coupons: coupons,
      supportRequests: supportRequests,
      policyPages: policyPages,
      analytics: analytics,
      websiteOffline: websiteOffline,
      swadra_home_family_story_v1: storyCounter
    };
  }

  async function fetchSiteContent(forceRefresh){
    var db = initFirebaseIfNeeded();
    var now = Date.now();
    if(!forceRefresh && siteContentCache && now - siteContentCacheAt < SITE_CONTENT_TTL_MS){
      return cloneValue(siteContentCache);
    }
    if(siteContentRequest){
      return siteContentRequest;
    }
    if(!db){
      siteContentRequest = fetchSiteContentFromBackend().finally(function(){
        siteContentRequest = null;
      });
      return siteContentRequest;
    }
    siteContentRequest = db.collection(SITE_CONTENT_COLLECTION).doc(SITE_CONTENT_DOCUMENT).get().then(function(doc){
      var next = doc.exists ? normalizeSiteContentPayload(doc.data()) : createEmptySiteContent();
      siteContentCache = next;
      siteContentCacheAt = Date.now();
      return cloneValue(next);
    }).catch(function(error){
      var code = String(error && error.code || "").toLowerCase();
      if(code === "permission-denied" || code === "unauthenticated"){
        return fetchSiteContentFromBackend();
      }
      throw error;
    }).finally(function(){
      siteContentRequest = null;
    });
    return siteContentRequest;
  }

  async function fetchSiteContentFromBackend(){
    var response = await fetch(base + "/api/app-state", { cache:"no-store" });
    var data = await response.json().catch(function(){ return {}; });
    if(!response.ok){
      throw new Error(data && data.error ? data.error : "Failed to fetch admin content");
    }
    var state = data && data.state && typeof data.state === "object" ? data.state : {};
    var next = normalizeSiteContentPayload(state);
    siteContentCache = next;
    siteContentCacheAt = Date.now();
    return cloneValue(next);
  }

  async function saveSiteContent(partial){
    var db = initFirebaseIfNeeded();
    var current = await fetchSiteContent(true).catch(function(){ return createEmptySiteContent(); });
    var mergedHomeContent = Object.assign({}, current.homeContent || {}, partial && partial.homeContent || {});
    if(partial && partial.websiteOffline !== undefined){
      mergedHomeContent.websiteOffline = !!partial.websiteOffline;
    }
    if(partial && partial.swadra_home_family_story_v1 !== undefined){
      mergedHomeContent.swadra_home_family_story_v1 = Object.assign({}, current.swadra_home_family_story_v1 || {}, partial.swadra_home_family_story_v1 || {});
    }
    var merged = normalizeSiteContentPayload({
      homeContent: mergedHomeContent,
      offers: partial && partial.offers !== undefined ? partial.offers : current.offers,
      heroImages: partial && partial.heroImages !== undefined ? partial.heroImages : current.heroImages,
      customers: partial && partial.customers !== undefined ? partial.customers : current.customers,
      familyCards: partial && partial.familyCards !== undefined ? partial.familyCards : current.familyCards,
      coupons: partial && partial.coupons !== undefined ? partial.coupons : current.coupons,
      supportRequests: partial && partial.supportRequests !== undefined ? partial.supportRequests : current.supportRequests,
      websiteOffline: partial && partial.websiteOffline !== undefined ? partial.websiteOffline : current.websiteOffline,
      swadra_home_family_story_v1: Object.assign({}, current.swadra_home_family_story_v1 || {}, partial && partial.swadra_home_family_story_v1 || {})
    });
    merged.homeContent.updatedAt = Date.now();
    var savedDirectly = false;
    if(db){
      try{
        await db.collection(SITE_CONTENT_COLLECTION).doc(SITE_CONTENT_DOCUMENT).set(merged, { merge: true });
        savedDirectly = true;
      }catch(error){
        var code = String(error && error.code || "").toLowerCase();
        if(code !== "permission-denied" && code !== "unauthenticated"){
          throw error;
        }
        await saveSiteContentToBackend(merged);
      }
    }else{
      await saveSiteContentToBackend(merged);
    }
    if(savedDirectly){
      saveSiteContentToBackend(merged).catch(function(){});
    }
    siteContentCache = merged;
    siteContentCacheAt = Date.now();
    firestoreProductsCache = null;
    firestoreProductsCacheAt = 0;
    return cloneValue(merged);
  }

  async function saveSiteContentToBackend(merged){
    var response = await fetch(base + "/api/app-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: merged })
    });
    var data = await response.json().catch(function(){ return {}; });
    if(!response.ok || data.ok === false){
      throw new Error(data && data.error ? data.error : "Failed to save admin content");
    }
    return data;
  }

  function normalizeProductRecord(product, fallbackId){
    var item = product && typeof product === "object" ? product : {};
    var rawImages = Array.isArray(item.images) ? item.images : [];
    var imageUrl = firstNonEmptyText(item.imageUrl, item.image, rawImages[0]);
    var images = rawImages
      .map(function(value){ return String(value || "").trim(); })
      .filter(Boolean)
      .slice(0,4);
    var optimizedImages = optimizeProductImages(imageUrl, images);
    imageUrl = optimizedImages.imageUrl;
    images = optimizedImages.images;
    var summary = firstNonEmptyText(item.summary, item.productSummary, item.description, item.desc);
    var category = String(item.category || "").trim();
    var normalizedCategory = category.toLowerCase().replace(/&/g, "and").replace(/,/g, " ").replace(/\s+/g, " ").trim();
    var isCategoryBestseller = normalizedCategory === "bestseller" || normalizedCategory === "bestsellers" || normalizedCategory === "best seller" || normalizedCategory === "best sellers";
    var isCategorySpecial = normalizedCategory === "special" || normalizedCategory === "special product" || normalizedCategory === "special products" || normalizedCategory === "featured product" || normalizedCategory === "featured products";
    var normalizedId = item.id !== undefined && item.id !== null && String(item.id).trim() ? item.id : fallbackId;
    var websiteSellingPrice = resolveWebsiteSellingPrice(item);
    var websiteMrp = resolveWebsiteMrp(item, websiteSellingPrice);
    var hasExplicitStockQty = item.stockQty !== undefined && item.stockQty !== null && String(item.stockQty).trim() !== "";
    var hasExplicitStock = item.stock !== undefined && item.stock !== null && String(item.stock).trim() !== "";
    var baseStockQty = Number(item.stockQty ?? item.stock ?? 0) || 0;
    var baseAvailability = String(item.availability || (item.outOfStock ? "Out of Stock" : "Available") || "Available");
    var siteOffline = !!(siteContentCache && siteContentCache.websiteOffline);
    var effectiveAvailability = siteOffline ? "Out of Stock" : baseAvailability;
    var quantityImpliesOutOfStock = (hasExplicitStockQty || hasExplicitStock) ? baseStockQty <= 0 : false;
    var effectiveOutOfStock = siteOffline ? true : (baseAvailability === "Out of Stock" || quantityImpliesOutOfStock);
    return {
      id: normalizedId,
      docId: String(item.docId || normalizedId || fallbackId || "").trim(),
      name: String(item.name || item.productName || "").trim(),
      productName: String(item.name || item.productName || "").trim(),
      price: websiteSellingPrice,
      sellingPrice: websiteSellingPrice,
      mrp: websiteMrp,
      category: category,
      size: String(item.size || item.productSize || "").trim(),
      productSize: String(item.size || item.productSize || "").trim(),
      stockQty: baseStockQty,
      availability: effectiveAvailability,
      outOfStock: effectiveOutOfStock,
      originalAvailability: baseAvailability,
      originalOutOfStock: baseAvailability === "Out of Stock" || quantityImpliesOutOfStock,
      websiteOffline: siteOffline,
      summary: summary,
      productSummary: summary,
      description: summary,
      image: imageUrl,
      imageUrl: imageUrl,
      images: images,
      bestseller: !!(item.bestseller || item.isBestseller || isCategoryBestseller),
      isBestseller: !!(item.bestseller || item.isBestseller || isCategoryBestseller),
      combo: !!item.combo,
      special: !!(item.special || item.isSpecialProduct || isCategorySpecial),
      isSpecialProduct: !!(item.special || item.isSpecialProduct || isCategorySpecial),
      rawCost: Number(item.rawCost ?? 0) || 0,
      shippingCost: Number(item.shippingCost ?? 0) || 0,
      shippingWeightKg: preferDefinedNumber(item.shippingWeightKg, null),
      weightKg: preferDefinedNumber(item.weightKg, null),
      shippingWeight: item.shippingWeight ?? null,
      weight: item.weight ?? null,
      packagingCost: Number(item.packagingCost ?? 0) || 0,
      extraCost: Number(item.extraCost ?? 0) || 0,
      minProfit: Number(item.minProfit ?? 0) || 0,
      undercutBy: Number(item.undercutBy ?? 1) || 1,
      amazonPrice: Number(item.amazonPrice ?? 0) || 0,
      flipkartPrice: Number(item.flipkartPrice ?? 0) || 0,
      otherPrice: Number(item.otherPrice ?? 0) || 0,
      offlinePrice: preferDefinedNumber(item.offlinePrice, 0),
      totalCost: preferDefinedNumber(item.totalCost, 0),
      floorPrice: preferDefinedNumber(item.floorPrice, 0),
      lowestCompetitor: preferDefinedNumber(item.lowestCompetitor, 0),
      offPercent: preferDefinedNumber(item.offPercent, 0),
      aiStatus: String(item.aiStatus || "").trim(),
      amazonUrl: String(item.amazonUrl || "").trim(),
      flipkartUrl: String(item.flipkartUrl || "").trim(),
      otherUrl: String(item.otherUrl || "").trim(),
      mrpLocked: !!item.mrpLocked,
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null
    };
  }

  async function fetchFirestoreProducts(){
    var db = initFirebaseIfNeeded();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    await fetchSiteContent(false).catch(function(){ return null; });
    var now = Date.now();
    if(firestoreProductsCache && now - firestoreProductsCacheAt < FIRESTORE_PRODUCTS_TTL_MS){
      return firestoreProductsCache.slice();
    }
    if(firestoreProductsRequest){
      return firestoreProductsRequest;
    }
    firestoreProductsRequest = db.collection("products").get().then(function(snapshot){
      var products = [];
      snapshot.forEach(function(doc){
        products.push(normalizeProductRecord(doc.data(), doc.id));
      });
      firestoreProductsCache = products;
      firestoreProductsCacheAt = Date.now();
      return products.slice();
    }).finally(function(){
      firestoreProductsRequest = null;
    });
    return firestoreProductsRequest;
  }

  function loadImageFromFile(file){
    return new Promise(function(resolve, reject){
      if(typeof Image === "undefined" || typeof FileReader === "undefined"){
        reject(new Error("Browser image compression is unavailable"));
        return;
      }
      var reader = new FileReader();
      reader.onload = function(){
        var image = new Image();
        image.onload = function(){ resolve(image); };
        image.onerror = function(){ reject(new Error("Selected image could not be read")); };
        image.src = reader.result;
      };
      reader.onerror = function(){ reject(new Error("Selected image could not be read")); };
      reader.readAsDataURL(file);
    });
  }

  function canvasToBlob(canvas, type, quality){
    return new Promise(function(resolve, reject){
      canvas.toBlob(function(blob){
        if(blob) resolve(blob);
        else reject(new Error("Compressed image could not be generated"));
      }, type, quality);
    });
  }

  async function compressImageForUpload(file, options){
    if(!file || !file.type || !file.type.startsWith("image/")) return file;
    var config = options && typeof options === "object" ? options : {};
    var preserveQuality = !!config.preserveQuality;
    if(file.size <= 1024 * 1024) return file;
    if(typeof document === "undefined"){
      return file;
    }

    var image = await loadImageFromFile(file);
    var canvas = document.createElement("canvas");
    var context = canvas.getContext("2d", { alpha: false });
    if(!context) return file;

    var width = image.naturalWidth || image.width;
    var height = image.naturalHeight || image.height;
    canvas.width = width;
    canvas.height = height;
    context.drawImage(image, 0, 0, width, height);

    var targetMin = preserveQuality ? 900 * 1024 : 500 * 1024;
    var targetMax = preserveQuality ? 1400 * 1024 : 800 * 1024;
    var mimeType = /png|webp/i.test(file.type) ? file.type : "image/jpeg";
    var bestBlob = null;
    var bestDelta = Infinity;
    var qualities = mimeType === "image/png"
      ? (preserveQuality ? [0.98, 0.96, 0.94, 0.92] : [0.92, 0.88, 0.84, 0.8])
      : (preserveQuality ? [0.96, 0.93, 0.9, 0.87, 0.84] : [0.9, 0.86, 0.82, 0.78, 0.74]);

    for(var i = 0; i < qualities.length; i += 1){
      var blob = await canvasToBlob(canvas, mimeType, qualities[i]);
      var delta = Math.abs(blob.size - Math.min(Math.max(blob.size, targetMin), targetMax));
      if(!bestBlob || delta < bestDelta){
        bestBlob = blob;
        bestDelta = delta;
      }
      if(blob.size >= targetMin && blob.size <= targetMax){
        bestBlob = blob;
        break;
      }
    }

    if(!bestBlob || bestBlob.size >= file.size){
      return file;
    }

    var extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
    var compressedName = String(file.name || "upload").replace(/\.[^.]+$/, "") + "-compressed." + extension;
    return new File([bestBlob], compressedName, {
      type: mimeType,
      lastModified: Date.now()
    });
  }

  async function uploadImagesToCloudinary(files, options){
    var list = Array.isArray(files) ? files.filter(Boolean) : [];
    var uploaded = [];
    for(var i=0;i<list.length;i++){
      var file = await compressImageForUpload(list[i], options);
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

  async function uploadFilesToCloudinary(files, options){
    var list = Array.isArray(files) ? files.filter(Boolean) : [];
    var uploaded = [];
    for(var i=0;i<list.length;i++){
      var file = list[i];
      if(file && file.type && /^video\//i.test(file.type)){
        var uploadedVideo = await uploadVideosToCloudinary([file]);
        uploaded.push(uploadedVideo[0] || "");
      }else{
        var uploadedImage = await uploadImagesToCloudinary([file], options);
        uploaded.push(uploadedImage[0] || "");
      }
    }
    return uploaded;
  }

  async function uploadVideosToCloudinary(files){
    var list = Array.isArray(files) ? files.filter(Boolean) : [];
    var uploaded = [];
    for(var i=0;i<list.length;i++){
      var file = list[i];
      var formData = new FormData();
      formData.append("file", file);
      formData.append("upload_preset", cloudinaryPreset);
      var response = await fetch(cloudinaryVideoEndpoint, {
        method: "POST",
        body: formData
      });
      var data = await response.json().catch(function(){ return {}; });
      if(!response.ok || !data.secure_url){
        throw new Error((data && data.error && data.error.message) || "Cloudinary video upload failed");
      }
      uploaded.push(String(data.secure_url).trim());
    }
    return uploaded;
  }

  async function saveFirestoreProduct(product){
    var db = initFirebaseIfNeeded();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    var incoming = product && typeof product === "object" ? cloneValue(product) : {};
    var fallbackDocId = sanitizeText(incoming.docId || incoming.id);
    var existing = null;
    if(fallbackDocId){
      var existingSnapshot = await db.collection("products").doc(fallbackDocId).get();
      if(existingSnapshot.exists){
        existing = normalizeProductRecord(existingSnapshot.data(), existingSnapshot.id);
      }
    }
    var normalized = normalizeProductRecord(mergeProductRecordForSave(incoming, existing), incoming && incoming.id);
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
    normalized.summary = firstNonEmptyText(normalized.summary, normalized.productSummary, normalized.description);
    normalized.productSummary = normalized.summary;
    normalized.description = normalized.summary;
    var nowIso = new Date().toISOString();
    var persistedAvailability = String(normalized.originalAvailability || normalized.availability || "Available");
    var persistedOutOfStock = persistedAvailability === "Out of Stock" || !!normalized.originalOutOfStock;
    var payload = {
      id: normalized.id,
      name: normalized.name,
      productName: normalized.productName,
      price: normalized.price,
      sellingPrice: normalized.sellingPrice,
      mrp: normalized.mrp,
      category: normalized.category,
      size: normalized.size,
      productSize: normalized.productSize,
      stockQty: normalized.stockQty,
      availability: persistedAvailability,
      outOfStock: persistedOutOfStock,
      summary: normalized.summary,
      productSummary: normalized.productSummary,
      description: normalized.description,
      image: normalized.image,
      imageUrl: normalized.imageUrl,
      images: normalized.images,
      bestseller: normalized.bestseller,
      isBestseller: normalized.isBestseller,
      combo: normalized.combo,
      special: normalized.special,
      isSpecialProduct: normalized.isSpecialProduct,
      rawCost: normalized.rawCost,
      shippingCost: normalized.shippingCost,
      packagingCost: normalized.packagingCost,
      extraCost: normalized.extraCost,
      minProfit: normalized.minProfit,
      undercutBy: normalized.undercutBy,
      amazonPrice: normalized.amazonPrice,
      flipkartPrice: normalized.flipkartPrice,
      otherPrice: normalized.otherPrice,
      offlinePrice: normalized.offlinePrice,
      totalCost: normalized.totalCost,
      floorPrice: normalized.floorPrice,
      lowestCompetitor: normalized.lowestCompetitor,
      offPercent: normalized.offPercent,
      aiStatus: normalized.aiStatus,
      amazonUrl: normalized.amazonUrl,
      flipkartUrl: normalized.flipkartUrl,
      otherUrl: normalized.otherUrl,
      mrpLocked: normalized.mrpLocked,
      updatedAt: nowIso
    };
    if(normalized.createdAt){
      payload.createdAt = normalized.createdAt;
    }else{
      payload.createdAt = nowIso;
    }
    await db.collection("products").doc(normalized.docId).set(payload, { merge:true });
    firestoreProductsCache = null;
    firestoreProductsCacheAt = 0;
    return normalizeProductRecord(payload, normalized.docId);
  }

  async function deleteFirestoreProduct(id){
    var db = initFirebaseIfNeeded();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    await db.collection("products").doc(String(id)).delete();
    firestoreProductsCache = null;
    firestoreProductsCacheAt = 0;
    return true;
  }

  function getLocalReviewKey(productId){
    return "swadra_product_reviews_" + String(productId || "unknown");
  }

  function normalizeProductReview(review, fallbackProductId){
    var item = review && typeof review === "object" ? review : {};
    return {
      id: String(item.id || ("review_" + Date.now() + "_" + Math.floor(Math.random() * 1000))),
      productId: String(item.productId || fallbackProductId || "").trim(),
      name: String(item.name || "Customer").trim().slice(0, 60) || "Customer",
      rating: Math.min(5, Math.max(1, Math.round(Number(item.rating || 5) || 5))),
      title: String(item.title || "").trim().slice(0, 90),
      comment: String(item.comment || item.review || "").trim().slice(0, 800),
      status: String(item.status || "approved").toLowerCase() === "hidden" ? "hidden" : "approved",
      verified: !!item.verified,
      createdAt: item.createdAt || new Date().toISOString()
    };
  }

  async function fetchProductReviews(productId){
    var normalizedId = String(productId || "").trim();
    if(!normalizedId) return [];
    var db = initFirebaseIfNeeded();
    if(db){
      var snapshot = await db.collection("productReviews")
        .where("productId", "==", normalizedId)
        .limit(50)
        .get();
      var rows = [];
      snapshot.forEach(function(doc){
        var review = normalizeProductReview(doc.data(), normalizedId);
        review.id = doc.id;
        if(review.status === "approved") rows.push(review);
      });
      rows.sort(function(a,b){ return Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""); });
      return rows;
    }
    try{
      var list = runtimeReviewStore[getLocalReviewKey(normalizedId)] || [];
      return (Array.isArray(list) ? list : []).map(function(item){ return normalizeProductReview(item, normalizedId); })
        .filter(function(item){ return item.status === "approved"; });
    }catch(error){
      return [];
    }
  }

  async function saveProductReview(productId, review){
    var normalizedId = String(productId || "").trim();
    if(!normalizedId) throw new Error("Product id is required");
    var payload = normalizeProductReview(Object.assign({}, review || {}, { productId: normalizedId }), normalizedId);
    var db = initFirebaseIfNeeded();
    if(db){
      await db.collection("productReviews").doc(payload.id).set(payload, { merge:true });
      return payload;
    }
    var key = getLocalReviewKey(normalizedId);
    var current = Array.isArray(runtimeReviewStore[key]) ? runtimeReviewStore[key] : [];
    current.unshift(payload);
    runtimeReviewStore[key] = current.slice(0, 50);
    return payload;
  }

  var analyticsState = {
    loaded: false,
    loading: null,
    ga4Id: "",
    metaPixelId: ""
  };

  function normalizeAnalyticsItem(item){
    var source = item && typeof item === "object" ? item : {};
    var qty = Math.max(1, Number(source.qty || source.quantity || 1) || 1);
    var price = Number(source.price || source.sellingPrice || source.displayPrice || source.finalUnitPrice || 0) || 0;
    return {
      item_id: String(source.id || source.productId || source.sku || source.name || "").trim(),
      item_name: String(source.name || source.productName || "Swadra Product").trim(),
      item_category: String(source.category || "").trim(),
      item_variant: String(source.size || source.productSize || source.variant || "").trim(),
      price: price,
      quantity: qty
    };
  }

  function normalizeAnalyticsItems(items){
    return (Array.isArray(items) ? items : []).map(normalizeAnalyticsItem);
  }

  function getAnalyticsValue(payload){
    var source = payload && typeof payload === "object" ? payload : {};
    if(source.value !== undefined) return Number(source.value || 0) || 0;
    return normalizeAnalyticsItems(source.items).reduce(function(total, item){
      return total + ((Number(item.price || 0) || 0) * (Number(item.quantity || 1) || 1));
    }, 0);
  }

  function injectScript(src, id){
    return new Promise(function(resolve){
      if(id && document.getElementById(id)){
        resolve(true);
        return;
      }
      var script = document.createElement("script");
      if(id) script.id = id;
      script.async = true;
      script.src = src;
      script.onload = function(){ resolve(true); };
      script.onerror = function(){ resolve(false); };
      document.head.appendChild(script);
    });
  }

  async function resolveAnalyticsConfig(){
    var direct = window.SWADRA_ANALYTICS_CONFIG && typeof window.SWADRA_ANALYTICS_CONFIG === "object"
      ? window.SWADRA_ANALYTICS_CONFIG
      : {};
    var stateConfig = {};
    try{
      if(typeof fetchSiteContent === "function"){
        var state = await fetchSiteContent(false);
        stateConfig = state && state.analytics && typeof state.analytics === "object" ? state.analytics : {};
      }
    }catch(error){}
    return {
      ga4Id: String(direct.ga4Id || direct.gaMeasurementId || stateConfig.ga4Id || stateConfig.gaMeasurementId || "").trim(),
      metaPixelId: String(direct.metaPixelId || direct.facebookPixelId || stateConfig.metaPixelId || stateConfig.facebookPixelId || "").trim()
    };
  }

  async function initAnalytics(){
    if(analyticsState.loaded) return analyticsState;
    if(analyticsState.loading) return analyticsState.loading;
    analyticsState.loading = resolveAnalyticsConfig().then(async function(config){
      analyticsState.ga4Id = /^G-[A-Z0-9]+$/i.test(config.ga4Id) ? config.ga4Id : "";
      analyticsState.metaPixelId = config.metaPixelId;
      if(analyticsState.ga4Id){
        window.dataLayer = window.dataLayer || [];
        window.gtag = window.gtag || function(){ window.dataLayer.push(arguments); };
        window.gtag("js", new Date());
        window.gtag("config", analyticsState.ga4Id, { send_page_view: true });
        await injectScript("https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(analyticsState.ga4Id), "swadra-ga4");
      }
      if(analyticsState.metaPixelId){
        window.fbq = window.fbq || function(){
          window.fbq.callMethod ? window.fbq.callMethod.apply(window.fbq, arguments) : window.fbq.queue.push(arguments);
        };
        if(!window.fbq.queue) window.fbq.queue = [];
        window.fbq.loaded = true;
        window.fbq.version = "2.0";
        window.fbq("init", analyticsState.metaPixelId);
        window.fbq("track", "PageView");
        await injectScript("https://connect.facebook.net/en_US/fbevents.js", "swadra-meta-pixel");
      }
      analyticsState.loaded = true;
      return analyticsState;
    }).finally(function(){
      analyticsState.loading = null;
    });
    return analyticsState.loading;
  }

  async function trackAnalyticsEvent(name, payload){
    var eventName = String(name || "").trim();
    if(!eventName) return false;
    var data = payload && typeof payload === "object" ? payload : {};
    var state = await initAnalytics();
    var items = normalizeAnalyticsItems(data.items);
    var value = getAnalyticsValue(data);
    var params = Object.assign({}, data, {
      currency: data.currency || "INR",
      value: value,
      items: items
    });
    if(state.ga4Id && window.gtag){
      window.gtag("event", eventName, params);
    }
    if(state.metaPixelId && window.fbq){
      var metaName = {
        view_item: "ViewContent",
        add_to_cart: "AddToCart",
        begin_checkout: "InitiateCheckout",
        purchase: "Purchase"
      }[eventName] || eventName;
      window.fbq("track", metaName, {
        currency: params.currency,
        value: value,
        contents: items.map(function(item){ return { id: item.item_id, quantity: item.quantity, item_price: item.price }; }),
        content_type: "product"
      });
    }
    return true;
  }

  async function postRecoveryEvent(path, payload){
    try{
      var response = await fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload && typeof payload === "object" ? payload : {})
      });
      var data = await response.json().catch(function(){ return {}; });
      return Object.assign({ ok: response.ok }, data);
    }catch(error){
      console.error("cart recovery sync failed", error);
      return { ok:false, error:error.message };
    }
  }

  function recordAbandonedCart(payload){
    return postRecoveryEvent("/api/abandoned-cart", payload);
  }

  function markAbandonedCartRecovered(payload){
    return postRecoveryEvent("/api/abandoned-cart/recovered", payload);
  }

  if(typeof document !== "undefined"){
    document.addEventListener("click", function(event){
      var cartButton = event.target && event.target.closest ? event.target.closest(".cart-btn[data-product-id]") : null;
      if(cartButton && !cartButton.disabled){
        trackAnalyticsEvent("add_to_cart", { items:[{ id: cartButton.getAttribute("data-product-id") || "" }] });
      }
      var checkoutButton = event.target && event.target.closest ? event.target.closest(".checkout-btn,.payment-btn") : null;
      if(checkoutButton && !checkoutButton.disabled){
        trackAnalyticsEvent("begin_checkout", {});
      }
    }, true);
    if(document.readyState === "loading"){
      document.addEventListener("DOMContentLoaded", initAnalytics, { once:true });
    }else{
      initAnalytics();
    }
  }

  function enhanceImageElement(image){
    if(!image || image.__swadraImgEnhanced) return;
    image.__swadraImgEnhanced = true;
    if(!image.hasAttribute("decoding")){
      image.decoding = "async";
    }
    if(!image.hasAttribute("loading")){
      var critical = !!image.closest(".hero, .navbar, .topbar, .sale-bar, .nav-search-item-media");
      image.loading = critical ? "eager" : "lazy";
    }
    if(!image.hasAttribute("fetchpriority")){
      image.fetchPriority = image.loading === "eager" ? "high" : "low";
    }
    var src = image.getAttribute("src");
    if(src){
      var optimizedSrc = getOptimizedCloudinaryUrl(src, {
        width: image.clientWidth || image.width || 720
      });
      if(optimizedSrc && optimizedSrc !== src){
        image.setAttribute("src", optimizedSrc);
      }
    }
  }

  function enhanceImages(root){
    var scope = root && root.querySelectorAll ? root : document;
    if(!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll("img").forEach(enhanceImageElement);
  }

  function installImagePerformanceObserver(){
    if(typeof document === "undefined" || document.__swadraImageObserverInstalled) return;
    document.__swadraImageObserverInstalled = true;
    var runEnhancement = function(){
      enhanceImages(document);
    };
    if(typeof window.requestIdleCallback === "function"){
      window.requestIdleCallback(runEnhancement, { timeout: 800 });
    }else{
      setTimeout(runEnhancement, 0);
    }
    if(typeof MutationObserver === "function" && document.body){
      var observer = new MutationObserver(function(mutations){
        mutations.forEach(function(mutation){
          mutation.addedNodes.forEach(function(node){
            if(node && node.nodeType === 1){
              if(node.tagName === "IMG"){
                enhanceImageElement(node);
              }else{
                enhanceImages(node);
              }
            }
          });
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  window.SWADRA_PRODUCT_DATA = {
    firebaseConfig: firebaseConfig,
    normalizeProduct: normalizeProductRecord,
    initFirebaseIfNeeded: initFirebaseIfNeeded,
    compressImageForUpload: compressImageForUpload,
    uploadImagesToCloudinary: uploadImagesToCloudinary,
    uploadFilesToCloudinary: uploadFilesToCloudinary,
    uploadVideosToCloudinary: uploadVideosToCloudinary,
    fetchFirestoreProducts: fetchFirestoreProducts,
    fetchProducts: async function(){
      return fetchFirestoreProducts();
    },
    saveProduct: saveFirestoreProduct,
    deleteProduct: deleteFirestoreProduct,
    getOptimizedCloudinaryUrl: getOptimizedCloudinaryUrl,
    enhanceImages: enhanceImages
  };

  window.SWADRA_PRODUCT_REVIEWS = {
    normalizeReview: normalizeProductReview,
    fetchReviews: fetchProductReviews,
    saveReview: saveProductReview
  };

  window.SWADRA_ANALYTICS = {
    init: initAnalytics,
    track: trackAnalyticsEvent,
    normalizeItem: normalizeAnalyticsItem
  };

  window.SWADRA_RECOVERY = {
    recordAbandonedCart: recordAbandonedCart,
    markRecovered: markAbandonedCartRecovered
  };

  window.SWADRA_SITE_CONTENT = {
    createEmptyState: createEmptySiteContent,
    normalizeState: normalizeSiteContentPayload,
    fetchSiteContent: fetchSiteContent,
    saveSiteContent: saveSiteContent,
    fetch: fetchSiteContent,
    save: saveSiteContent
  };

  window.SWADRA_SHIPPING = {
    pickup: getEffectiveShippingPickup(),
    getSettings: getShippingSettings,
    getPickup: getEffectiveShippingPickup,
    getEtaRules: getShippingEtaRules,
    rateChart: JSON.parse(JSON.stringify(ICARRY_SURFACE_RATE_CHART)),
    getFreeDeliveryThreshold: getShippingFreeDeliveryThreshold,
    getDeliveryCharge: getShippingDeliveryCharge,
    detectZone: detectShippingZone,
    estimateSurfaceDelivery: estimateSurfaceDelivery,
    getDeliveryEtaDays: getDeliveryEtaDays,
    formatDeliveryEtaLabel: formatDeliveryEtaLabel,
    getNumericDeliveryCharge: getNumericDeliveryCharge
  };

  window.SWADRA_DATA = {
    fetchUsers: loadUsersCache,
    fetchCart: fetchFirestoreCart,
    saveCart: saveFirestoreCart,
    clearCart: clearFirestoreCart,
    getGuestCart: getGuestCart,
    saveGuestCart: saveGuestCart,
    clearGuestCart: clearGuestCart,
    fetchCheckoutDraft: fetchCheckoutDraft,
    saveCheckoutDraft: saveCheckoutDraft,
    clearCheckoutDraft: clearCheckoutDraft,
    saveOrder: saveFirestoreOrder,
    fetchOrder: fetchFirestoreOrder,
    fetchOrders: fetchAllFirestoreOrders,
    syncOrderIntoUserProfile: syncOrderIntoUserProfile
  };

  window.SWADRA_OFFERS = {
    fetch: async function(forceRefresh){
      var state = await fetchSiteContent(!!forceRefresh);
      return Array.isArray(state && state.offers) ? state.offers.slice() : [];
    },
    renderSaleBar: async function(target, forceRefresh){
      var el = typeof target === "string" ? document.getElementById(target) : target;
      if(!el) return [];
      var offers = await window.SWADRA_OFFERS.fetch(!!forceRefresh);
      var items = offers.map(function(item){ return String(item || "").trim(); }).filter(Boolean);
      var repeated = items.length ? items.concat(items, items) : [];
      var escapedMarkup = repeated.map(function(item){
        return '<span class="sale-bar-item">🚚 ' + item.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") + '</span>';
      }).join("");
      var saleBar = null;
      var track = null;

      if(el.classList && el.classList.contains("sale-bar")){
        saleBar = el;
        track = el.querySelector(".sale-bar-track");
        if(!track){
          track = document.createElement("div");
          track.className = "sale-bar-track";
          saleBar.innerHTML = "";
          saleBar.appendChild(track);
        }
      }else{
        track = el;
        if(track.classList && !track.classList.contains("sale-bar-track")){
          track.classList.add("sale-bar-track");
        }
        saleBar = el.closest ? el.closest(".sale-bar") : null;
      }

      if(track){
        track.innerHTML = escapedMarkup;
        track.style.display = repeated.length ? "flex" : "none";
        track.style.alignItems = "center";
        track.style.justifyContent = "center";
        track.style.minHeight = "22px";
        track.style.width = "max-content";
        track.style.minWidth = "max-content";
        track.style.paddingLeft = "0";
        track.style.color = "#7a3d3d";
        track.style.fontSize = "14px";
        track.style.fontWeight = "700";
        track.style.lineHeight = "18px";
      }
      if(saleBar){
        saleBar.style.minHeight = "22px";
        saleBar.style.padding = "4px 0";
        saleBar.style.display = repeated.length ? "flex" : "none";
        saleBar.style.alignItems = "center";
        saleBar.style.justifyContent = "center";
        saleBar.style.overflow = "hidden";
        saleBar.style.whiteSpace = "nowrap";
        saleBar.style.background = "#f1e3e3";
        saleBar.style.color = "#7a3d3d";
        saleBar.style.fontSize = "14px";
        saleBar.style.fontWeight = "700";
        saleBar.style.lineHeight = "18px";
        saleBar.style.fontFamily = "Arial, sans-serif";
      }
      return items;
    }
  };

  function installUnifiedSaleBarStyles(){
    if(document.getElementById("swadraUnifiedSaleBarStyles")) return;
    var style = document.createElement("style");
    style.id = "swadraUnifiedSaleBarStyles";
    style.textContent = [
      ":root{--top-bar-height:43px;--navbar-height:62px;--sale-bar-height:22px;}",
      ".sale-bar,.swadra-unified-sale-bar{display:none;position:sticky !important;top:calc(var(--top-bar-height) + var(--navbar-height) - 1px) !important;z-index:7000 !important;overflow:hidden;white-space:nowrap;min-height:22px;padding:4px 0;background:#f1e3e3;color:#7a3d3d;font-size:14px;font-weight:700;line-height:18px;border-top:1px solid rgba(198,40,40,0.08);border-bottom:1px solid rgba(198,40,40,0.12);font-family:Arial,sans-serif;align-items:center;justify-content:center;}",
      ".sale-bar-track,.swadra-unified-sale-bar .sale-bar-track{display:flex;align-items:center;justify-content:center;width:max-content;min-width:max-content;min-height:22px;padding-left:0;animation:offerTicker 52s linear infinite;will-change:transform;}",
      ".sale-bar-item,.swadra-unified-sale-bar .sale-bar-item{display:inline-flex;align-items:center;flex:0 0 auto;margin-right:84px;}",
      "@keyframes offerTicker{from{transform:translateX(0)}to{transform:translateX(-100%)}}"
    ].join("");
    document.head.appendChild(style);
  }

  function isAdminPage(){
    return /^\/?admin-/i.test(String(window.location.pathname || "").split("/").pop() || "");
  }

  function applyUnifiedHeaderMetrics(){
    var root = document.documentElement;
    var topBarEl = document.querySelector(".top-bar");
    var navbarEl = document.querySelector(".navbar, .nav");
    var topHeight = topBarEl ? Math.round(topBarEl.getBoundingClientRect().height) : 0;
    var navHeight = navbarEl ? Math.round(navbarEl.getBoundingClientRect().height) : 0;
    if(!topHeight && !navHeight && isAdminPage()){
      topHeight = 1;
    }
    root.style.setProperty("--top-bar-height", topHeight + "px");
    root.style.setProperty("--navbar-height", navHeight + "px");
    root.style.setProperty("--sale-bar-height", "22px");
  }

  function ensureUnifiedSaleBarElement(){
    var saleBar = document.querySelector(".sale-bar");
    if(saleBar) return saleBar;
    if(isAdminPage()){
      saleBar = document.createElement("div");
      saleBar.className = "sale-bar swadra-unified-sale-bar";
      saleBar.innerHTML = '<div class="sale-bar-track"></div>';
      if(document.body.firstChild){
        document.body.insertBefore(saleBar, document.body.firstChild);
      }else{
        document.body.appendChild(saleBar);
      }
      return saleBar;
    }
    var anchor = document.querySelector(".navbar, .nav");
    if(!anchor) return null;
    saleBar = document.createElement("div");
    saleBar.className = "sale-bar swadra-unified-sale-bar";
    saleBar.innerHTML = '<div class="sale-bar-track"></div>';
    if(anchor.nextSibling){
      anchor.parentNode.insertBefore(saleBar, anchor.nextSibling);
    }else{
      anchor.parentNode.appendChild(saleBar);
    }
    return saleBar;
  }

  function renderAdminSaleBar(saleBar){
    if(!saleBar) return;
    var track = saleBar.querySelector(".sale-bar-track");
    if(!track){
      track = document.createElement("div");
      track.className = "sale-bar-track";
      saleBar.appendChild(track);
    }
    var notices = [
      "Admin Notice • Manage products, offers, orders and customer updates from one panel",
      "Admin Notice • Double-check live changes before saving to the storefront",
      "Admin Notice • Offer bar style is now aligned with the storefront header"
    ];
    track.innerHTML = notices.concat(notices).map(function(item){
      return '<span class="sale-bar-item">' + item.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") + '</span>';
    }).join("");
    saleBar.style.display = "flex";
  }

  function installUnifiedSaleBar(){
    installUnifiedSaleBarStyles();
    applyUnifiedHeaderMetrics();
    var saleBar = ensureUnifiedSaleBarElement();
    if(!saleBar) return;
    if(isAdminPage()){
      renderAdminSaleBar(saleBar);
    }else{
      window.SWADRA_OFFERS.renderSaleBar(saleBar, false).catch(function(error){
        console.error("sale bar render failed", error);
      });
    }
  }

  function installGlobalHeaderSearchSubmit(){
    if(document.__swadraHeaderSearchSubmitInstalled) return;
    document.__swadraHeaderSearchSubmitInstalled = true;

    var searchCache = null;

    function normalizeHeaderSearchText(value){
      return String(value || "").toLowerCase().trim();
    }

    function getSearchInput(){
      return document.getElementById("searchInput");
    }

    function getSearchResults(){
      return document.getElementById("searchResults");
    }

    function escapeHeaderSearchAttr(value){
      return String(value || "")
        .replace(/&/g,"&amp;")
        .replace(/</g,"&lt;")
        .replace(/>/g,"&gt;")
        .replace(/"/g,"&quot;");
    }

  function setPendingHeaderSearchState(query, productId){
      window.__swadraPendingHeaderSearch = {
        query: String(query || "").trim(),
        productId: String(productId || "").trim()
      };
    }

    function getDomSearchProducts(){
      var seen = {};
      var items = [];
      document.querySelectorAll("[data-product-name], .product-card, .spices-card-final, .home-spice-card").forEach(function(card, index){
        var name = String(
          card.getAttribute && card.getAttribute("data-product-name")
          || (card.querySelector && card.querySelector("h3") && card.querySelector("h3").textContent)
          || ""
        ).trim();
        if(!name) return;
        var size = String(
          card.getAttribute && card.getAttribute("data-product-size")
          || (card.querySelector && card.querySelector(".size") && card.querySelector(".size").textContent)
          || ""
        ).trim();
        var category = String(card.getAttribute && card.getAttribute("data-category") || "").trim();
        var image = "";
        var imageNode = card.querySelector && card.querySelector("img");
        if(imageNode){
          image = String(imageNode.getAttribute("src") || "").trim();
        }
        var id = String(card.getAttribute && card.getAttribute("data-product-id") || name + "::" + size + "::" + index);
        if(seen[id]) return;
        seen[id] = true;
        items.push({
          id: id,
          name: name,
          size: size,
          category: category || "Product",
          image: image
        });
      });
      return items;
    }

    async function getHeaderSearchProducts(){
      if(Array.isArray(searchCache) && searchCache.length){
        return searchCache;
      }

      var domItems = getDomSearchProducts();
      var apiItems = [];
      try{
        var productApi = window.SWADRA_PRODUCT_DATA || null;
        if(productApi && typeof productApi.fetchProducts === "function"){
          var fetched = await productApi.fetchProducts();
          apiItems = (Array.isArray(fetched) ? fetched : []).map(function(product, index){
            var normalized = productApi && typeof productApi.normalizeProduct === "function"
              ? productApi.normalizeProduct(product, product && product.id)
              : (product || {});
            return {
              id: String(normalized && normalized.id || product && product.id || ("search-product-" + index)),
              name: String(normalized && (normalized.name || normalized.productName) || "").trim(),
              size: String(normalized && (normalized.size || normalized.productSize) || "").trim(),
              category: String(normalized && normalized.category || "Product").trim(),
              image: String(normalized && (normalized.image || normalized.imageUrl || (normalized.images && normalized.images[0])) || "").trim()
            };
          }).filter(function(item){ return item.name; });
        }
      }catch(error){
        console.error("global header search fetch failed", error);
      }

      var merged = [];
      var seen = {};
      apiItems.concat(domItems).forEach(function(item, index){
        var key = String(item && item.id || item && item.name || index);
        if(!item || !item.name || seen[key]) return;
        seen[key] = true;
        merged.push(item);
      });
      searchCache = merged;
      return merged;
    }

    function renderGlobalHeaderSearchResults(items){
      var searchResults = getSearchResults();
      if(!searchResults) return;

      if(!items.length){
        searchResults.innerHTML = '<div class="nav-search-item"><div class="nav-search-copy"><strong>No product found</strong><span>Try another keyword</span></div></div>';
        searchResults.classList.add("show");
        return;
      }

      searchResults.innerHTML = items.slice(0, 8).map(function(item){
        var name = escapeHeaderSearchAttr(item.name || "Swadra Product");
        var category = escapeHeaderSearchAttr(item.category || "Product");
        var size = escapeHeaderSearchAttr(item.size || "");
        var image = String(item.image || "https://via.placeholder.com/80").replace(/"/g, "&quot;");
        var productId = escapeHeaderSearchAttr(item.id || "");
        return '<div class="nav-search-item" data-search-name="' + name + '"><div class="nav-search-item-media"><img src="' + image + '" alt="' + name + '"><div class="nav-search-copy"><strong>' + name + '</strong><span>' + category + (size ? " • " + size : "") + '</span></div></div><button type="button">View</button></div>';
      }).join("");
      searchResults.classList.add("show");
    }

    function findMatchingDomCard(query){
      var normalizedQuery = normalizeHeaderSearchText(query);
      if(!normalizedQuery) return null;
      var cards = Array.prototype.slice.call(document.querySelectorAll(".product-card, .spices-card-final, .home-spice-card"));
      for(var i = 0; i < cards.length; i += 1){
        var text = normalizeHeaderSearchText(cards[i].innerText || cards[i].textContent || "");
        if(text.indexOf(normalizedQuery) !== -1){
          return cards[i];
        }
      }
      return null;
    }

    async function submitHeaderSearch(input){
      var field = input || document.getElementById("searchInput");
      var query = String(field && field.value || "").trim();
      if(!query) return;

      setPendingHeaderSearchState(query, "");

      var page = String(window.location.pathname || "").split("/").pop().toLowerCase();
      var isIndexPage = !page || page === "index.html";
      var localMatch = findMatchingDomCard(query);

      if(isIndexPage && typeof window.showAllProductsCatalog === "function"){
        try{
          await window.showAllProductsCatalog();
          if(typeof window.focusCatalogProduct === "function"){
            requestAnimationFrame(function(){
              window.focusCatalogProduct("", query);
            });
          }else{
            requestAnimationFrame(function(){
              var match = findMatchingDomCard(query);
              if(match && typeof match.scrollIntoView === "function"){
                match.scrollIntoView({ behavior:"smooth", block:"center" });
              }
            });
          }
          var searchResults = document.getElementById("searchResults");
          if(searchResults) searchResults.classList.remove("show");
          return;
        }catch(error){
          console.error("header search submit failed", error);
        }
      }

      if(localMatch && typeof localMatch.scrollIntoView === "function"){
        localMatch.scrollIntoView({ behavior:"smooth", block:"center" });
        try{
          localMatch.style.boxShadow = "0 0 0 3px rgba(183,110,121,0.55), 0 12px 30px rgba(0,0,0,0.12)";
          setTimeout(function(){
            localMatch.style.boxShadow = "";
          }, 1800);
        }catch(error){}
        var searchResults = document.getElementById("searchResults");
        if(searchResults) searchResults.classList.remove("show");
        return;
      }

      window.location.href = "index.html?search=" + encodeURIComponent(query);
    }
    window.SWADRA_SUBMIT_HEADER_SEARCH = submitHeaderSearch;

    document.addEventListener("input", function(event){
      var target = event.target;
      if(!target || target.id !== "searchInput") return;

      var query = normalizeHeaderSearchText(target.value);
      var searchResults = getSearchResults();
      if(!searchResults) return;

      if(!query){
        searchResults.classList.remove("show");
        searchResults.innerHTML = "";
        return;
      }

      getHeaderSearchProducts().then(function(products){
        var filtered = products.filter(function(item){
          var haystack = normalizeHeaderSearchText((item && item.name) + " " + (item && item.category) + " " + (item && item.size));
          return haystack.indexOf(query) !== -1;
        });
        renderGlobalHeaderSearchResults(filtered);
      });
    }, true);

    document.addEventListener("focusin", function(event){
      var target = event.target;
      if(!target || target.id !== "searchInput") return;
      var query = normalizeHeaderSearchText(target.value);
      if(!query) return;
      getHeaderSearchProducts().then(function(products){
        var filtered = products.filter(function(item){
          var haystack = normalizeHeaderSearchText((item && item.name) + " " + (item && item.category) + " " + (item && item.size));
          return haystack.indexOf(query) !== -1;
        });
        renderGlobalHeaderSearchResults(filtered);
      });
    }, true);

    document.addEventListener("keydown", function(event){
      var target = event.target;
      if(!target || target.id !== "searchInput" || event.key !== "Enter") return;
      event.preventDefault();
      submitHeaderSearch(target);
    }, true);

    document.addEventListener("search", function(event){
      var target = event.target;
      if(!target || target.id !== "searchInput") return;
      if(!String(target.value || "").trim()) return;
      submitHeaderSearch(target);
    }, true);

    document.addEventListener("click", function(event){
      var row = event.target && event.target.closest ? event.target.closest(".nav-search-item[data-search-name]") : null;
      if(row){
        event.preventDefault();
        var input = getSearchInput();
        var query = String(row.getAttribute("data-search-name") || "").trim();
        if(input) input.value = query;
        submitHeaderSearch({ value: query });
        return;
      }

      var searchResults = getSearchResults();
      if(searchResults && !event.target.closest("#searchInput") && !event.target.closest("#searchResults")){
        searchResults.classList.remove("show");
      }
    }, true);
  }

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", function(){
      var currentPath = String(window.location.pathname || "");
      var isAdminPage = /^\/?admin-/i.test(currentPath.split("/").filter(Boolean).pop() || "") || /^\/?backend\//i.test(currentPath.replace(/^\/+/, ""));
      ensureFirebaseAuthSync().catch ? ensureFirebaseAuthSync().catch(function(){}) : ensureFirebaseAuthSync();
      syncAuthUserFromUrl();
      ensureAuthUserInUrl();
      installImagePerformanceObserver();
      if(!isAdminPage){
        authReady().catch(function(error){ console.warn("users bootstrap unavailable", error); });
      }
      installUnifiedSaleBar();
      installGlobalHeaderSearchSubmit();
      syncInternalLinksWithAuth(document);
    }, { once: true });
  }else{
    var currentPath = String(window.location.pathname || "");
    var isAdminPage = /^\/?admin-/i.test(currentPath.split("/").filter(Boolean).pop() || "") || /^\/?backend\//i.test(currentPath.replace(/^\/+/, ""));
    ensureFirebaseAuthSync().catch ? ensureFirebaseAuthSync().catch(function(){}) : ensureFirebaseAuthSync();
    syncAuthUserFromUrl();
    ensureAuthUserInUrl();
    installImagePerformanceObserver();
    if(!isAdminPage){
      authReady().catch(function(error){ console.warn("users bootstrap unavailable", error); });
    }
    installUnifiedSaleBar();
    installGlobalHeaderSearchSubmit();
    syncInternalLinksWithAuth(document);
  }

  window.addEventListener("resize", function(){
    applyUnifiedHeaderMetrics();
  });
})();
