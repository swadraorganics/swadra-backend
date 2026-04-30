
const dataApi = window.SWADRA_DATA || null;

function safeJsonParse(value, fallback){
  try{
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  }catch(error){
    return fallback;
  }
}

function getUsersMap(){
  const authApi = window.SWADRA_AUTH || null;
  if(authApi && typeof authApi.getUsers === "function"){
    return authApi.getUsers() || {};
  }
  return {};
}

function normalizeText(value){
  return String(value || "").trim().toLowerCase();
}

function getValueByPossibleKeys(source, keys){
  for(const key of keys){
    const value = source && source[key];
    if(value !== undefined && value !== null && String(value).trim()){
      return value;
    }
  }
  return "";
}

function buildShippingAddress(raw){
  const shipping = raw && typeof raw.shipping === "object" ? raw.shipping : {};
  const address = getValueByPossibleKeys(raw, ["shippingAddress","address","fullAddress"]);
  if(address) return String(address).trim();
  return [
    shipping.house,
    shipping.area,
    shipping.nearby,
    shipping.city,
    shipping.pincode,
    shipping.postOffice,
    shipping.district,
    shipping.state
  ].map(item=>String(item || "").trim()).filter(Boolean).join(", ");
}

function normalizeOrderStatus(raw){
  const value = normalizeText(raw);
  if(!value) return "pending";
  if(value.includes("deliver")) return "delivered";
  if(value.includes("cancel")) return "cancelled";
  if(value.includes("pack")) return "packed";
  if(value.includes("dispatch")) return "shipped";
  if(value.includes("out for delivery") || value.includes("out_for_delivery")) return "shipped";
  if(value.includes("ship")) return "shipped";
  if(value.includes("confirm")) return "confirmed";
  return "pending";
}

function extractAmount(raw){
  const possible = [
    raw.amount, raw.totalAmount, raw.grandTotal, raw.total, raw.finalAmount, raw.payableAmount
  ];
  for(const value of possible){
    const numeric = Number(value);
    if(Number.isFinite(numeric) && numeric > 0){
      return numeric;
    }
  }
  return 0;
}

function normalizeOrder(raw, sourceKey, index){
  const id = String(getValueByPossibleKeys(raw, ["id","orderId","orderID","razorpayOrderId"]) || `${sourceKey}-${index + 1}`).trim();
  const status = normalizeOrderStatus(getValueByPossibleKeys(raw, ["orderStatus","status","deliveryStatus"]));
  const shipping = raw && typeof raw.shipping === "object" ? raw.shipping : {};
  const shiprocket = raw && typeof raw.shiprocket === "object" ? raw.shiprocket : {};
  const userIdValue = String(getValueByPossibleKeys(raw, ["userId","uid","customerId"])).trim();
  const customerName = String(
    getValueByPossibleKeys(raw, ["shippingName","customerName","name","fullName","username"]) ||
    getValueByPossibleKeys(shipping, ["name","fullName"])
  ).trim() || "Unknown Customer";
  const email = String(
    getValueByPossibleKeys(raw, ["email","emailId","mail","customerEmail","userEmail"]) ||
    getValueByPossibleKeys(shipping, ["email","emailId","mail"]) ||
    (userIdValue.includes("@") ? userIdValue : "")
  ).trim();
  const mobile = String(
    getValueByPossibleKeys(raw, ["shippingPhone","mobile","phone","phoneNumber","mobileNumber","contactNumber","customerPhone","customerMobile"]) ||
    getValueByPossibleKeys(shipping, ["phone","mobile","phoneNumber","mobileNumber","contactNumber"])
  ).trim();
  const awb = String(
    getValueByPossibleKeys(raw, ["awb","trackingId","awbCode","awb_code"]) ||
    getValueByPossibleKeys(shiprocket, ["awb","trackingId","awbCode","awb_code"])
  ).trim();
  const shipmentId = String(
    getValueByPossibleKeys(raw, ["shipment_id","shipmentId","shiprocketShipmentId"]) ||
    getValueByPossibleKeys(shiprocket, ["shipment_id","shipmentId","shiprocketShipmentId"])
  ).trim();
  const courierName = String(
    getValueByPossibleKeys(raw, ["courierName","courier","courier_company_name","courier_name"]) ||
    getValueByPossibleKeys(shiprocket, ["courierName","courier","courier_company_name","courier_name"])
  ).trim();
  const shiprocketStatus = String(
    getValueByPossibleKeys(raw, ["trackingStatus","shipmentStatus","shiprocketStatus"]) ||
    getValueByPossibleKeys(shiprocket, ["status","trackingStatus","shipmentStatus","shiprocketStatus"])
  ).trim();
  const labelUrl = String(
    getValueByPossibleKeys(raw, ["shiprocketLabelUrl","labelUrl","label_url","label"]) ||
    getValueByPossibleKeys(shiprocket, ["shiprocketLabelUrl","labelUrl","label_url","label"])
  ).trim();
  const trackingUrl = String(
    getValueByPossibleKeys(raw, ["trackingUrl","tracking_url"]) ||
    getValueByPossibleKeys(shiprocket, ["trackingUrl","tracking_url"])
  ).trim();
  const expectedDelivery = String(
    getValueByPossibleKeys(raw, ["expectedDelivery","estimatedDelivery","edd","estimatedDeliveryDate"]) ||
    getValueByPossibleKeys(shiprocket, ["expectedDelivery","estimatedDelivery","edd","estimatedDeliveryDate"])
  ).trim();
  const trackingUpdatedAt = String(getValueByPossibleKeys(raw, ["trackingUpdatedAt","updatedAt","date","createdAt"])).trim();
  const shippingAddress = buildShippingAddress(raw);
  return {
    id,
    status,
    customerName,
    email,
    mobile,
    amount: extractAmount(raw),
    awb,
    shipmentId,
    courierName,
    shiprocketStatus,
    labelUrl,
    trackingUrl,
    expectedDelivery,
    trackingUpdatedAt,
    shippingAddress,
    searchText: normalizeText([id, customerName, email, mobile, awb, shipmentId, courierName, shiprocketStatus, shippingAddress].join(" "))
  };
}

