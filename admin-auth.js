(function(){
  var SESSION_KEY = "swadra_admin_session_v2";
  var INACTIVITY_MS = 10 * 60 * 1000;
  var ACTIVITY_EVENTS = ["click","keydown","mousemove","touchstart","scroll"];
  var timerId = null;
  var memorySession = null;

  function now(){
    return Date.now();
  }

  function read(){
    try{
      return memorySession ? JSON.parse(JSON.stringify(memorySession)) : null;
    }catch(error){
      return null;
    }
  }

  function write(session){
    memorySession = JSON.parse(JSON.stringify(session || {}));
  }

  function isValid(session){
    return !!(session && session.ok && Number(session.lastActiveAt || 0) > 0 && (now() - Number(session.lastActiveAt)) < INACTIVITY_MS);
  }

  function touch(){
    var session = read();
    if(!isValid(session)) return false;
    session.lastActiveAt = now();
    write(session);
    return true;
  }

  function clear(){
    memorySession = null;
  }

  function login(username){
    write({
      ok: true,
      username: String(username || "admin").trim() || "admin",
      loginAt: now(),
      lastActiveAt: now()
    });
  }

  function logout(redirect){
    clear();
    if(redirect !== false){
      window.location.href = "admin-index.html";
    }
  }

  function enforceOrRedirect(){
    var session = read();
    if(!isValid(session)){
      clear();
      if(!/admin-index\.html$/i.test(window.location.pathname || "")){
        window.location.href = "admin-index.html";
      }
      return false;
    }
    touch();
    return true;
  }

  function scheduleAutoLogout(){
    if(timerId){
      clearTimeout(timerId);
      timerId = null;
    }
    var session = read();
    if(!isValid(session)) return;
    var remaining = INACTIVITY_MS - (now() - Number(session.lastActiveAt || 0));
    timerId = setTimeout(function(){
      logout(true);
    }, Math.max(500, remaining));
  }

  function bindActivity(){
    ACTIVITY_EVENTS.forEach(function(evt){
      document.addEventListener(evt, function(){
        if(touch()){
          scheduleAutoLogout();
        }
      }, { passive:true });
    });
    window.addEventListener("storage", function(event){
      if(event.key === SESSION_KEY){
        scheduleAutoLogout();
      }
    });
    window.addEventListener("focus", function(){
      if(!enforceOrRedirect()){
        return;
      }
      scheduleAutoLogout();
    });
  }

  window.SWADRA_ADMIN_AUTH = {
    login: login,
    logout: logout,
    enforceOrRedirect: enforceOrRedirect,
    scheduleAutoLogout: scheduleAutoLogout,
    bindActivity: bindActivity,
    readSession: read
  };
})();
