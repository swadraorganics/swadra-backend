(function(){
  if(!("serviceWorker" in navigator)) return;
  if(!/^https?:$/.test(location.protocol)) return;

  window.addEventListener("load", function(){
    navigator.serviceWorker.register("/sw.js").catch(function(error){
      console.warn("Swadra service worker registration failed", error);
    });
  });
})();