function mergeOrders(lists){
  const map = new Map();
  lists.flat().forEach(function(order){
    if(!order || typeof order !== "object") return;
    const key = String(order.id || "").trim() || [order.awb, order.shipmentId, order.email, order.amount].join("|");
    map.set(key, { ...(map.get(key) || {}), ...order });
  });
  return Array.from(map.values());
}

async function getAllOrders(){
  const lists = [];
  if(dataApi && typeof dataApi.fetchOrders === "function"){
    try{
      const orders = await dataApi.fetchOrders();
      lists.push((Array.isArray(orders) ? orders : []).map((item, index)=>normalizeOrder(item, "firestoreOrders", index)));
    }catch(error){
      const errorCode = String(error && error.code || "").trim().toLowerCase();
      if(errorCode !== "permission-denied" && errorCode !== "unauthenticated"){
        console.error("shiprocket firestore orders fetch failed", error);
      }
    }
  }

  if(window.SWADRA_API_BASE){
    try{
      const response = await fetch(String(window.SWADRA_API_BASE || "") + "/api/orders");
      const data = await response.json().catch(function(){ return {}; });
      const orders = Array.isArray(data) ? data : (Array.isArray(data.orders) ? data.orders : []);
      lists.push(orders.map((item, index)=>normalizeOrder(item, "backendOrders", index)));
    }catch(error){
      console.error("shiprocket backend orders fetch failed", error);
    }
  }

  const userOrders = [];
  const users = getUsersMap();
  Object.entries(users).forEach(([email, user])=>{
    const list = Array.isArray(user && user.orders) ? user.orders : [];
    list.forEach((item, index)=>{
      const normalized = normalizeOrder(Object.assign({ email }, item), "users", index);
      userOrders.push(normalized);
    });
  });
  lists.push(userOrders);

  return mergeOrders(lists);
}

async function getShiprocketOrders(){
  const orders = await getAllOrders();
  return orders.filter(order=>order.awb || order.shipmentId || order.courierName || order.shiprocketStatus);
}

function rupee(value){
  return `₹${Math.round(Number(value || 0))}`;
}

