(function(){
  var DEFAULT_REMOTE_BASE = "https://swadra-backend-production.up.railway.app";
  var nativeLocalStorage = window.localStorage;
  var nativeSessionStorage = window.sessionStorage;
  var LOCAL_ONLY_KEYS = {
    cart: true,
    currentUser: true,
    redirectAfterLogin: true,
    tempUser: true,
    otp: true,
    dashboardPasswordOtp: true,
    userPhone: true,
    checkoutData: true,
    cartSummary: true,
    delivery: true,
    couponDiscount: true,
    currentOrderId: true,
    supportOrderId: true,
    checkoutUpiId: true,
    paymentSession: true
  };

  function normalizeUrl(url){
    return String(url || "").trim().replace(/\/+$/, "");
  }

  function getApiBase(){
    var host = String(window.location.hostname || "").toLowerCase();
    if(host === "localhost" || host === "127.0.0.1"){
      return "http://127.0.0.1:3000";
    }
    return DEFAULT_REMOTE_BASE;
  }

  function isLocalOnlyKey(key){
    return !!LOCAL_ONLY_KEYS[String(key || "").trim()];
  }

  function toStorageString(value){
    if(value === undefined || value === null) return null;
    if(typeof value === "string") return value;
    if(typeof value === "number" || typeof value === "boolean") return String(value);
    try{
      return JSON.stringify(value);
    }catch(error){
      return String(value);
    }
  }

  function fromStorageString(value){
    if(value === null || value === undefined) return null;
    if(value === "true") return true;
    if(value === "false") return false;
    if(value !== "" && !isNaN(value) && String(Number(value)) === value){
      return Number(value);
    }
    try{
      return JSON.parse(value);
    }catch(error){
      return value;
    }
  }

  function createDisabledIndexedDb(pageName){
    return {
      open: function(){
        var request = { result:null, error:new Error("indexedDB disabled on " + pageName) };
        setTimeout(function(){
          if(typeof request.onerror === "function"){
            request.onerror({ target: request });
          }
        }, 0);
        return request;
      },
      deleteDatabase: function(){
        var request = { result:null, error:new Error("indexedDB disabled on " + pageName) };
        setTimeout(function(){
          if(typeof request.onerror === "function"){
            request.onerror({ target: request });
          }
        }, 0);
        return request;
      }
    };
  }

  window.installSwadraPageStorageSync = function(options){
    var opts = options || {};
    var pageName = String(opts.pageName || "page");
    var persistedKeys = Array.isArray(opts.persistedKeys) ? opts.persistedKeys.filter(function(key){
      return key && !isLocalOnlyKey(key);
    }) : [];
    var storageTarget = {};
    var pendingState = {};
    var pendingRemove = {};
    var flushTimer = null;
    var apiBase = normalizeUrl(opts.apiBase || getApiBase());
    var endpoint = apiBase + "/api/app-state";

    function emitStorageEvent(key, oldValue, newValue){
      try{
        window.dispatchEvent(new StorageEvent("storage", {
          key: key,
          oldValue: oldValue,
          newValue: newValue,
          storageArea: customStorage
        }));
      }catch(error){
        try{
          var event = document.createEvent("Event");
          event.initEvent("storage", false, false);
          event.key = key;
          event.oldValue = oldValue;
          event.newValue = newValue;
          event.storageArea = customStorage;
          window.dispatchEvent(event);
        }catch(innerError){}
      }
    }

    function flush(){
      flushTimer = null;
      var state = pendingState;
      var removeKeys = Object.keys(pendingRemove);
      pendingState = {};
      pendingRemove = {};
      if(!Object.keys(state).length && !removeKeys.length) return;
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: state, removeKeys: removeKeys }),
        keepalive: true
      }).catch(function(){});
    }

    function queueSync(key, remove){
      if(persistedKeys.indexOf(key) === -1) return;
      if(remove){
        delete pendingState[key];
        pendingRemove[key] = true;
      }else{
        pendingState[key] = fromStorageString(storageTarget[key]);
        delete pendingRemove[key];
      }
      if(flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, 200);
    }

    if(persistedKeys.length && nativeLocalStorage){
      persistedKeys.forEach(function(key){
        try{
          var localValue = nativeLocalStorage.getItem(key);
          if(localValue !== null){
            storageTarget[key] = localValue;
          }
        }catch(error){}
      });
    }

    var customStorage = {
      getItem: function(key){
        var name = String(key);
        if(persistedKeys.indexOf(name) === -1){
          return nativeLocalStorage ? nativeLocalStorage.getItem(name) : null;
        }
        return Object.prototype.hasOwnProperty.call(storageTarget, name) ? storageTarget[name] : null;
      },
      setItem: function(key, value){
        var name = String(key);
        if(persistedKeys.indexOf(name) === -1){
          if(nativeLocalStorage) nativeLocalStorage.setItem(name, String(value));
          return;
        }
        storageTarget[name] = String(value);
        queueSync(name, false);
      },
      removeItem: function(key){
        var name = String(key);
        if(persistedKeys.indexOf(name) === -1){
          if(nativeLocalStorage) nativeLocalStorage.removeItem(name);
          return;
        }
        delete storageTarget[name];
        queueSync(name, true);
      },
      clear: function(){
        if(nativeLocalStorage && typeof nativeLocalStorage.clear === "function"){
          nativeLocalStorage.clear();
        }
        Object.keys(storageTarget).forEach(function(key){
          delete storageTarget[key];
          queueSync(key, true);
        });
      },
      key: function(index){
        var persisted = Object.keys(storageTarget);
        var localKeys = [];
        try{
          if(nativeLocalStorage){
            for(var i=0;i<nativeLocalStorage.length;i++){
              var keyName = nativeLocalStorage.key(i);
              if(keyName && persisted.indexOf(keyName) === -1){
                localKeys.push(keyName);
              }
            }
          }
        }catch(error){}
        var keys = persisted.concat(localKeys);
        return Number.isInteger(index) && index >= 0 && index < keys.length ? keys[index] : null;
      }
    };

    Object.defineProperty(customStorage, "length", {
      get: function(){
        var total = Object.keys(storageTarget).length;
        try{
          if(nativeLocalStorage){
            for(var i=0;i<nativeLocalStorage.length;i++){
              var keyName = nativeLocalStorage.key(i);
              if(keyName && !Object.prototype.hasOwnProperty.call(storageTarget, keyName)){
                total += 1;
              }
            }
          }
        }catch(error){}
        return total;
      }
    });

    try{
      Object.defineProperty(window, "localStorage", { value: customStorage, configurable: true });
    }catch(error){
      window.localStorage = customStorage;
    }

    try{
      Object.defineProperty(window, "sessionStorage", { value: nativeSessionStorage || customStorage, configurable: true });
    }catch(error){
      window.sessionStorage = nativeSessionStorage || customStorage;
    }

    try{
      Object.defineProperty(window, "indexedDB", { value: createDisabledIndexedDb(pageName), configurable: true });
    }catch(error){
      window.indexedDB = createDisabledIndexedDb(pageName);
    }

    if(persistedKeys.length){
      fetch(endpoint + "?keys=" + encodeURIComponent(persistedKeys.join(",")), { cache: "no-store" })
        .then(function(response){
          if(!response.ok) throw new Error("state bootstrap failed");
          return response.json();
        })
        .then(function(response){
          var state = response && response.state && typeof response.state === "object" ? response.state : {};
          Object.keys(state).forEach(function(key){
            var stringValue = toStorageString(state[key]);
            if(stringValue === null) return;
            var oldValue = Object.prototype.hasOwnProperty.call(storageTarget, key) ? storageTarget[key] : null;
            if(oldValue === stringValue) return;
            storageTarget[key] = stringValue;
            emitStorageEvent(key, oldValue, stringValue);
          });
        })
        .catch(function(){});
    }

    window["__swadra" + pageName.replace(/[^a-z0-9]/gi, "") + "StorageSync"] = {
      endpoint: endpoint,
      persistedKeys: persistedKeys.slice(),
      storage: customStorage
    };
  };
})();
