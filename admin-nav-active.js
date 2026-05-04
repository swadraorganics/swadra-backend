(function(){
  function normalize(path){
    return String(path || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
  }
  function isBackendPage(){
    return /\/backend\//i.test(window.location.pathname || "");
  }
  function fixAdminHref(href){
    var raw = String(href || "").trim();
    if(!raw || raw.indexOf("#") === 0 || /^(https?:|mailto:|tel:|javascript:)/i.test(raw)) return raw;
    var hashIndex = raw.indexOf("#");
    var hash = hashIndex > -1 ? raw.slice(hashIndex) : "";
    var withoutHash = hashIndex > -1 ? raw.slice(0, hashIndex) : raw;
    var queryIndex = withoutHash.indexOf("?");
    var query = queryIndex > -1 ? withoutHash.slice(queryIndex) : "";
    var pathOnly = queryIndex > -1 ? withoutHash.slice(0, queryIndex) : withoutHash;
    var file = normalize(pathOnly);
    var backend = isBackendPage();
    if(backend){
      if(file === "ai.html") return "ai.html" + query + hash;
      if(file === "backend.html") return "backend.html" + query + hash;
      if(file === "saved-products.html") return "saved-products.html" + query + hash;
      if(/^admin-/i.test(file) || file === "index.html" || file === "trackorder.html"){
        return "../" + file + query + hash;
      }
    }else{
      if(file === "ai.html") return "backend/ai.html" + query + hash;
      if(file === "backend.html") return "backend/backend.html" + query + hash;
      if(file === "saved-products.html") return "backend/saved-products.html" + query + hash;
    }
    return raw;
  }
  function findLinkByFile(container, file){
    return Array.from(container.querySelectorAll("a[href]")).find(function(item){
      return normalize(item.getAttribute("href")) === file;
    });
  }
  function getBackendBase(){
    return String(window.SWADRA_API_BASE || "https://swadra-backend-production.up.railway.app").replace(/\/+$/, "");
  }
  async function logoutAdmin(){
    try{
      await fetch(getBackendBase() + "/api/admin/logout", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
    }catch(error){}
    if(window.SWADRA_CLEAR_ADMIN_TOKEN){
      window.SWADRA_CLEAR_ADMIN_TOKEN();
    }
    window.location.href = fixAdminHref("admin-index.html");
  }
  function setLiveBadgeState(badge, label, online, checking){
    if(!badge) return;
    var isOnline = !!online && !checking;
    badge.textContent = label;
    badge.title = (label === "B" ? "Backend" : "Firestore") + (checking ? " checking..." : (isOnline ? " live. Click to refresh status." : " offline. Click to retry."));
    badge.setAttribute("aria-label", badge.title);
    badge.style.display = "inline-flex";
    badge.style.alignItems = "center";
    badge.style.justifyContent = "center";
    badge.style.width = "28px";
    badge.style.height = "28px";
    badge.style.padding = "0";
    badge.style.borderRadius = "999px";
    badge.style.border = "1px solid rgba(255,255,255,.28)";
    badge.style.color = "#fff";
    badge.style.background = checking ? "#9a6700" : (isOnline ? "#15803d" : "#b42318");
    badge.style.fontSize = "13px";
    badge.style.fontWeight = "900";
    badge.style.lineHeight = "1";
    badge.style.cursor = "pointer";
    badge.style.userSelect = "none";
    badge.style.boxShadow = "inset 0 0 0 1px rgba(255,255,255,.08)";
  }
  function setupLiveBadges(){
    var backendBadge = document.getElementById("backendLiveBadge");
    var firestoreBadge = document.getElementById("firestoreLiveBadge");
    if(!backendBadge && !firestoreBadge) return;

    if(backendBadge){
      backendBadge.setAttribute("role", "button");
      backendBadge.setAttribute("tabindex", "0");
      setLiveBadgeState(backendBadge, "B", false, true);
    }
    if(firestoreBadge){
      firestoreBadge.setAttribute("role", "button");
      firestoreBadge.setAttribute("tabindex", "0");
      setLiveBadgeState(firestoreBadge, "F", false, true);
    }

    async function checkBackend(){
      if(!backendBadge) return;
      setLiveBadgeState(backendBadge, "B", false, true);
      try{
        var base = String(window.SWADRA_API_BASE || "https://swadra-backend-production.up.railway.app").replace(/\/+$/, "");
        var response = await fetch(base + "/health", { cache: "no-store" });
        var data = await response.json().catch(function(){ return {}; });
        setLiveBadgeState(backendBadge, "B", response.ok && data && data.ok !== false, false);
      }catch(error){
        setLiveBadgeState(backendBadge, "B", false, false);
      }
    }

    async function checkFirestore(){
      if(!firestoreBadge) return;
      setLiveBadgeState(firestoreBadge, "F", false, true);
      try{
        if(window.SWADRA_PRODUCT_DATA && typeof window.SWADRA_PRODUCT_DATA.fetchProducts === "function"){
          await window.SWADRA_PRODUCT_DATA.fetchProducts();
          setLiveBadgeState(firestoreBadge, "F", true, false);
          return;
        }
        if(!window.firebase || typeof window.firebase.firestore !== "function"){
          throw new Error("Firestore SDK unavailable");
        }
        if(!window.firebase.apps || !window.firebase.apps.length){
          throw new Error("Firebase app unavailable");
        }
        await window.firebase.firestore().collection("products").limit(1).get();
        setLiveBadgeState(firestoreBadge, "F", true, false);
      }catch(error){
        setLiveBadgeState(firestoreBadge, "F", false, false);
      }
    }

    function refreshAll(){
      checkBackend();
      checkFirestore();
    }

    [backendBadge, firestoreBadge].forEach(function(badge){
      if(!badge) return;
      badge.addEventListener("click", refreshAll);
      badge.addEventListener("keydown", function(event){
        if(event.key === "Enter" || event.key === " "){
          event.preventDefault();
          refreshAll();
        }
      });
    });
    refreshAll();
  }
  var current = normalize(window.location.pathname);
  var nav = document.getElementById("adminGlobalNav");
  if(!nav) return;
  var links = nav.querySelectorAll("a[href]");
  links.forEach(function(link){
    link.setAttribute("href", fixAdminHref(link.getAttribute("href")));
    if(normalize(link.getAttribute("href")) === "index.html" && String(link.textContent || "").trim().toLowerCase() === "logout"){
      link.setAttribute("href", "#");
      link.addEventListener("click", function(event){
        event.preventDefault();
        logoutAdmin();
      });
    }
    var hrefFile = normalize(link.getAttribute("href"));
    if(hrefFile && hrefFile === current){
      link.style.background = "rgba(255,255,255,.20)";
      link.style.fontWeight = "800";
      link.style.boxShadow = "inset 0 0 0 1px rgba(255,255,255,.22)";
    }
  });
  if(!findLinkByFile(nav, "admin-recovery.html")){
    var recovery = document.createElement("a");
    recovery.href = fixAdminHref("admin-recovery.html");
    recovery.textContent = "Recovery";
    recovery.style.color = "#fff";
    recovery.style.textDecoration = "none";
    recovery.style.fontWeight = "700";
    recovery.style.padding = "8px 12px";
    recovery.style.borderRadius = "10px";
    var callbackLink = findLinkByFile(nav, "admin-callbacks.html");
    if(callbackLink){
      nav.insertBefore(recovery, callbackLink);
    }else{
      nav.appendChild(recovery);
    }
  }
  var profileMenu = nav.querySelector("details div");
  if(profileMenu && !findLinkByFile(profileMenu, "admin-order-sheet.html")){
    var link = document.createElement("a");
    link.href = fixAdminHref("admin-order-sheet.html");
    link.textContent = "Order Sheet";
    link.style.display = "block";
    link.style.padding = "10px 12px";
    link.style.color = "#2a2a2a";
    link.style.textDecoration = "none";
    link.style.fontWeight = "700";
    link.style.borderRadius = "10px";
    var shiprocketLink = findLinkByFile(profileMenu, "admin-shiprocket.html");
    if(shiprocketLink){
      profileMenu.insertBefore(link, shiprocketLink);
    }else{
      profileMenu.appendChild(link);
    }
  }
  document.addEventListener("click", function(event){
    var clickedDetails = event.target && event.target.closest ? event.target.closest("#adminGlobalNav details") : null;
    nav.querySelectorAll("details[open]").forEach(function(details){
      if(details !== clickedDetails) details.removeAttribute("open");
    });
  });
  document.addEventListener("keydown", function(event){
    if(event.key === "Escape"){
      nav.querySelectorAll("details[open]").forEach(function(details){
        details.removeAttribute("open");
      });
      var adminProfileMenu = document.getElementById("adminProfileMenu");
      if(adminProfileMenu) adminProfileMenu.style.display = "none";
    }
  });
  setupLiveBadges();
})();
