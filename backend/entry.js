const http = require("http");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_BASE_URL = String(
  process.env.PUBLIC_BASE_URL ||
  process.env.RAILWAY_STATIC_URL ||
  process.env.RAILWAY_PUBLIC_DOMAIN ||
  ""
).trim().replace(/\/+$/, "");
const FRONTEND_ORIGIN = String(process.env.FRONTEND_ORIGIN || "").trim();

const ROOT_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Swadra Secure Backend</title>
    <style>
      body { font-family: Arial, sans-serif; background: #f8f5f2; color: #222; padding: 40px; }
      .box { max-width: 800px; margin: auto; background: #fff; padding: 24px; border-radius: 18px; box-shadow: 0 10px 28px rgba(0,0,0,0.08); }
      h1 { color: #7a3d3d; margin-top: 0; }
      code { background: #f1ece8; padding: 3px 6px; border-radius: 6px; }
      ul { line-height: 1.8; }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>Swadra Secure Backend Running</h1>
      <p>Railway is reserved for secure server-side tasks. Product catalog data stays in Firestore and product images stay in Cloudinary.</p>
      <ul>
        <li><code>GET /health</code></li>
        <li><code>GET|POST|PUT|DELETE /api/products</code> disabled</li>
      </ul>
    </div>
  </body>
</html>`;

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#7a3d3d"/><text x="16" y="21" text-anchor="middle" font-size="16" font-family="Arial" fill="#fff">S</text></svg>`;

let heavyHandler = null;

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function splitOrigins(value) {
  return String(value || "")
    .split(",")
    .map((entry) => normalizeOrigin(entry))
    .filter(Boolean);
}

function buildAllowedOrigins() {
  const allowed = new Set();
  splitOrigins(FRONTEND_ORIGIN).forEach((origin) => allowed.add(origin));
  [
    "https://swadraorganics.com",
    "https://www.swadraorganics.com",
    "https://swadra-organics-db127.web.app",
    "https://swadra-organics-db127.firebaseapp.com"
  ].forEach((origin) => allowed.add(origin));
  const publicOrigin = normalizeOrigin(
    PUBLIC_BASE_URL
      ? (PUBLIC_BASE_URL.startsWith("http") ? PUBLIC_BASE_URL : `https://${PUBLIC_BASE_URL}`)
      : ""
  );
  if (publicOrigin) {
    allowed.add(publicOrigin);
  }
  return allowed;
}

const ALLOWED_ORIGINS = buildAllowedOrigins();

function buildCorsHeaders(req, extraHeaders = {}) {
  const origin = normalizeOrigin(req.headers.origin || "");
  const allowOrigin = (
    !origin ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ||
    ALLOWED_ORIGINS.has(origin)
  ) ? (origin || "*") : "";

  return {
    "Access-Control-Allow-Origin": allowOrigin || "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    ...extraHeaders
  };
}

function getHeavyHandler() {
  if (!heavyHandler) {
    heavyHandler = require("./server.js").handleRequest;
  }
  return heavyHandler;
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, buildCorsHeaders(req));
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, buildCorsHeaders(req, { "Content-Type": "text/html; charset=utf-8" }));
    res.end(ROOT_HTML);
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, buildCorsHeaders(req, { "Content-Type": "application/json; charset=utf-8" }));
    res.end(JSON.stringify({
      ok: true,
      status: "online",
      mode: "bootstrap",
      time: new Date().toISOString()
    }));
    return;
  }

  if (req.method === "GET" && req.url === "/favicon.ico") {
    res.writeHead(200, buildCorsHeaders(req, { "Content-Type": "image/svg+xml; charset=utf-8" }));
    res.end(FAVICON_SVG);
    return;
  }

  try {
    getHeavyHandler()(req, res);
  } catch (error) {
    console.error("[bootstrap handler error]", error);
    res.writeHead(500, buildCorsHeaders(req, { "Content-Type": "application/json; charset=utf-8" }));
    res.end(JSON.stringify({ ok: false, error: "Bootstrap handler failed" }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Bootstrap server running on http://${HOST}:${PORT}`);
});

server.on("error", (error) => {
  console.error("[bootstrap server error]", error);
});