function escapeHtml(value){
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function openPrintLabel(order){
  const liveLabel = String(order && order.labelUrl || "").trim();
  if(liveLabel){
    window.location.href = liveLabel;
    return;
  }
  const labelWindow = window;
  const qrText = encodeURIComponent([order.id, order.shipmentId || "-", order.awb || "-", order.customerName, order.mobile, order.shippingAddress].join(" | "));
  const qrUrl = `https://chart.googleapis.com/chart?cht=qr&chs=180x180&chl=${qrText}`;
  labelWindow.document.write(`<!DOCTYPE html><html><head><title>Print Label</title><style>
    body{font-family:Arial,sans-serif;padding:24px;color:#1f1f1f}
    .box{border:2px solid #7a3d3d;border-radius:18px;padding:22px}
    .grid{display:grid;grid-template-columns:1.2fr .8fr;gap:20px;align-items:start}
    .brand{font-size:28px;font-weight:800;color:#7a3d3d}
    .muted{color:#6c6c6c}
    .section{margin-top:18px;padding:16px;border:1px solid #e7dfd7;border-radius:14px}
    .label{font-size:12px;font-weight:800;color:#8a7468;text-transform:uppercase;letter-spacing:.08em}
    .value{margin-top:6px;font-size:18px;font-weight:700}
    img{max-width:180px}
  </style></head><body onload="window.print()"><div class="box"><div class="grid"><div><div class="brand">Swadra Organics</div><div class="muted">Shiprocket shipment label</div><div class="section"><div class="label">Ship To</div><div class="value">${escapeHtml(order.customerName)}</div><div>${escapeHtml(order.mobile || "-")}</div><div>${escapeHtml(order.shippingAddress || "Address not available")}</div></div><div class="section"><div class="label">Shipment</div><div class="value">Shipment ID: ${escapeHtml(order.shipmentId || "-")}</div><div>AWB: ${escapeHtml(order.awb || "-")}</div><div>Courier: ${escapeHtml(order.courierName || "Shiprocket")}</div><div>Order: ${escapeHtml(order.id)}</div></div></div><div><img src="${qrUrl}" alt="QR"><div class="section"><div class="label">Ship From</div><div class="value">Swadra Organics</div><div>Dispatch Team</div></div></div></div></div></body></html>`);
  labelWindow.document.close();
}

function renderStats(orders){
  const shipped = orders.filter(item=>item.status === "shipped" || item.status === "packed").length;
  const delivered = orders.filter(item=>item.status === "delivered").length;
  const pending = orders.filter(item=>item.status === "pending" || item.status === "confirmed").length;
  const totalAmount = orders.reduce((sum, item)=>sum + Number(item.amount || 0), 0);
  document.getElementById("statsGrid").innerHTML = `
    <div class="stat-card"><div class="label">Shiprocket Orders</div><div class="value">${orders.length}</div></div>
    <div class="stat-card"><div class="label">In Transit</div><div class="value">${shipped}</div></div>
    <div class="stat-card"><div class="label">Delivered</div><div class="value">${delivered}</div></div>
    <div class="stat-card"><div class="label">Shipment Value</div><div class="value">${rupee(totalAmount)}</div></div>
  `;
}

async function renderShiprocketOrders(){
  const query = normalizeText(document.getElementById("searchInput").value);
  const statusFilter = normalizeText(document.getElementById("statusFilter").value);
  const all = await getShiprocketOrders();
  const filtered = all.filter(order=>{
    const queryMatch = !query || order.searchText.includes(query);
    const statusMatch = !statusFilter || order.status === statusFilter;
    return queryMatch && statusMatch;
  });
  renderStats(filtered);
  const list = document.getElementById("shipList");
  if(!filtered.length){
    list.innerHTML = `<div class="empty">No Shiprocket synced orders found yet. AWB / shipment ID aate hi yahan show ho jayenge.</div>`;
    return;
  }
  list.innerHTML = filtered.map(order=>{
    const badgeClass = ["delivered","cancelled","shipped"].includes(order.status) ? order.status : "pending";
    return `
      <div class="ship-card">
        <div class="head-row">
          <div>
            <div class="title">${escapeHtml(order.customerName)}</div>
            <div class="muted">Order ID: ${escapeHtml(order.id)}${order.email ? ` â€¢ ${escapeHtml(order.email)}` : ""}</div>
          </div>
          <span class="badge ${badgeClass}">${escapeHtml(order.status)}</span>
        </div>
        <div class="meta-grid">
          <div class="meta-box"><div class="k">Shipment ID</div><div class="v">${escapeHtml(order.shipmentId || "-")}</div></div>
          <div class="meta-box"><div class="k">AWB</div><div class="v">${escapeHtml(order.awb || "-")}</div></div>
          <div class="meta-box"><div class="k">Courier</div><div class="v">${escapeHtml(order.courierName || "Shiprocket")}</div></div>
          <div class="meta-box"><div class="k">Amount</div><div class="v">${rupee(order.amount)}</div></div>
          <div class="meta-box"><div class="k">Mobile</div><div class="v">${escapeHtml(order.mobile || "-")}</div></div>
          <div class="meta-box"><div class="k">Expected Delivery</div><div class="v">${escapeHtml(order.expectedDelivery || "-")}</div></div>
          <div class="meta-box"><div class="k">Tracking Updated</div><div class="v">${escapeHtml(order.trackingUpdatedAt || "-")}</div></div>
          <div class="meta-box"><div class="k">Address</div><div class="v">${escapeHtml(order.shippingAddress || "Address not available")}</div></div>
        </div>
        <div class="ship-actions" style="margin-top:16px">
          <a class="btn-primary" href="trackorder.html?orderId=${encodeURIComponent(order.id)}">Open Tracking</a>
          <a class="btn-light" href="admin-orders.html">Open Order</a>
          <button class="btn-success" onclick='openPrintLabel(${JSON.stringify(order)})'>Print Label</button>
        </div>
      </div>
    `;
  }).join("");
}

window.addEventListener("focus", function(){
  renderShiprocketOrders();
});

renderShiprocketOrders();


