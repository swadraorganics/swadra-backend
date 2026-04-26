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
      var saved = JSON.parse(sessionStorage.getItem("swadra_backend_panel_settings_v2") || "{}");
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

  var storageProto = window.Storage && window.Storage.prototype;
  var rawGetItem = storageProto && storageProto.getItem;
  var rawSetItem = storageProto && storageProto.setItem;
  var rawRemoveItem = storageProto && storageProto.removeItem;
  var rawSessionGet = rawGetItem ? function(key){ return rawGetItem.call(window.sessionStorage, key); } : function(){ return null; };
  var rawSessionSet = rawSetItem ? function(key, value){ rawSetItem.call(window.sessionStorage, key, value); } : function(){};
  var rawSessionRemove = rawRemoveItem ? function(key){ rawRemoveItem.call(window.sessionStorage, key); } : function(){};
  var rawLocalGet = rawGetItem ? function(key){ return rawGetItem.call(window.localStorage, key); } : function(){ return null; };
  var rawLocalSet = rawSetItem ? function(key, value){ rawSetItem.call(window.localStorage, key, value); } : function(){};
  var rawLocalRemove = rawRemoveItem ? function(key){ rawRemoveItem.call(window.localStorage, key); } : function(){};
  var SESSION_PROXY_KEYS = {
    currentUser: true,
    userPhone: true,
    tempUser: true,
    otp: true,
    redirectAfterLogin: true,
    currentOrderId: true,
    swadraCartMergeNotice: true
  };
  var BLOCKED_BUSINESS_KEYS = {
    users: true,
    orders: true,
    adminOrders: true,
    swadraOrders: true,
    customerOrders: true,
    allOrders: true
  };
  var UI_LOCAL_KEYS = {
    cart: true,
    checkoutUpiId: true,
    swadraHeaderSearch: true,
    adminPausedCustomers: true,
    adminDeletedCustomers: true,
    adminCustomersUpdatedAt: true
  };
  var usersCache = {};
  var usersCacheRequest = null;
  var usersCacheLoaded = false;
  var USERS_COLLECTION = "users";

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

  function installStorageGuards(){
    if(!storageProto || storageProto.__swadraStorageGuardInstalled){
      return;
    }
    storageProto.__swadraStorageGuardInstalled = true;

    storageProto.getItem = function(key){
      if(this === window.localStorage){
        if(key === "users"){
          return JSON.stringify(sanitizeUsersMap(usersCache));
        }
        if(SESSION_PROXY_KEYS[key]){
          return rawSessionGet(key);
        }
        if(BLOCKED_BUSINESS_KEYS[key]){
          return null;
        }
        if(UI_LOCAL_KEYS[key]){
          return rawLocalGet(key);
        }
        return null;
      }
      return rawGetItem.call(this, key);
    };

    storageProto.setItem = function(key, value){
      if(this === window.localStorage){
        if(key === "users"){
          return;
        }
        if(SESSION_PROXY_KEYS[key]){
          rawSessionSet(key, String(value));
          return;
        }
        if(BLOCKED_BUSINESS_KEYS[key]){
          console.warn("Blocked browser persistence for business-data key:", key);
          return;
        }
        if(UI_LOCAL_KEYS[key]){
          rawLocalSet(key, String(value));
        }
        return;
      }
      return rawSetItem.call(this, key, value);
    };

    storageProto.removeItem = function(key){
      if(this === window.localStorage){
        if(key === "users"){
          return;
        }
        if(SESSION_PROXY_KEYS[key]){
          rawSessionRemove(key);
          return;
        }
        if(BLOCKED_BUSINESS_KEYS[key]){
          return;
        }
        if(UI_LOCAL_KEYS[key]){
          rawLocalRemove(key);
        }
        return;
      }
      return rawRemoveItem.call(this, key);
    };
  }

  installStorageGuards();

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

  function getCurrentUserEmail(){
    return String(getSessionValue("currentUser") || "").trim().toLowerCase();
  }

  function getAuthUsers(){
    return sanitizeUsersMap(usersCache);
  }

  async function loadUsersCache(forceRefresh){
    var db = initFirestore();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
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
        var user = sanitizeUserRecord(Object.assign({}, data, { email: data.email || doc.id }), doc.id);
        if(user.email){
          next[user.email] = user;
        }
      });
      usersCache = next;
      usersCacheLoaded = true;
      return getAuthUsers();
    }).finally(function(){
      usersCacheRequest = null;
    });
    return usersCacheRequest;
  }

  async function saveAuthUsers(users){
    var db = initFirestore();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    var nextUsers = sanitizeUsersMap(users);
    usersCache = nextUsers;
    usersCacheLoaded = true;
    var batch = db.batch();
    Object.keys(nextUsers).forEach(function(email){
      batch.set(db.collection(USERS_COLLECTION).doc(email), nextUsers[email], { merge: true });
    });
    await batch.commit();
    return getAuthUsers();
  }

  async function saveAuthUserRecord(user){
    var db = initFirestore();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    var record = sanitizeUserRecord(user, user && user.email);
    if(!record.email){
      throw new Error("User email is required");
    }
    record.updatedAt = new Date().toISOString();
    if(!record.createdAt){
      record.createdAt = record.updatedAt;
    }
    usersCache[record.email] = record;
    usersCacheLoaded = true;
    await db.collection(USERS_COLLECTION).doc(record.email).set(record, { merge: true });
    return cloneValue(record);
  }

  async function deleteAuthUserRecord(email){
    var normalizedEmail = String(email || "").trim().toLowerCase();
    if(!normalizedEmail) return;
    var db = initFirestore();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    await db.collection(USERS_COLLECTION).doc(normalizedEmail).delete();
    delete usersCache[normalizedEmail];
  }

  function getCurrentUserRecord(){
    var email = getCurrentUserEmail();
    var users = getAuthUsers();
    return email && users[email] ? users[email] : null;
  }

  async function findUserRecordByIdentifiers(email, phone, options){
    var config = options && typeof options === "object" ? options : {};
    var normalizedEmail = normalizeEmailValue(email);
    var normalizedPhone = normalizePhoneValue(phone);
    await loadUsersCache(!!config.forceRefresh);
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
    return normalizedEmail;
  }

  function clearCurrentUserSession(){
    ["currentUser", "userPhone", "tempUser", "otp"].forEach(function(key){
      rawSessionRemove(key);
    });
  }

  function getRedirectAfterLogin(){
    return String(getSessionValue("redirectAfterLogin") || "").trim();
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
    return redirectTo;
  }

  function compactAuthCartItems(cart){
    return (Array.isArray(cart) ? cart : []).map(compactCartItem);
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
    var guestCart = compactAuthCartItems(tryParseJson(rawLocalGet("cart"), []));
    var userCart = compactAuthCartItems(user.cart || []);
    var mergedCount = 0;
    guestCart.forEach(function(item){
      var existing = userCart.find(function(userItem){
        return String(userItem.id) === String(item.id);
      });
      if(existing){
        existing.qty = Number(existing.qty || 0) + Number(item.qty || 0);
        if(item.price) existing.price = Number(item.price);
        if(item.mrp) existing.mrp = Number(item.mrp);
        if(item.image) existing.image = item.image;
        if(Array.isArray(item.images) && item.images.length){
          existing.images = item.images.slice(0, 4);
        }
        mergedCount += Math.max(1, Number(item.qty || 0) || 1);
      }else{
        userCart.push(item);
        mergedCount += Math.max(1, Number(item.qty || 0) || 1);
      }
    });
    users[normalizedEmail].cart = compactAuthCartItems(userCart);
    saveAuthUserRecord(users[normalizedEmail]).catch(function(error){
      console.error("guest cart merge failed", error);
    });
    rawLocalSet("cart", JSON.stringify(users[normalizedEmail].cart));
    setCartMergeNotice(mergedCount > 0 ? {
      mergedCount: mergedCount,
      cartCount: users[normalizedEmail].cart.length,
      message: "The new products you added have been added to your cart."
    } : null);
    return users[normalizedEmail].cart.slice();
  }

  async function createOrUpdateUserAccount(payload){
    var source = payload && typeof payload === "object" ? payload : {};
    var email = normalizeEmailValue(source.email);
    var phone = String(source.phone || "").trim();
    var normalizedPhone = normalizePhoneValue(phone);
    if(!email){
      throw new Error("Email is required");
    }
    var existingUser = await findUserRecordByIdentifiers(email, phone, { forceRefresh: !!source.forceRefresh }) || {};
    var existingEmail = normalizeEmailValue(existingUser.email);
    if(existingEmail && existingEmail !== email && source.preventDuplicate !== false){
      return {
        record: cloneValue(existingUser),
        existed: true,
        duplicateField: existingUser.phoneNormalized === normalizedPhone ? "phone" : "email"
      };
    }
    var nextRecord = sanitizeUserRecord({
      id: existingUser.id || existingUser.userId || existingUser.uid || email,
      userId: existingUser.userId || existingUser.uid || existingUser.id || email,
      uid: existingUser.uid || existingUser.userId || existingUser.id || email,
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

  function signOutUser(options){
    var keepCart = !!(options && options.keepCart);
    clearCurrentUserSession();
    rawSessionRemove("redirectAfterLogin");
    if(!keepCart){
      rawLocalSet("cart", JSON.stringify([]));
    }
  }

  window.SWADRA_AUTH = {
    ready: loadUsersCache,
    refreshUsers: function(){ return loadUsersCache(true); },
    getUsers: getAuthUsers,
    saveUsers: saveAuthUsers,
    saveUserRecord: saveAuthUserRecord,
    deleteUserRecord: deleteAuthUserRecord,
    getCurrentUserEmail: getCurrentUserEmail,
    getCurrentUser: getCurrentUserEmail,
    getCurrentUserRecord: getCurrentUserRecord,
    setCurrentUserSession: setCurrentUserSession,
    clearCurrentUserSession: clearCurrentUserSession,
    getRedirectAfterLogin: getRedirectAfterLogin,
    setRedirectAfterLogin: setRedirectAfterLogin,
    consumeRedirectAfterLogin: consumeRedirectAfterLogin,
    mergeGuestCartIntoUser: mergeGuestCartIntoUser,
    consumeCartMergeNotice: consumeCartMergeNotice,
    createOrUpdateUserAccount: createOrUpdateUserAccount,
    findUserByEmailOrPhone: findUserRecordByIdentifiers,
    signInUser: signInUser,
    signOutUser: signOutUser
  };

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
      console.error("firebase init failed", error);
    }
    return firestoreDb;
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
    var storyCounter = source.swadra_home_family_story_v1 && typeof source.swadra_home_family_story_v1 === "object"
      ? cloneValue(source.swadra_home_family_story_v1)
      : {};
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
    homeContent.websiteOffline = websiteOffline;

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
      websiteOffline: websiteOffline,
      swadra_home_family_story_v1: storyCounter
    };
  }

  async function fetchSiteContent(forceRefresh){
    var db = initFirebaseIfNeeded();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    var now = Date.now();
    if(!forceRefresh && siteContentCache && now - siteContentCacheAt < SITE_CONTENT_TTL_MS){
      return cloneValue(siteContentCache);
    }
    if(siteContentRequest){
      return siteContentRequest;
    }
    siteContentRequest = db.collection(SITE_CONTENT_COLLECTION).doc(SITE_CONTENT_DOCUMENT).get().then(function(doc){
      var next = doc.exists ? normalizeSiteContentPayload(doc.data()) : createEmptySiteContent();
      siteContentCache = next;
      siteContentCacheAt = Date.now();
      return cloneValue(next);
    }).catch(function(error){
      throw error;
    }).finally(function(){
      siteContentRequest = null;
    });
    return siteContentRequest;
  }

  async function saveSiteContent(partial){
    var db = initFirebaseIfNeeded();
    if(!db) throw firebaseInitError || new Error("Firestore unavailable");
    var current = await fetchSiteContent(true).catch(function(){ return createEmptySiteContent(); });
    var mergedHomeContent = Object.assign({}, current.homeContent || {}, partial && partial.homeContent || {});
    if(partial && partial.websiteOffline !== undefined){
      mergedHomeContent.websiteOffline = !!partial.websiteOffline;
    }
    var merged = normalizeSiteContentPayload({
      homeContent: mergedHomeContent,
      offers: partial && partial.offers !== undefined ? partial.offers : current.offers,
      heroImages: partial && partial.heroImages !== undefined ? partial.heroImages : current.heroImages,
      customers: partial && partial.customers !== undefined ? partial.customers : current.customers,
      familyCards: partial && partial.familyCards !== undefined ? partial.familyCards : current.familyCards,
      coupons: partial && partial.coupons !== undefined ? partial.coupons : current.coupons,
      websiteOffline: partial && partial.websiteOffline !== undefined ? partial.websiteOffline : current.websiteOffline,
      swadra_home_family_story_v1: Object.assign({}, current.swadra_home_family_story_v1 || {}, partial && partial.swadra_home_family_story_v1 || {})
    });
    merged.homeContent.updatedAt = Date.now();
    await db.collection(SITE_CONTENT_COLLECTION).doc(SITE_CONTENT_DOCUMENT).set(merged, { merge: true });
    siteContentCache = merged;
    siteContentCacheAt = Date.now();
    firestoreProductsCache = null;
    firestoreProductsCacheAt = 0;
    return cloneValue(merged);
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
      availability: normalized.availability,
      outOfStock: normalized.outOfStock,
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

  window.SWADRA_SITE_CONTENT = {
    createEmptyState: createEmptySiteContent,
    normalizeState: normalizeSiteContentPayload,
    fetchSiteContent: fetchSiteContent,
    saveSiteContent: saveSiteContent,
    fetch: fetchSiteContent,
    save: saveSiteContent
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
      try{
        localStorage.setItem("swadraHeaderSearch", String(query || "").trim());
        if(String(productId || "").trim()){
          localStorage.setItem("swadraHeaderSearchProductId", String(productId).trim());
        }else{
          localStorage.removeItem("swadraHeaderSearchProductId");
        }
      }catch(error){}
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

      window.location.href = "index.html";
    }

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
      installImagePerformanceObserver();
      loadUsersCache(false).catch(function(error){ console.error("users bootstrap failed", error); });
      installUnifiedSaleBar();
      installGlobalHeaderSearchSubmit();
    }, { once: true });
  }else{
    installImagePerformanceObserver();
    loadUsersCache(false).catch(function(error){ console.error("users bootstrap failed", error); });
    installUnifiedSaleBar();
    installGlobalHeaderSearchSubmit();
  }

  window.addEventListener("resize", function(){
    applyUnifiedHeaderMetrics();
  });
})();
