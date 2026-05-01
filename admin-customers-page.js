
    const ARRAY_CUSTOMER_KEYS = [
      "customers",
      "accounts",
      "registeredUsers",
      "userAccounts",
      "swadraUsers",
      "swadraCustomers",
      "allUsers"
    ];

    const ORDER_KEYS = [
      "adminOrders",
      "orders",
      "swadraOrders",
      "customerOrders",
      "allOrders"
    ];

    const authApi = window.SWADRA_AUTH || null;
    const dataApi = window.SWADRA_DATA || null;
    let backendUsersCache = {};
    let backendOrdersCache = [];

    function safeJsonParse(value, fallback){
      try{
        const parsed = JSON.parse(value);
        return parsed ?? fallback;
      }catch(error){
        return fallback;
      }
    }

    function escapeHtml(str){
      return String(str || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function normalizeMobile(value){
      return String(value || "").replace(/\D/g, "");
    }

    function getValueByPossibleKeys(obj, keys){
      for(const key of keys){
        if(obj && obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== ""){
          return obj[key];
        }
      }
      return "";
    }

    function formatDate(value){
      if(!value) return "-";
      const date = new Date(value);
      return isNaN(date.getTime()) ? String(value) : date.toLocaleString("en-IN");
    }

    function rupee(value){
      return "₹" + Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
    }

    function readUsersObject(){
      return backendUsersCache && typeof backendUsersCache === "object" ? backendUsersCache : {};
    }

    function getBackendBaseUrl(){
      return String(window.SWADRA_API_BASE || "https://swadra-backend-production.up.railway.app").replace(/\/+$/, "");
    }

    function getAdminSessionToken(){
      try{
        const raw = String(window.name || "");
        if(!raw || raw.charAt(0) !== "{") return "";
        const state = JSON.parse(raw);
        const session = state && state.swadra_admin_session_v1;
        return String(session && session.token || "").trim();
      }catch(error){
        return "";
      }
    }

    function getAdminFetchHeaders(extra = {}){
      const headers = { ...extra };
      const token = getAdminSessionToken();
      if(token && !headers.Authorization){
        headers.Authorization = `Bearer ${token}`;
      }
      return headers;
    }

    async function fetchBackendUsersForAdmin(){
      const base = getBackendBaseUrl();
      if(!base) return;
      try{
        const response = await fetch(`${base}/api/admin/users`, {
          method: "GET",
          cache: "no-store",
          headers: getAdminFetchHeaders({ "Accept": "application/json" })
        });
        const payload = await response.json().catch(()=>({}));
        if(response.ok && payload && payload.ok && payload.users && typeof payload.users === "object"){
          backendUsersCache = payload.users;
          return;
        }
        if(response.status === 401){
          window.location.href = "admin-index.html";
          return;
        }
        console.warn("admin users fetch returned no users", payload);
      }catch(error){
        console.error("admin users fetch failed", error);
      }

      try{
        const response = await fetch(`${base}/api/app-state/bootstrap`, {
          method: "GET",
          cache: "no-store",
          headers: getAdminFetchHeaders({ "Accept": "application/json" })
        });
        const payload = await response.json().catch(()=>({}));
        const users = payload && payload.state && payload.state.users;
        if(response.ok && payload && payload.ok && users && typeof users === "object"){
          backendUsersCache = users;
        }
      }catch(error){
        console.error("admin users fallback fetch failed", error);
      }
    }

    function isDeletedCustomer(customer){
      return String(customer.rawStatus || "").trim().toLowerCase() === "deleted";
    }

    function collectGlobalOrdersForCustomer(email, mobile){
      const allOrders = [];
      const normalizedEmail = String(email || "").trim().toLowerCase();
      const normalizedMobile = normalizeMobile(mobile);

      backendOrdersCache.forEach((order)=>{
        if(!order || typeof order !== "object") return;
        const orderEmail = String(getValueByPossibleKeys(order, ["email","emailId","mail","customerEmail","userId","user"])).trim().toLowerCase();
        const orderMobile = normalizeMobile(
          getValueByPossibleKeys(order, ["mobile","phone","phoneNumber","mobileNumber","contactNumber","customerPhone","shippingPhone"]) ||
          order.shipping?.phone ||
          order.shipping?.mobile
        );
        const orderUserId = String(getValueByPossibleKeys(order, ["userId","user"])).trim().toLowerCase();
        const sameEmail = normalizedEmail && (orderEmail === normalizedEmail || orderUserId === normalizedEmail);
        const sameMobile = normalizedMobile && orderMobile === normalizedMobile;
        if(sameEmail || sameMobile){
          allOrders.push(order);
        }
      });

      return allOrders;
    }

    function normalizeOrderItem(rawItem){
      const name = String(getValueByPossibleKeys(rawItem, ["name","productName","title"])).trim() || "Product";
      const size = String(getValueByPossibleKeys(rawItem, ["size","variant","productSize"])).trim();
      const quantity = Number(getValueByPossibleKeys(rawItem, ["quantity","qty","count"])) || 1;
      const price = Number(getValueByPossibleKeys(rawItem, ["price","sellingPrice","amount"])) || 0;

      return { name, size, quantity, price };
    }

    function normalizeAddressEntry(rawAddress, fallbackId){
      const address = rawAddress && typeof rawAddress === "object" ? rawAddress : {};
      return {
        id: String(address.id || fallbackId || `addr_${Math.random().toString(16).slice(2)}`),
        house: String(address.house || "").trim(),
        area: String(address.area || "").trim(),
        nearby: String(address.nearby || "").trim(),
        city: String(address.city || "").trim(),
        pincode: String(address.pincode || "").trim(),
        postoffice: String(address.postoffice || "").trim(),
        district: String(address.district || "").trim(),
        state: String(address.state || "").trim()
      };
    }

    function getAddressBook(userObj){
      const user = userObj && typeof userObj === "object" ? userObj : {};
      let addresses = Array.isArray(user.addresses)
        ? user.addresses.map((address, index)=>normalizeAddressEntry(address, `addr_${index + 1}`)).filter(address=>Object.entries(address).some(([key, value])=>key !== "id" && String(value || "").trim()))
        : [];

      if(!addresses.length && user.address && typeof user.address === "object" && Object.entries(user.address).some(([key, value])=>key !== "id" && String(value || "").trim())){
        addresses = [normalizeAddressEntry(user.address, user.defaultAddressId || "addr_1")];
      }

      let defaultAddressId = String(user.defaultAddressId || "").trim();
      if(!defaultAddressId && addresses.length){
        defaultAddressId = addresses[0].id;
      }

      const defaultAddress = addresses.find(address=>address.id === defaultAddressId) || addresses[0] || {};
      return {
        addresses,
        addressCount: addresses.length,
        defaultAddressId,
        defaultAddress
      };
    }

    function calculateOrderSavings(raw){
      const productSavings = Number(getValueByPossibleKeys(raw, ["productSavings"])) || 0;
      const couponSavings = Number(getValueByPossibleKeys(raw, ["couponDiscount","discount"])) || 0;
      if(productSavings > 0 || couponSavings > 0){
        return productSavings + couponSavings;
      }

      const mrpTotal = Number(getValueByPossibleKeys(raw, ["mrpTotal"])) || 0;
      const sellingTotal = Number(getValueByPossibleKeys(raw, ["sellingTotal","couponAdjustedSellingTotal","amount","totalAmount"])) || 0;
      return Math.max(0, mrpTotal - sellingTotal) + Math.max(0, couponSavings);
    }

    function extractOrderAmount(raw){
      const directAmount = Number(getValueByPossibleKeys(raw, ["finalAmount","total","amount","totalAmount","paidAmount","grandTotal","paymentAmount","payableAmount"]));
      if(directAmount > 0) return directAmount;

      const items = raw.items || raw.products || raw.cartItems || [];
      if(Array.isArray(items) && items.length){
        return items.reduce((sum, item) => {
          const price = Number(getValueByPossibleKeys(item, ["price","sellingPrice","amount"])) || 0;
          const qty = Number(getValueByPossibleKeys(item, ["quantity","qty","count"])) || 1;
          return sum + (price * qty);
        }, 0);
      }

      return 0;
    }

    function normalizeOrder(raw, fallbackLabel = "AccountOrder"){
      const itemsRaw = raw.items || raw.products || raw.cartItems || [];
      const items = Array.isArray(itemsRaw) ? itemsRaw.map(normalizeOrderItem) : [];
      const amount = extractOrderAmount(raw);

      return {
        id: String(getValueByPossibleKeys(raw, ["id","orderId","orderID","invoiceId","order_id"])) || `${fallbackLabel}_${Math.random().toString(16).slice(2)}`,
        status: String(getValueByPossibleKeys(raw, ["orderStatus","status","deliveryStatus"])).trim() || "Unknown",
        paymentStatus: String(getValueByPossibleKeys(raw, ["paymentStatus","payment","payment_state","payment_state_text"])).trim() || "Unknown",
        refundStatus: String(getValueByPossibleKeys(raw, ["refundStatus","razorpayRefundStatus","razorpayRefundGatewayStatus"])).trim(),
        refundId: String(getValueByPossibleKeys(raw, ["refundId","razorpayRefundId"])).trim(),
        refundAmount: Number(getValueByPossibleKeys(raw, ["refundAmount"])) || 0,
        date: formatDate(getValueByPossibleKeys(raw, ["createdAt","date","orderedAt","timestamp","time"])),
        amount,
        savings: calculateOrderSavings(raw),
        itemCount: items.reduce((sum, item)=>sum + Number(item.quantity || 1), 0),
        items
      };
    }

    function buildCustomerDetails(userObj, email, mobile){
      const profile = userObj?.profile || {};
      const cart = Array.isArray(userObj?.cart) ? userObj.cart : [];
      const addressBook = getAddressBook(userObj);
      const userOrders = Array.isArray(userObj?.orders) ? userObj.orders : [];
      const globalOrders = collectGlobalOrdersForCustomer(email, mobile);

      const mergedOrders = [];
      const seen = new Set();

      [...userOrders, ...globalOrders].forEach((order)=>{
        const normalized = normalizeOrder(order, "CustomerOrder");
        const dedupeKey = `${normalized.id}|${normalized.amount}|${normalized.date}`;
        if(seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        mergedOrders.push(normalized);
      });

      const totalSpent = mergedOrders.reduce((sum, order)=>sum + Number(order.amount || 0), 0);
      const totalSavings = mergedOrders.reduce((sum, order)=>sum + Number(order.savings || 0), 0);
      const lastOrder = mergedOrders[0] || null;

      return {
        profile,
        cart,
        cartCount: cart.length,
        address: addressBook.defaultAddress || {},
        addresses: addressBook.addresses || [],
        addressCount: addressBook.addressCount || 0,
        defaultAddressId: addressBook.defaultAddressId || "",
        orders: mergedOrders,
        orderCount: mergedOrders.length,
        totalSpent,
        totalSavings,
        lastOrder
      };
    }

    function getCustomersFromUsersObject(){
      const usersObject = readUsersObject();
      const entries = Object.entries(usersObject);

      return entries.map(([emailKey, user], index) => {
        const profile = user?.profile || {};
        const email = String(user?.email || profile?.email || emailKey || "").trim();
        const mobile = String(user?.phone || profile?.phone || "").trim();
        const name = String(profile?.name || email.split("@")[0] || "Unnamed Customer").trim();
        const createdAtRaw = user?.createdAt || user?.registeredAt || user?.signupAt || user?.date || user?.timestamp || "";
        const updatedAtRaw = user?.updatedAt || user?.modifiedAt || "";
        const lastLoginAtRaw = user?.lastLoginAt || "";
        const rawStatus = String(user?.status || user?.accountStatus || "").trim().toLowerCase();
        const details = buildCustomerDetails(user, email, mobile);

        return {
          __sourceType: "users_object",
          __sourceKey: "users",
          __emailKey: emailKey,
          id: String(user?.id || user?.userId || user?.uid || email || `users_${index}`),
          sourceKey: "users",
          name,
          email,
          mobile,
          createdAtRaw,
          updatedAtRaw,
          lastLoginAtRaw,
          rawStatus,
          raw: user,
          details
        };
      });
    }

    function getCustomersFromArrayKeys(){
      return [];
    }

    function normalizeCustomer(base){
      return {
        ...base,
        createdAt: formatDate(base.createdAtRaw),
        updatedAt: formatDate(base.updatedAtRaw),
        lastLoginAt: formatDate(base.lastLoginAtRaw),
        isPaused: ["paused","inactive","blocked"].includes(base.rawStatus),
        searchText: [base.name, base.email, base.mobile].join(" ").toLowerCase()
      };
    }

    function getCustomersFromStorage(){
      const merged = [];
      const seen = new Set();

      const sourceCustomers = getCustomersFromUsersObject();

      sourceCustomers.forEach((customer) => {
        const normalized = normalizeCustomer(customer);
        const dedupeKey = [
          normalized.email.toLowerCase(),
          normalizeMobile(normalized.mobile),
          normalized.name.toLowerCase()
        ].join("|");

        if(seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        merged.push(normalized);
      });

      return merged;
    }

    function renderVerificationMetrics(){
      const usersObjectCount = Object.keys(readUsersObject()).length;
      const arraySourceCustomers = [];
      const mergedVisible = getCustomersFromStorage().filter(customer=>!isDeletedCustomer(customer));
      const deletedCount = getCustomersFromStorage().filter(customer=>isDeletedCustomer(customer)).length;
      const rawTotal = usersObjectCount + arraySourceCustomers.length;
      const filteredOut = Math.max(0, rawTotal - mergedVisible.length);

      document.getElementById("usersObjectCount").textContent = usersObjectCount;
      document.getElementById("arraySourceCount").textContent = arraySourceCustomers.length;
      document.getElementById("mergedVisibleCount").textContent = mergedVisible.length;
      document.getElementById("filteredOutCount").textContent = Math.max(filteredOut, deletedCount);
    }

    function getFilteredCustomers(){
      const customers = getCustomersFromStorage();
      const query = String(document.getElementById("searchInput").value || "").trim().toLowerCase();

      if(!query) return customers;

      const normalizedQuery = query.replace(/\D/g, "");
      return customers.filter((customer) => {
        const textMatch = customer.searchText.includes(query);
        const mobileMatch = normalizedQuery ? normalizeMobile(customer.mobile).includes(normalizedQuery) : false;
        return textMatch || mobileMatch;
      });
    }

    function renderStats(allCustomers){
      const pausedCount = allCustomers.filter(item => item.isPaused && !isDeletedCustomer(item)).length;
      const deletedCount = allCustomers.filter(item => isDeletedCustomer(item)).length;
      const visibleCount = allCustomers.filter(item => !isDeletedCustomer(item)).length;
      const activeCount = visibleCount - pausedCount;

      document.getElementById("customerStats").innerHTML = `
        <div class="stat-card">
          <div class="label">Total Customers</div>
          <div class="value">${visibleCount}</div>
        </div>
        <div class="stat-card">
          <div class="label">Active Accounts</div>
          <div class="value">${activeCount}</div>
        </div>
        <div class="stat-card">
          <div class="label">Paused Accounts</div>
          <div class="value">${pausedCount}</div>
        </div>
        <div class="stat-card">
          <div class="label">Deleted Accounts</div>
          <div class="value">${deletedCount}</div>
        </div>
      `;

      document.getElementById("totalCustomersView").textContent = visibleCount;
      document.getElementById("activeCustomersView").textContent = activeCount;
      document.getElementById("pausedCustomersView").textContent = pausedCount;
      document.getElementById("deletedCustomersView").textContent = deletedCount;
    }

    function buildSingleAddressCard(address, isDefault){
      const values = Object.entries(address || {})
        .filter(([key, value]) => key !== "id" && String(value || "").trim() !== "")
        .map(([key, value]) => `
          <div class="mini">
            <div class="k">${escapeHtml(key)}</div>
            <div class="v">${escapeHtml(value)}</div>
          </div>
        `);

      return `
        <div class="customer-card" style="padding:14px;">
          <div class="customer-head">
            <div>
              <h3 style="font-size:18px;">${escapeHtml(address.house || "Saved Address")}</h3>
              <div class="badge-wrap">
                ${isDefault ? `<span class="badge green">Default Address</span>` : `<span class="badge">Saved Address</span>`}
                ${address.nearby ? `<span class="badge gold">Near ${escapeHtml(address.nearby)}</span>` : ``}
              </div>
            </div>
          </div>
          <div class="card-grid">${values.join("")}</div>
        </div>
      `;
    }

    function buildAddressHtml(addresses, defaultAddressId){
      const list = Array.isArray(addresses) ? addresses.filter(address=>address && typeof address === "object" && Object.entries(address).some(([key, value])=>key !== "id" && String(value || "").trim())) : [];
      if(!list.length){
        return `<div class="empty">No saved address.</div>`;
      }

      return `<div class="history-list">${list.map(address=>buildSingleAddressCard(address, String(address.id || "") === String(defaultAddressId || ""))).join("")}</div>`;
    }

    function buildCartHtml(cart){
      if(!Array.isArray(cart) || !cart.length){
        return `<div class="empty">Cart empty.</div>`;
      }

      return `
        <div style="display:grid;gap:10px;">
          ${cart.map(item => `
            <div class="customer-card" style="padding:12px;">
              <div class="card-grid">
                <div class="mini">
                  <div class="k">Product</div>
                  <div class="v">${escapeHtml(getValueByPossibleKeys(item, ["name","productName","title"]) || "Product")}</div>
                </div>
                <div class="mini">
                  <div class="k">Size</div>
                  <div class="v">${escapeHtml(getValueByPossibleKeys(item, ["size","variant","productSize"]) || "-")}</div>
                </div>
                <div class="mini">
                  <div class="k">Qty × Price</div>
                  <div class="v">${Number(getValueByPossibleKeys(item, ["quantity","qty","count"]) || 1)} × ${rupee(getValueByPossibleKeys(item, ["price","sellingPrice","amount"]) || 0)}</div>
                </div>
              </div>
            </div>
          `).join("")}
        </div>
      `;
    }

    function buildCartPreviewHtml(cart){
      if(!Array.isArray(cart) || !cart.length){
        return `<div class="empty" style="padding:12px;">Cart empty.</div>`;
      }

      return `
        <div style="display:grid;gap:8px;">
          ${cart.slice(0,3).map(item => `
            <div class="mini">
              <div class="k">${escapeHtml(getValueByPossibleKeys(item, ["name","productName","title"]) || "Product")}</div>
              <div class="v">${Number(getValueByPossibleKeys(item, ["quantity","qty","count"]) || 1)} × ${rupee(getValueByPossibleKeys(item, ["price","sellingPrice","amount"]) || 0)}</div>
            </div>
          `).join("")}
          ${cart.length > 3 ? `<div class="mini"><div class="k">More Items</div><div class="v">${cart.length - 3} more in cart</div></div>` : ``}
        </div>
      `;
    }

    function buildOrdersHtml(orders){
      if(!Array.isArray(orders) || !orders.length){
        return `<div class="empty">No order history yet.</div>`;
      }

      return `
        <div style="display:grid;gap:12px;">
          ${orders.map(order => `
            <div class="customer-card" style="padding:14px;">
              <div class="customer-head">
                <div>
                  <h3 style="font-size:18px;">Order: ${escapeHtml(order.id || "-")}</h3>
                  <div class="badge-wrap">
                    <span class="badge gold">${escapeHtml(order.status || "Unknown")}</span>
                    <span class="badge">${escapeHtml(order.paymentStatus || "Unknown")}</span>
                    ${order.refundStatus ? `<span class="badge red">${escapeHtml(order.refundStatus)}</span>` : ""}
                    ${order.refundId ? `<span class="badge">${escapeHtml(order.refundId)}</span>` : ""}
                    ${order.refundAmount ? `<span class="badge green">Refund ${rupee(order.refundAmount)}</span>` : ""}
                    <span class="badge green">${rupee(order.amount || 0)}</span>
                    <span class="badge">${escapeHtml(order.date || "-")}</span>
                  </div>
                </div>
              </div>

              <div style="display:grid;gap:8px;">
                ${(order.items || []).length ? order.items.map(item => `
                  <div class="mini">
                    <div class="k">${escapeHtml(item.name || "Product")}</div>
                    <div class="v">
                      ${item.size ? `(${escapeHtml(item.size)}) ` : ""}× ${Number(item.quantity || 1)} — ${rupee((Number(item.price || 0) * Number(item.quantity || 1)))}
                    </div>
                  </div>
                `).join("") : `<div class="empty">No line items.</div>`}
                ${order.deliveryDetails || order.shipping?.deliveryDetails || (order.delivery && typeof order.delivery === "object") ? `
                  <div class="mini">
                    <div class="k">Delivery</div>
                    <div class="v">
                      Zone: ${escapeHtml((order.deliveryDetails || order.shipping?.deliveryDetails || (typeof order.delivery === "object" ? order.delivery : {})).zone || "-")} •
                      Weight: ${escapeHtml(String((order.deliveryDetails || order.shipping?.deliveryDetails || (typeof order.delivery === "object" ? order.delivery : {})).chargeableWeight || "-"))} •
                      Charged: ${rupee((order.deliveryDetails || order.shipping?.deliveryDetails || (typeof order.delivery === "object" ? order.delivery : {})).finalDeliveryCharge || order.deliveryCharge || (typeof order.delivery === "number" ? order.delivery : 0) || 0)}
                    </div>
                  </div>
                ` : ``}
              </div>
            </div>
          `).join("")}
        </div>
      `;
    }

    function buildHistoryPageHtml(customer){
      const details = customer.details || {};
      const profile = details.profile || {};
      const lastOrder = details.lastOrder || {};
      const primaryAddress = details.address || {};
      const orderCount = Number(details.orderCount || 0);
      const totalSpent = Number(details.totalSpent || 0);
      const cartCount = Number(details.cartCount || 0);
      const totalSavings = Number(details.totalSavings || 0);
      const addressCount = Number(details.addressCount || 0);
      const lastOrderDate = escapeHtml(lastOrder.date || "-");
      const createdAtLabel = escapeHtml(customer.createdAt || "-");
      const defaultAddressHouse = escapeHtml(primaryAddress.house || "-");
      const lastOrderStatus = escapeHtml(lastOrder.status || "-");
      const lastOrderAmount = rupee(lastOrder.amount || 0);

      return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(customer.name)} - Customer History</title>
  <style>
    * { box-sizing:border-box; }
    :root{
      --primary:#7a3d3d;
      --primary-dark:#5f2f2f;
      --bg:#f8f5f2;
      --card:#ffffff;
      --text:#1f1f1f;
      --muted:#6c6c6c;
      --line:#e7dfd7;
      --success:#137a43;
      --warn:#b36b00;
      --danger:#c62828;
      --shadow:0 10px 30px rgba(0,0,0,0.08);
    }
    body{
      margin:0;
      font-family:Arial, Helvetica, sans-serif;
      background:var(--bg);
      color:var(--text);
    }
    .wrap{
      width:min(100%, 1600px);
      margin:0 auto;
      padding:20px 24px 28px;
    }
    .topbar{
      background:linear-gradient(135deg,var(--primary),var(--primary-dark));
      color:#fff;
      padding:24px 28px;
      border-radius:22px;
      box-shadow:var(--shadow);
      margin-bottom:18px;
    }
    .topbar h1{
      margin:0;
      font-size:30px;
      line-height:1.2;
    }
    .topbar p{
      margin:8px 0 0;
      opacity:0.92;
      font-size:15px;
      line-height:1.6;
    }
    .toolbar{
      display:flex;
      gap:12px;
      flex-wrap:wrap;
      margin-bottom:18px;
    }
    button{
      border:none;
      outline:none;
      cursor:pointer;
      border-radius:12px;
      padding:12px 18px;
      font-size:14px;
      font-weight:700;
    }
    .btn-dark{ background:#333; color:#fff; }
    .stats-grid{
      display:grid;
      grid-template-columns:repeat(6,minmax(0,1fr));
      gap:14px;
      margin-bottom:18px;
    }
    .stat-card{
      background:var(--card);
      border-radius:18px;
      box-shadow:var(--shadow);
      padding:16px;
    }
    .stat-card .label{
      font-size:12px;
      color:var(--muted);
      font-weight:700;
    }
    .stat-card .value{
      font-size:28px;
      font-weight:800;
      margin-top:8px;
      color:var(--primary);
    }
    .panel{
      background:var(--card);
      border-radius:22px;
      box-shadow:var(--shadow);
      padding:22px 24px;
      margin-bottom:18px;
    }
    .panel h2{
      margin:0 0 14px;
      font-size:24px;
    }
    .card-grid{
      display:grid;
      grid-template-columns:repeat(4,1fr);
      gap:12px;
    }
    .mini{
      background:#faf6f2;
      border:1px solid var(--line);
      border-radius:14px;
      padding:12px;
    }
    .mini .k{
      font-size:12px;
      color:var(--muted);
      font-weight:700;
      margin-bottom:5px;
      text-transform:capitalize;
    }
    .mini .v{
      font-size:16px;
      font-weight:800;
      word-break:break-word;
    }
    .history-list{
      display:grid;
      gap:12px;
    }
    .history-card{
      border:1px solid var(--line);
      border-radius:16px;
      background:#fffdfa;
      padding:14px;
      display:grid;
      gap:10px;
    }
    .history-head{
      display:flex;
      justify-content:space-between;
      align-items:flex-start;
      gap:12px;
      flex-wrap:wrap;
    }
    .badge-wrap{
      display:flex;
      gap:8px;
      flex-wrap:wrap;
      margin-top:6px;
    }
    .badge{
      padding:7px 11px;
      border-radius:999px;
      font-size:12px;
      font-weight:700;
      background:#f2ebe4;
      color:#433;
    }
    .badge.green{ background:#e7f5ec; color:var(--success); }
    .badge.gold{ background:#fff3dc; color:var(--warn); }
    .empty{
      padding:20px;
      border:1px dashed #d8cdc2;
      border-radius:16px;
      color:var(--muted);
      text-align:center;
      background:#fffdfa;
    }
    @media (max-width:1100px){
      .stats-grid, .card-grid{ grid-template-columns:repeat(2,1fr); }
    }
    @media (max-width:600px){
      .stats-grid, .card-grid{ grid-template-columns:1fr; }
      .topbar h1{ font-size:24px; }
      .wrap{ padding:16px; }
    }
  </style>
<link rel="stylesheet" href="swadra-responsive.css">
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <h1>${escapeHtml(customer.name)} - Customer History</h1>
                  <p>Complete customer profile, saved address, cart snapshot, and order timeline.</p>
    </div>

    <div class="toolbar">
      <button class="btn-dark" onclick="window.close()">Close Page</button>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">Orders</div>
        <div class="value">${orderCount}</div>
      </div>
      <div class="stat-card">
        <div class="label">Total Spent</div>
        <div class="value">${rupee(totalSpent)}</div>
      </div>
      <div class="stat-card">
        <div class="label">Cart Items</div>
        <div class="value">${cartCount}</div>
      </div>
      <div class="stat-card">
        <div class="label">Total Saved</div>
        <div class="value">${rupee(totalSavings)}</div>
      </div>
      <div class="stat-card">
        <div class="label">Address Count</div>
        <div class="value">${addressCount}</div>
      </div>
      <div class="stat-card">
        <div class="label">Last Order</div>
        <div class="value" style="font-size:18px;">${lastOrderDate}</div>
      </div>
      <div class="stat-card">
        <div class="label">Created</div>
        <div class="value" style="font-size:18px;">${createdAtLabel}</div>
      </div>
    </div>

    <div class="panel">
      <h2>Profile Details</h2>
      <div class="card-grid">
        <div class="mini"><div class="k">Name</div><div class="v">${escapeHtml(customer.name || "-")}</div></div>
        <div class="mini"><div class="k">Email</div><div class="v">${escapeHtml(customer.email || "-")}</div></div>
        <div class="mini"><div class="k">Mobile</div><div class="v">${escapeHtml(customer.mobile || "-")}</div></div>
        <div class="mini"><div class="k">Source</div><div class="v">${escapeHtml(customer.sourceKey || "-")}</div></div>
        <div class="mini"><div class="k">Created</div><div class="v">${escapeHtml(customer.createdAt || "-")}</div></div>
        <div class="mini"><div class="k">Updated</div><div class="v">${escapeHtml(customer.updatedAt || "-")}</div></div>
        <div class="mini"><div class="k">Account Status</div><div class="v">${escapeHtml(customer.rawStatus || (customer.isPaused ? "paused" : "active"))}</div></div>
        <div class="mini"><div class="k">Last Login</div><div class="v">${escapeHtml(customer.lastLoginAt || "-")}</div></div>
        <div class="mini"><div class="k">Profile Name</div><div class="v">${escapeHtml(profile.name || "-")}</div></div>
        <div class="mini"><div class="k">Profile Phone</div><div class="v">${escapeHtml(profile.phone || "-")}</div></div>
        <div class="mini"><div class="k">Default Address</div><div class="v">${defaultAddressHouse}</div></div>
        <div class="mini"><div class="k">Last Order Status</div><div class="v">${lastOrderStatus}</div></div>
        <div class="mini"><div class="k">Last Order Amount</div><div class="v">${lastOrderAmount}</div></div>
        <div class="mini"><div class="k">Total Savings</div><div class="v">${rupee(totalSavings)}</div></div>
      </div>
    </div>

    <div class="panel">
      <h2>Saved Address</h2>
      ${buildAddressHtml(details.addresses || [], details.defaultAddressId || "")}
    </div>

    <div class="panel">
      <h2>Cart Snapshot</h2>
      ${buildCartHtml(details.cart || [])}
    </div>

    <div class="panel">
      <h2>Order History</h2>
      ${buildOrdersHtml(details.orders || [])}
    </div>
  </div>
</body>
</html>
      `;
    }

    function openHistoryPage(customerId, deletedMode = false){
      const customers = deletedMode
        ? getCustomersFromStorage().filter(customer=>isDeletedCustomer(customer))
        : getCustomersFromStorage().filter(customer=>!isDeletedCustomer(customer));
      const customer = customers.find(item => String(item.id) === String(customerId));
      if(!customer){
        alert("Customer not found.");
        return;
      }

      window.document.open();
      window.document.write(buildHistoryPageHtml(customer));
      window.document.close();
    }

    function renderCustomers(){
      const allCustomers = getCustomersFromStorage();
      const customers = getFilteredCustomers().filter(customer=>!isDeletedCustomer(customer));
      const customerList = document.getElementById("customerList");

      renderStats(allCustomers);

      if(!customers.length){
        customerList.innerHTML = `<div class="empty">No customer accounts found.</div>`;
        return;
      }

      customerList.innerHTML = customers.map((customer) => {
        const stateClass = customer.isPaused ? "red" : "green";
        const stateLabel = customer.isPaused ? "Paused" : "Active";
        const orderCount = customer.details && customer.details.orderCount ? Number(customer.details.orderCount) : 0;
        const totalSpent = customer.details && customer.details.totalSpent ? Number(customer.details.totalSpent) : 0;
        const cartItems = customer.details && customer.details.cartCount ? Number(customer.details.cartCount) : 0;
        const cartHtml = buildCartPreviewHtml(customer.details && customer.details.cart ? customer.details.cart : []);

        return `
          <div class="customer-card">
            <div class="customer-head">
              <div>
                <h3>${escapeHtml(customer.name)}</h3>
                <div class="badge-wrap">
                  <span class="badge ${stateClass}">${stateLabel}</span>
                  <span class="badge gold">Source: ${escapeHtml(customer.sourceKey)}</span>
                  <span class="badge">Orders: ${orderCount}</span>
                  <span class="badge green">Spent: ${rupee(totalSpent)}</span>
                </div>
              </div>
              <div class="badge-wrap">
                <span class="badge">${escapeHtml(customer.id)}</span>
              </div>
            </div>

            <div class="card-grid">
              <div class="mini">
                <div class="k">Email</div>
                <div class="v">${escapeHtml(customer.email || "-")}</div>
              </div>
              <div class="mini">
                <div class="k">Mobile</div>
                <div class="v">${escapeHtml(customer.mobile || "-")}</div>
              </div>
              <div class="mini">
                <div class="k">Created</div>
                <div class="v">${escapeHtml(customer.createdAt || "-")}</div>
              </div>
              <div class="mini">
                <div class="k">Cart Items</div>
                <div class="v">${cartItems}</div>
              </div>
            </div>

            <div style="margin-top:12px;">
              <div style="font-size:13px;font-weight:800;color:#7a3d3d;margin-bottom:8px;">Current Cart</div>
              ${cartHtml}
            </div>

            <div class="card-actions">
              <button
                class="${customer.isPaused ? 'btn-secondary' : 'btn-danger'}"
                onclick="togglePauseCustomer('${escapeHtml(customer.id)}')"
              >
                ${customer.isPaused ? 'Unpause Account' : 'Pause Account'}
              </button>

              <button
                class="btn-dark"
                onclick="deleteCustomerAccount('${escapeHtml(customer.id)}')"
              >
                Delete Account
              </button>

              <button
                class="btn-light"
                onclick="openHistoryPage('${escapeHtml(customer.id)}', false)"
              >
                View Full History
              </button>
            </div>
          </div>
        `;
      }).join("");
    }

    function renderDeletedCustomers(){
      const deleted = getCustomersFromStorage().filter(customer=>isDeletedCustomer(customer));
      const deletedCustomerList = document.getElementById("deletedCustomerList");

      if(!deleted.length){
        deletedCustomerList.innerHTML = `<div class="empty">No deleted accounts yet.</div>`;
        return;
      }

      deletedCustomerList.innerHTML = deleted.map((customer) => {
        const customerDetails = customer.details || {};
        const deletedOrderCount = Number(customerDetails.orderCount || 0);
        const deletedTotalSpent = Number(customerDetails.totalSpent || 0);
        const deletedCartCount = Number(customerDetails.cartCount || 0);
        const deletedCartHtml = buildCartPreviewHtml(customerDetails.cart || []);
        return `
        <div class="customer-card">
          <div class="customer-head">
            <div>
              <h3>${escapeHtml(customer.name || "Deleted Customer")}</h3>
              <div class="badge-wrap">
                <span class="badge red">Deleted</span>
                <span class="badge gold">Deleted At: ${escapeHtml(customer.updatedAt || "-")}</span>
                <span class="badge">Orders: ${deletedOrderCount}</span>
                <span class="badge green">Spent: ${rupee(deletedTotalSpent)}</span>
              </div>
            </div>
            <div class="badge-wrap">
              <span class="badge">${escapeHtml(customer.id || "-")}</span>
            </div>
          </div>

          <div class="card-grid">
            <div class="mini">
              <div class="k">Email</div>
              <div class="v">${escapeHtml(customer.email || "-")}</div>
            </div>
            <div class="mini">
              <div class="k">Mobile</div>
              <div class="v">${escapeHtml(customer.mobile || "-")}</div>
            </div>
            <div class="mini">
              <div class="k">Created</div>
              <div class="v">${escapeHtml(customer.createdAt || "-")}</div>
            </div>
            <div class="mini">
              <div class="k">Cart Items</div>
              <div class="v">${deletedCartCount}</div>
            </div>
          </div>

          <div style="margin-top:12px;">
            <div style="font-size:13px;font-weight:800;color:#7a3d3d;margin-bottom:8px;">Current Cart</div>
            ${deletedCartHtml}
          </div>

          <div class="card-actions">
            <button
              class="btn-light"
              onclick="openHistoryPage('${escapeHtml(customer.id)}', true)"
            >
              View Full History
            </button>
          </div>
        </div>
      `;
      }).join("");
    }

    async function updateCustomerStatus(customer, status){
      if(!customer || !customer.email){
        throw new Error("Customer email missing");
      }
      const users = readUsersObject();
      const userKey = customer.__emailKey || customer.email;
      const existing = users[userKey] || users[customer.email] || customer.raw || {};
      const nextRecord = Object.assign({}, existing, {
        email: customer.email,
        phone: customer.mobile || existing.phone || "",
        status: status,
        updatedAt: new Date().toISOString()
      });
      if(authApi && typeof authApi.saveUserRecord === "function"){
        await authApi.saveUserRecord(nextRecord);
        if(typeof authApi.refreshUsers === "function"){
          await authApi.refreshUsers();
        }
        return;
      }
      throw new Error("Firestore user save unavailable");
    }

    async function togglePauseCustomer(customerId){
      const customers = getCustomersFromStorage();
      const customer = customers.find(item => String(item.id) === String(customerId) && !isDeletedCustomer(item));
      if(!customer){
        alert("Customer not found.");
        return;
      }
      try{
        await updateCustomerStatus(customer, customer.isPaused ? "active" : "paused");
        renderCustomers();
        renderDeletedCustomers();
      }catch(error){
        console.error(error);
        alert("Account status update failed.");
      }
    }

    function deleteRelatedCurrentSession(customer){
      const currentUser = authApi && typeof authApi.getCurrentUserEmail === "function"
        ? authApi.getCurrentUserEmail()
        : "";
      if(currentUser && String(currentUser).trim().toLowerCase() === String(customer.email || "").trim().toLowerCase()){
        if(authApi && typeof authApi.signOutUser === "function"){
          authApi.signOutUser({ keepCart:false });
        }
      }
    }

    async function deleteCustomerAccount(customerId){
      const customers = getCustomersFromStorage().filter(customer=>!isDeletedCustomer(customer));
      const customer = customers.find(item => String(item.id) === String(customerId));

      if(!customer){
        alert("Customer not found.");
        return;
      }

      const confirmed = confirm(`Delete account for ${customer.name}?`);
      if(!confirmed) return;

      try{
        await updateCustomerStatus(customer, "deleted");
        deleteRelatedCurrentSession(customer);
        await refreshCustomers();
        alert("Customer account deleted successfully.");
      }catch(error){
        console.error(error);
        alert("Delete failed.");
      }
    }

    function clearSearch(){
      document.getElementById("searchInput").value = "";
      renderCustomers();
    }

    async function refreshCustomers(){
      await fetchBackendUsersForAdmin();
      const orderSources = [];
      if(window.SWADRA_API_BASE){
        try{
          const response = await fetch(String(window.SWADRA_API_BASE || "") + "/api/orders", {
            cache:"no-store",
            headers: getAdminFetchHeaders({ "Accept": "application/json" })
          });
          const data = await response.json().catch(function(){ return {}; });
          if(response.ok && data.ok && Array.isArray(data.orders)) orderSources.push(...data.orders);
        }catch(error){
          console.error("customer backend order fetch failed", error);
        }
      }
      const orderMap = new Map();
      orderSources.forEach(function(order){
        if(!order || typeof order !== "object") return;
        const key = String(order.id || order.orderId || "") || JSON.stringify(order).slice(0, 120);
        orderMap.set(key, { ...(orderMap.get(key) || {}), ...order });
      });
      backendOrdersCache = Array.from(orderMap.values());
      renderVerificationMetrics();
      renderCustomers();
      renderDeletedCustomers();
    }

    (async function initializeCustomersPage(){
      await refreshCustomers();
    })();
  
