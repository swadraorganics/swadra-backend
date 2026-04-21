const http = require("http");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const ROOT_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Swadra Backend</title>
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
      <h1>Swadra AI Pricing Backend Running</h1>
      <p>Available endpoints:</p>
      <ul>
        <li><code>GET /health</code></li>
        <li><code>GET /api/products</code></li>
        <li><code>POST /api/products</code></li>
        <li><code>PUT /api/products/:id</code></li>
        <li><code>DELETE /api/products/:id</code></li>
      </ul>
    </div>
  </body>
</html>`;

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#7a3d3d"/><text x="16" y="21" text-anchor="middle" font-size="16" font-family="Arial" fill="#fff">S</text></svg>`;

let heavyHandler = null;

function getHeavyHandler() {
  if (!heavyHandler) {
    heavyHandler = require("./server.js").handleRequest;
  }
  return heavyHandler;
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ROOT_HTML);
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      status: "online",
      mode: "bootstrap",
      time: new Date().toISOString()
    }));
    return;
  }

  if (req.method === "GET" && req.url === "/favicon.ico") {
    res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
    res.end(FAVICON_SVG);
    return;
  }

  try {
    getHeavyHandler()(req, res);
  } catch (error) {
    console.error("[bootstrap handler error]", error);
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "Bootstrap handler failed" }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Bootstrap server running on http://${HOST}:${PORT}`);
});

server.on("error", (error) => {
  console.error("[bootstrap server error]", error);
});
