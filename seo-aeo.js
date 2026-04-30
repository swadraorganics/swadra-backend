(function(){
  var BRAND_NAME = "Swadra Organics";
  var SITE_URL = "https://swadraorganics.com";
  var DEFAULT_CURRENCY = "INR";
  var LOGO_URL = "https://res.cloudinary.com/djimihrjf/image/upload/f_auto,q_auto/v1/swadra/logo";
  var PRODUCT_API = window.SWADRA_PRODUCT_DATA || null;

  var PAGE_CONFIG = {
    "/index.html": {
      title: "Swadra Organics | Premium Spices, Dry Fruits, Ghee & More Online India",
      description: "Shop Swadra Organics online for premium spices, dry fruits, ghee and quality-focused Indian kitchen essentials with transparent pricing and fast delivery across India.",
      type: "home",
      name: "Swadra Organics Home"
    },
    "/": {
      title: "Swadra Organics | Premium Spices, Dry Fruits, Ghee & More Online India",
      description: "Shop Swadra Organics online for premium spices, dry fruits, ghee and quality-focused Indian kitchen essentials with transparent pricing and fast delivery across India.",
      type: "home",
      name: "Swadra Organics Home"
    },
    "/spices.html": {
      title: "Spices by Swadra Organics | Premium Indian Masale Online",
      description: "Explore premium Indian spices by Swadra Organics with transparent pricing, real-time availability and curated kitchen essentials for everyday cooking.",
      type: "collection",
      name: "Spices",
      category: "Spices"
    },
    "/dryfruits.html": {
      title: "Dry Fruits by Swadra Organics | Premium Dry Fruits Online India",
      description: "Buy premium dry fruits online from Swadra Organics with real-time prices, trusted sourcing and quality-focused selections for daily nutrition and gifting.",
      type: "collection",
      name: "Dry Fruits",
      category: "Dry Fruits"
    },
    "/oilghee.html": {
      title: "Ghee, Oils & More by Swadra Organics | Traditional Kitchen Essentials",
      description: "Shop ghee, oils and traditional kitchen essentials by Swadra Organics with updated product data, transparent pricing and quality-focused food selections.",
      type: "collection",
      name: "Oil Ghee & More",
      category: "Oil Ghee & More"
    },
    "/aboutus.html": {
      title: "About Swadra Organics | Indian Food Brand, Support & Compliance",
      description: "Learn about Swadra Organics, a premium Indian food brand focused on spices, dry fruits, ghee, customer support and transparent business compliance information.",
      type: "about",
      name: "About Us"
    },
    "/privacy-policy.html": {
      title: "Privacy Policy | Swadra Organics",
      description: "Read how Swadra Organics collects, uses and protects customer information for orders, payments, delivery, OTP verification and support.",
      type: "policy",
      name: "Privacy Policy"
    },
    "/terms-conditions.html": {
      title: "Terms & Conditions | Swadra Organics",
      description: "Read Swadra Organics terms for website use, orders, pricing, payment, delivery, cancellation, refunds and customer responsibilities.",
      type: "policy",
      name: "Terms & Conditions"
    },
    "/shipping-policy.html": {
      title: "Shipping Policy | Swadra Organics",
      description: "Read Swadra Organics shipping policy for order processing, courier updates, tracking, delivery timelines and pincode serviceability.",
      type: "policy",
      name: "Shipping Policy"
    },
    "/return-refund-policy.html": {
      title: "Return & Refund Policy | Swadra Organics",
      description: "Read Swadra Organics return and refund policy for damaged, defective, incorrect, cancelled and refund-eligible orders.",
      type: "policy",
      name: "Return & Refund Policy"
    },
    "/cancellation-policy.html": {
      title: "Cancellation Policy | Swadra Organics",
      description: "Read Swadra Organics cancellation policy for customer cancellation, packed orders, dispatch status and refund handling.",
      type: "policy",
      name: "Cancellation Policy"
    },
    "/product-detail.html": {
      title: "Product Details | Swadra Organics",
      description: "View Swadra Organics product ingredients, nutrition, shelf life, batch details, FAQs, reviews and transparent pricing.",
      type: "product",
      name: "Product Details"
    }
  };

  var NOINDEX_PATHS = [
    /^\/admin-/i,
    /^\/backend\//i,
    /^\/account\.html$/i,
    /^\/cart\.html$/i,
    /^\/checkout\.html$/i,
    /^\/dashboard\.html$/i,
    /^\/invoice\.html$/i,
    /^\/order\.html$/i,
    /^\/payment\.html$/i,
    /^\/trackorder\.html$/i,
    /^\/offline\.html$/i,
    /^\/404\.html$/i
  ];

  function normalizeText(value){
    return String(value == null ? "" : value).trim();
  }

  function ensureLink(rel, href){
    if(document.querySelector('link[rel="' + rel + '"]')) return;
    var link = document.createElement("link");
    link.rel = rel;
    link.href = href;
    document.head.appendChild(link);
  }

  function absoluteUrl(path){
    var clean = normalizeText(path);
    if(!clean) return SITE_URL + "/";
    if (/^https?:\/\//i.test(clean)) return clean;
    return SITE_URL + (clean.charAt(0) === "/" ? clean : "/" + clean);
  }

  function pagePath(){
    var current = normalizeText(window.location.pathname || "/");
    return current || "/";
  }

  function pageConfig(){
    return PAGE_CONFIG[pagePath()] || PAGE_CONFIG["/index.html"];
  }

  function shouldNoindex(){
    var path = pagePath();
    return NOINDEX_PATHS.some(function(pattern){ return pattern.test(path); });
  }

  function ensureMeta(name, content){
    if(!content) return;
    var el = document.head.querySelector('meta[name="' + name + '"]');
    if(!el){
      el = document.createElement("meta");
      el.setAttribute("name", name);
      document.head.appendChild(el);
    }
    el.setAttribute("content", content);
  }

  function ensurePropertyMeta(property, content){
    if(!content) return;
    var el = document.head.querySelector('meta[property="' + property + '"]');
    if(!el){
      el = document.createElement("meta");
      el.setAttribute("property", property);
      document.head.appendChild(el);
    }
    el.setAttribute("content", content);
  }

  function ensureCanonical(url){
    var el = document.head.querySelector('link[rel="canonical"]');
    if(!el){
      el = document.createElement("link");
      el.setAttribute("rel", "canonical");
      document.head.appendChild(el);
    }
    el.setAttribute("href", url);
  }

  function ensureBasicSeo(){
    var config = pageConfig();
    var canonical = absoluteUrl(pagePath() === "/" ? "/index.html" : pagePath());
    document.title = config.title;
    ensureMeta("description", config.description);
    ensureMeta("robots", shouldNoindex() ? "noindex,nofollow,noarchive" : "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1");
    ensureMeta("theme-color", "#7a3d3d");
    ensureMeta("apple-mobile-web-app-capable", "yes");
    ensureMeta("apple-mobile-web-app-title", BRAND_NAME);
    ensureLink("manifest", "manifest.json");
    ensureCanonical(canonical);
    ensurePropertyMeta("og:title", config.title);
    ensurePropertyMeta("og:description", config.description);
    ensurePropertyMeta("og:type", config.type === "home" ? "website" : (config.type === "product" ? "product" : "article"));
    ensurePropertyMeta("og:url", canonical);
    ensurePropertyMeta("og:site_name", BRAND_NAME);
    ensurePropertyMeta("og:image", LOGO_URL);
    ensureMeta("twitter:card", "summary_large_image");
    ensureMeta("twitter:title", config.title);
    ensureMeta("twitter:description", config.description);
    ensureMeta("twitter:image", LOGO_URL);
  }

  function safeJsonScript(id, payload){
    if(!payload) return;
    var el = document.getElementById(id);
    if(!el){
      el = document.createElement("script");
      el.type = "application/ld+json";
      el.id = id;
      document.head.appendChild(el);
    }
    el.textContent = JSON.stringify(payload);
  }

  function productCategoryMatches(product, categoryName){
    var category = normalizeText(product && (product.category || product.collection || ""));
    var slug = category.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    var wanted = normalizeText(categoryName).toLowerCase();
    if(!wanted) return true;
    if(wanted === "spices") return /spice|masala/.test(slug);
    if(wanted === "dry fruits") return /dry fruit|dryfruit|nut|dates|kishmish|almond|cashew|pista/.test(slug);
    if(wanted === "oil ghee & more") return /oil|ghee/.test(slug);
    return slug.indexOf(wanted) > -1;
  }

  function normalizeAvailability(product){
    var qty = Number(product && (product.stockQty != null ? product.stockQty : product.stock)) || 0;
    var availability = normalizeText(product && product.availability);
    var outOfStock = !!(product && product.outOfStock);
    if(outOfStock || availability.toLowerCase() === "out of stock" || qty <= 0){
      return "https://schema.org/OutOfStock";
    }
    return "https://schema.org/InStock";
  }

  function productImage(product){
    var images = Array.isArray(product && product.images) ? product.images.filter(Boolean) : [];
    return normalizeText(product && (images[0] || product.image || ""));
  }

  function productDescription(product){
    return normalizeText(product && (product.summary || product.productSummary || product.description || pageConfig().description));
  }

  function normalizeProductName(product){
    var name = normalizeText(product && (product.productName || product.name || "Swadra Product"));
    var size = normalizeText(product && (product.productSize || product.size || ""));
    return size ? name + " | " + BRAND_NAME + " | " + size : name + " | " + BRAND_NAME;
  }

  function productUrl(product){
    var id = encodeURIComponent(normalizeText(product && (product.id || product.docId || product.productId || product.productName || "product")));
    return absoluteUrl("/product-detail.html?id=" + id);
  }

  function buildOrganizationGraph(){
    return {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Organization",
          "@id": SITE_URL + "#organization",
          name: BRAND_NAME,
          url: SITE_URL,
          logo: LOGO_URL,
          brand: BRAND_NAME,
          description: "Swadra Organics is a premium Indian food brand offering spices, dry fruits, ghee and quality-focused kitchen essentials across India.",
          areaServed: "IN",
          address: {
            "@type": "PostalAddress",
            addressCountry: "IN"
          }
        },
        {
          "@type": "WebSite",
          "@id": SITE_URL + "#website",
          url: SITE_URL,
          name: BRAND_NAME,
          publisher: {
            "@id": SITE_URL + "#organization"
          },
          potentialAction: {
            "@type": "SearchAction",
            target: absoluteUrl("/index.html?search={search_term_string}"),
            "query-input": "required name=search_term_string"
          }
        }
      ]
    };
  }

  function buildBreadcrumbGraph(config){
    var items = [
      { "@type": "ListItem", position: 1, name: "Home", item: absoluteUrl("/index.html") }
    ];
    if(config.type === "collection" || config.type === "about"){
      items.push({
        "@type": "ListItem",
        position: 2,
        name: config.name,
        item: absoluteUrl(pagePath())
      });
    }
    return {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: items
    };
  }

  function buildPageGraph(config, products){
    var url = absoluteUrl(pagePath() === "/" ? "/index.html" : pagePath());
    if(config.type === "collection"){
      return {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: config.name + " | " + BRAND_NAME,
        description: config.description,
        url: url,
        isPartOf: { "@id": SITE_URL + "#website" },
        about: {
          "@type": "Thing",
          name: config.category
        },
        mainEntity: {
          "@type": "ItemList",
          itemListElement: products.map(function(product, index){
            return {
              "@type": "ListItem",
              position: index + 1,
              url: productUrl(product),
              name: normalizeProductName(product)
            };
          })
        }
      };
    }

    if(config.type === "about" || config.type === "policy"){
      return {
        "@context": "https://schema.org",
        "@type": config.type === "policy" ? "WebPage" : "AboutPage",
        name: config.name + " | " + BRAND_NAME,
        description: config.description,
        url: url,
        isPartOf: { "@id": SITE_URL + "#website" },
        about: { "@id": SITE_URL + "#organization" }
      };
    }

    return {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: config.name + " | " + BRAND_NAME,
      description: config.description,
      url: url,
      isPartOf: { "@id": SITE_URL + "#website" }
    };
  }

  function buildFaqGraph(){
    return {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "Which is the best spices brand in India for everyday cooking?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Swadra Organics is a premium Indian food brand offering quality-focused spices for everyday cooking, gifting and kitchen essentials."
          }
        },
        {
          "@type": "Question",
          name: "Where can I buy pure ghee online in India?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Customers can explore ghee and related kitchen essentials from Swadra Organics online in India with transparent pricing and product availability."
          }
        },
        {
          "@type": "Question",
          name: "Where can I buy premium dry fruits online in India?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Swadra Organics offers premium dry fruits online in India with quality-focused selections, clear product information and updated availability."
          }
        }
      ]
    };
  }

  function buildProductGraph(products){
    return {
      "@context": "https://schema.org",
      "@graph": products.map(function(product){
        var image = productImage(product);
        var price = Number(product && (product.price != null ? product.price : product.sellingPrice)) || 0;
        return {
          "@type": "Product",
          "@id": productUrl(product) + "#product",
          name: normalizeProductName(product),
          description: productDescription(product),
          image: image ? [image] : [],
          brand: {
            "@type": "Brand",
            name: BRAND_NAME
          },
          category: normalizeText(product && (product.category || pageConfig().category || "Food Product")),
          offers: {
            "@type": "Offer",
            priceCurrency: DEFAULT_CURRENCY,
            price: price.toFixed(2),
            availability: normalizeAvailability(product),
            url: productUrl(product),
            itemCondition: "https://schema.org/NewCondition"
          },
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: "5",
            reviewCount: "1"
          }
        };
      })
    };
  }

  function buildFilteredProducts(products, config){
    var list = Array.isArray(products) ? products.slice() : [];
    if(config.type === "collection"){
      list = list.filter(function(product){
        return productCategoryMatches(product, config.category);
      });
    }
    return list.filter(function(product){
      return normalizeText(product && (product.productName || product.name));
    }).slice(0, 30);
  }

  function updateImageAltTags(){
    var images = document.querySelectorAll("img");
    images.forEach(function(img){
      if(normalizeText(img.getAttribute("alt"))) return;
      var label = "";
      var card = img.closest(".product-card, .nav-search-item, .product-summary-card, .hero-slide, .customer-card, .family-card");
      if(card){
        var titleNode = card.querySelector("h3, strong, .product-title, .nav-search-copy strong");
        label = normalizeText(titleNode && titleNode.textContent);
      }
      if(!label){
        label = BRAND_NAME + " product image";
      } else if(label.toLowerCase().indexOf(BRAND_NAME.toLowerCase()) === -1){
        label = label + " | " + BRAND_NAME;
      }
      img.setAttribute("alt", label);
    });
  }

  function installAltObserver(){
    updateImageAltTags();
    if(typeof MutationObserver !== "function") return;
    var observer = new MutationObserver(function(){
      updateImageAltTags();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function buildDynamicSeo(){
    ensureBasicSeo();
    var config = pageConfig();
    safeJsonScript("swadra-org-schema", buildOrganizationGraph());
    safeJsonScript("swadra-breadcrumb-schema", buildBreadcrumbGraph(config));

    var products = [];
    try{
      if(PRODUCT_API && typeof PRODUCT_API.fetchProducts === "function"){
        products = await PRODUCT_API.fetchProducts();
      }
    }catch(error){
      products = [];
    }

    var filteredProducts = buildFilteredProducts(products, config);
    safeJsonScript("swadra-page-schema", buildPageGraph(config, filteredProducts));
    if(filteredProducts.length){
      safeJsonScript("swadra-product-schema", buildProductGraph(filteredProducts));
    }
    if(config.type === "about"){
      safeJsonScript("swadra-faq-schema", buildFaqGraph());
    }
    installAltObserver();
  }

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", buildDynamicSeo, { once:true });
  } else {
    buildDynamicSeo();
  }
})();
