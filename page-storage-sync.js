(function(){
  var DEFAULT_REMOTE_BASE = "https://swadra-backend-production.up.railway.app";

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
    var persistedKeys = Array.isArray(opts.persistedKeys) ? opts.persistedKeys.filter(Boolean) : [];
    var storageTarget = {};
    var pendingState = {};
    var pendingRemove = {};
    var flushTimer = null;
    var apiBase = normalizeUrl(opts.apiBase || getApiBase());
    var endpoint = apiBase + "/api/app-state";

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

    if(persistedKeys.length){
      try{
        var xhr = new XMLHttpRequest();
        xhr.open("GET", endpoint + "?keys=" + encodeURIComponent(persistedKeys.join(",")), false);
        xhr.send(null);
        if(xhr.status >= 200 && xhr.status < 300){
          var response = JSON.parse(xhr.responseText || "{}");
          var state = response && response.state && typeof response.state === "object" ? response.state : {};
          Object.keys(state).forEach(function(key){
            var stringValue = toStorageString(state[key]);
            if(stringValue !== null){
              storageTarget[key] = stringValue;
            }
          });
        }
      }catch(error){}
    }

    var customStorage = {
      getItem: function(key){
        var name = String(key);
        return Object.prototype.hasOwnProperty.call(storageTarget, name) ? storageTarget[name] : null;
      },
      setItem: function(key, value){
        var name = String(key);
        storageTarget[name] = String(value);
        queueSync(name, false);
      },
      removeItem: function(key){
        var name = String(key);
        delete storageTarget[name];
        queueSync(name, true);
      },
      clear: function(){
        Object.keys(storageTarget).forEach(function(key){
          delete storageTarget[key];
          queueSync(key, true);
        });
      },
      key: function(index){
        var keys = Object.keys(storageTarget);
        return Number.isInteger(index) && index >= 0 && index < keys.length ? keys[index] : null;
      }
    };

    Object.defineProperty(customStorage, "length", {
      get: function(){
        return Object.keys(storageTarget).length;
      }
    });

    try{
      Object.defineProperty(window, "localStorage", { value: customStorage, configurable: true });
    }catch(error){
      window.localStorage = customStorage;
    }

    try{
      Object.defineProperty(window, "sessionStorage", { value: customStorage, configurable: true });
    }catch(error){
      window.sessionStorage = customStorage;
    }

    try{
      Object.defineProperty(window, "indexedDB", { value: createDisabledIndexedDb(pageName), configurable: true });
    }catch(error){
      window.indexedDB = createDisabledIndexedDb(pageName);
    }

    window["__swadra" + pageName.replace(/[^a-z0-9]/gi, "") + "StorageSync"] = {
      endpoint: endpoint,
      persistedKeys: persistedKeys.slice(),
      storage: customStorage
    };
  };
})();
