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
  var current = normalize(window.location.pathname);
  var nav = document.getElementById("adminGlobalNav");
  if(!nav) return;
  var links = nav.querySelectorAll("a[href]");
  links.forEach(function(link){
    link.setAttribute("href", fixAdminHref(link.getAttribute("href")));
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
})();
