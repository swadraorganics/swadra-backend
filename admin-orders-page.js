
    const ORDER_SOURCE_KEYS = ["adminOrders", "orders", "swadraOrders", "customerOrders", "allOrders"];
    const DEFAULT_SENDER_DETAILS = {
      company: "Swadra Organics",
      name: "Swadra Dispatch",
      phone: "",
      address: ""
    };
    const authApi = window.SWADRA_AUTH || null;
    const dataApi = window.SWADRA_DATA || null;
    let firestoreOrdersCache = [];

    function safeJsonParse(value, fallback){
      try{
        const parsed = JSON.parse(value);
        return parsed ?? fallback;
      }catch(error){
        return fallback;
      }
    }

    function rupee(value){
      return "₹" + Number(value || 0).toFixed(0);
    }

    function escapeHtml(str){
      return String(str || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function jsString(value){
      return JSON.stringify(value == null ? "" : value);
    }

    function normalizeText(value){
      return String(value || "").trim().toLowerCase();
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

    function getValueByPossibleKeys(obj, keys){
      for(const key of keys){
        if(obj && obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== ""){
          return obj[key];
        }
      }
      return "";
    }

    function parseAnyDate(value){
      if(!value) return null;
      const date = new Date(value);
      if(!isNaN(date.getTime())) return date;

      const secondTry = new Date(String(value).replace(/,/g, ""));
      if(!isNaN(secondTry.getTime())) return secondTry;

      return null;
    }

    function getOrderTime(order){
      return order && order.date ? order.date.getTime() : 0;
    }

    function getOrderDateKey(order){
      const date = order && order.date ? order.date : null;
      if(!date) return "unknown";
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }

    function getOrderDateHeading(order){
      const date = order && order.date ? order.date : null;
      if(!date) return "Date not available";
      return date.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        weekday: "short"
      });
    }

    function setTextIfExists(id, value){
      const element = document.getElementById(id);
      if(element) element.textContent = value;
    }

    function buildShippingAddress(raw){
      const shipping = raw && typeof raw.shipping === "object" ? raw.shipping : {};
      const directAddress = String(getValueByPossibleKeys(shipping, ["address","fullAddress"])).trim();
      if(directAddress){
        return directAddress;
      }
      return [
        getValueByPossibleKeys(shipping, ["house","line1","addressLine1"]),
        getValueByPossibleKeys(shipping, ["area","line2","addressLine2"]),
        getValueByPossibleKeys(shipping, ["postoffice"]),
        getValueByPossibleKeys(shipping, ["city","district"]),
        getValueByPossibleKeys(shipping, ["state"]),
        getValueByPossibleKeys(shipping, ["pincode","zip","postalCode"])
      ].map(value => String(value || "").trim()).filter(Boolean).join(", ");
    }

    function normalizeOrderStatus(raw){
      const value = normalizeText(raw);
      if(!value) return "unknown";
      if(value.includes("cancel")) return "cancelled";
      if((value.includes("non") && value.includes("deliver")) || (value.includes("failed") && value.includes("deliver")) || value.includes("rto")) return "non-delivered";
      if(value.includes("pending")) return "pending";
      if(value.includes("confirm")) return "confirmed";
      if(value.includes("pack")) return "packed";
      if(value.includes("dispatch")) return "shipped";
      if(value.includes("out for delivery") || value.includes("out_for_delivery")) return "out-for-delivery";
      if(value.includes("ship")) return "shipped";
      if(value.includes("deliver")) return "delivered";
      return value;
    }

    function orderStatusLabel(status){
      const value = normalizeOrderStatus(status);
      if(value === "user-cancelled") return "User Cancelled";
      if(value === "confirmed") return "Order Confirmed";
      if(value === "packed") return "Packed";
      if(value === "shipped") return "Shipped";
      if(value === "out-for-delivery") return "Out for Delivery";
      if(value === "delivered") return "Delivered";
      if(value === "non-delivered") return "Non Delivered";
      if(value === "cancelled") return "Cancelled";
      if(value === "pending") return "Pending";
      return value || "Unknown";
    }

    function buildStatusFlow(status){
      const value = normalizeOrderStatus(status);
      if(value === "cancelled" || value === "non-delivered"){
        return `<div class="status-step danger">${escapeHtml(orderStatusLabel(value))}</div>`;
      }
      const steps = [
        ["confirmed", "Order Confirmed"],
        ["packed", "Packed"],
        ["shipped", "Shipped"],
        ["out-for-delivery", "Out for Delivery"],
        ["delivered", "Delivered"]
      ];
      const activeIndex = Math.max(0, steps.findIndex(function(step){ return step[0] === value; }));
      return steps.map(function(step, index){
        return `<div class="status-step ${index <= activeIndex ? "active" : ""}">${escapeHtml(step[1])}</div>`;
      }).join("");
    }

    function buildDateStatusSummary(orders){
      const counts = {
        confirmed: 0,
        packed: 0,
        shipped: 0,
        "out-for-delivery": 0,
        delivered: 0,
        cancelled: 0,
        "non-delivered": 0,
        pending: 0
      };
      (Array.isArray(orders) ? orders : []).forEach(function(order){
        const status = normalizeOrderStatus(order && order.status);
        if(counts[status] !== undefined){
          counts[status] += 1;
        }
      });
      const chips = [
        ["confirmed", "Confirmed"],
        ["packed", "Packed"],
        ["shipped", "Shipped"],
        ["out-for-delivery", "Out for Delivery"],
        ["delivered", "Delivered"],
        ["cancelled", "Cancelled"],
        ["non-delivered", "Non Delivered"],
        ["pending", "Pending"]
      ].filter(function(item){ return counts[item[0]] > 0; });
      if(!chips.length){
        return `<span class="badge">No status</span>`;
      }
      return chips.map(function(item){
        const key = item[0];
        const badgeClass = key === "delivered" ? "green" : (key === "cancelled" || key === "non-delivered" ? "red" : "gold");
        return `<span class="badge ${badgeClass}">${escapeHtml(item[1])}: ${counts[key]}</span>`;
      }).join("");
    }

    function getUsersMap(){
      return {};
    }

    function normalizeOrderItem(rawItem){
      const name = String(getValueByPossibleKeys(rawItem, ["name","productName","title"])).trim() || "Product";
      const size = String(getValueByPossibleKeys(rawItem, ["size","variant","productSize","selectedSize","weight","packSize","unit","weightLabel","quantityLabel"])).trim();
      const quantity = Number(getValueByPossibleKeys(rawItem, ["quantity","qty","count"])) || 1;
      const price = Number(getValueByPossibleKeys(rawItem, ["price","sellingPrice","discountedUnitPrice","displayPrice","amount"])) || 0;
      const mrp = Number(getValueByPossibleKeys(rawItem, ["mrp","originalPrice","mrpPrice"])) || price;
      const discountedLineTotal = Number(getValueByPossibleKeys(rawItem, ["discountedLineTotal","lineTotal","finalLineTotal","total"])) || (price * quantity);
      const displayLineTotal = Number(getValueByPossibleKeys(rawItem, ["displayLineTotal","mrpLineTotal","originalLineTotal"])) || (mrp * quantity);
      const couponLineDiscount = Number(getValueByPossibleKeys(rawItem, ["couponLineDiscount","couponDiscount","lineCouponDiscount"])) || 0;

      return { name, size, quantity, price, mrp, discountedLineTotal, displayLineTotal, couponLineDiscount };
    }

    function extractAmount(raw){
      const directAmount = Number(getValueByPossibleKeys(raw, ["finalAmount","payableAmount","finalTotal","total","amount","totalAmount","paidAmount","grandTotal","paymentAmount"]));
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

    function buildOrderId(raw, sourceKey, index){
      const direct = getValueByPossibleKeys(raw, ["orderId","orderID","id","invoiceId","order_id"]);
      const email = getValueByPossibleKeys(raw, ["email","emailId"]);
      return String(direct || `${sourceKey}_${email || "order"}_${index}`);
    }

    function normalizeOrder(raw, sourceKey, index){
      const id = buildOrderId(raw, sourceKey, index);
      const originalStatus = normalizeOrderStatus(getValueByPossibleKeys(raw, ["orderStatus","status","deliveryStatus"]));
      const status = originalStatus;
      const shippingObj = raw && typeof raw.shipping === "object" ? raw.shipping : {};
      const shiprocketObj = raw && typeof raw.shiprocket === "object" ? raw.shiprocket : {};
      const customerName = String(
        getValueByPossibleKeys(raw, ["name","customerName","fullName","username"]) ||
        getValueByPossibleKeys(shippingObj, ["name","fullName"]) ||
        getValueByPossibleKeys(raw, ["displayName"])
      ).trim() || "Unknown Customer";
      const userIdValue = String(getValueByPossibleKeys(raw, ["userId","uid","customerId"])).trim();
      const email = String(
        getValueByPossibleKeys(raw, ["email","emailId","mail","customerEmail","userEmail"]) ||
        getValueByPossibleKeys(shippingObj, ["email","emailId","mail"]) ||
        (userIdValue.includes("@") ? userIdValue : "")
      ).trim();
      const mobile = String(
        getValueByPossibleKeys(raw, ["mobile","phone","phoneNumber","mobileNumber","contactNumber","customerPhone","customerMobile"]) ||
        getValueByPossibleKeys(shippingObj, ["phone","mobile","phoneNumber","mobileNumber","contactNumber"])
      ).trim();
      const amount = extractAmount(raw);
      const dateRaw = getValueByPossibleKeys(raw, ["createdAt","date","orderedAt","timestamp","time"]);
      const date = parseAnyDate(dateRaw);
      const itemsRaw = raw.items || raw.products || raw.cartItems || [];
      const items = Array.isArray(itemsRaw) ? itemsRaw.map(normalizeOrderItem) : [];
      const shipping = shippingObj;
      const shippingName = String(getValueByPossibleKeys(shipping, ["name","fullName"])).trim() || customerName || (email ? email.split("@")[0] : "Unknown Customer");
      const shippingPhone = String(getValueByPossibleKeys(shipping, ["phone","mobile","contactNumber"])).trim() || mobile;
      const shippingAddress = buildShippingAddress(raw);
      const awb = String(
        getValueByPossibleKeys(raw, ["awb","trackingId","awbCode","awb_code"]) ||
        getValueByPossibleKeys(shiprocketObj, ["awb","trackingId","awbCode","awb_code"])
      ).trim();
      const shipmentId = String(
        getValueByPossibleKeys(raw, ["shipment_id","shipmentId","shiprocketShipmentId"]) ||
        getValueByPossibleKeys(shiprocketObj, ["shipment_id","shipmentId","shiprocketShipmentId"])
      ).trim();
      const courierName = String(
        getValueByPossibleKeys(raw, ["courierName","courier","courier_company_name","courier_name"]) ||
        getValueByPossibleKeys(shiprocketObj, ["courierName","courier","courier_company_name","courier_name"])
      ).trim();
      const shiprocketLabelUrl = String(
        getValueByPossibleKeys(raw, ["shiprocketLabelUrl","labelUrl","label_url","label"]) ||
        getValueByPossibleKeys(shiprocketObj, ["shiprocketLabelUrl","labelUrl","label_url","label"])
      ).trim();
      const trackingUrl = String(
        getValueByPossibleKeys(raw, ["trackingUrl","tracking_url"]) ||
        getValueByPossibleKeys(shiprocketObj, ["trackingUrl","tracking_url"])
      ).trim();
      const trackingStatus = String(
        getValueByPossibleKeys(raw, ["trackingStatus","shipmentStatus","shiprocketStatus","currentStatus","deliveryStatus","status","tracking_status","shipment_status"]) ||
        getValueByPossibleKeys(shiprocketObj, ["trackingStatus","shipmentStatus","shiprocketStatus","currentStatus","deliveryStatus","status","tracking_status","shipment_status"])
      ).trim();
      const refundStatus = String(getValueByPossibleKeys(raw, ["refundStatus","razorpayRefundStatus","razorpayRefundGatewayStatus"])).trim();
      const refundId = String(getValueByPossibleKeys(raw, ["refundId","razorpayRefundId"])).trim();
      const refundAmount = Number(getValueByPossibleKeys(raw, ["refundAmount"])) || 0;
      const deliveryDetails = raw && typeof raw.deliveryDetails === "object"
        ? raw.deliveryDetails
        : (shipping && typeof shipping.deliveryDetails === "object"
          ? shipping.deliveryDetails
          : (raw && typeof raw.delivery === "object" ? raw.delivery : {}));
      const rawDeliveryNumber = typeof raw.delivery === "number" ? raw.delivery : 0;
      const chargedDelivery = Number(deliveryDetails.finalCustomerDeliveryCharge !== undefined ? deliveryDetails.finalCustomerDeliveryCharge : raw.deliveryCharge || rawDeliveryNumber || 0) || 0;
      const actualDelivery = Number(deliveryDetails.finalDeliveryCharge !== undefined ? deliveryDetails.finalDeliveryCharge : raw.deliveryCharge || rawDeliveryNumber || 0) || 0;
      const actualCourierCharge = Number(
        deliveryDetails.lowestCourierCharge ||
        getValueByPossibleKeys(raw, ["lowestCourierCharge","courierCharge","courier_charge","freightCharge","freight_charge","shiprocketCharge"]) ||
        getValueByPossibleKeys(shiprocketObj, ["lowestCourierCharge","courierCharge","courier_charge","freightCharge","freight_charge","shiprocketCharge"]) ||
        0
      ) || 0;

      return {
        id,
        sourceKey,
        status,
        customerName,
        email,
        mobile,
        amount,
        date,
        dateLabel: date ? date.toLocaleString("en-IN") : "-",
        items,
        shippingName,
        shippingPhone,
        shippingAddress,
        awb,
        shipmentId,
        courierName,
        shiprocket: shiprocketObj,
        shiprocketLabelUrl,
        trackingUrl,
        trackingStatus,
        refundStatus,
        refundId,
        refundAmount,
        shipping,
        deliveryDetails,
        deliveryZone: String(deliveryDetails.zone || deliveryDetails.zoneLabel || deliveryDetails.label || "-").trim() || "-",
        chargeableWeight: Number(deliveryDetails.chargeableWeight || 0) || 0,
        lowestCourierCharge: actualCourierCharge,
        customerChargedAmount: chargedDelivery,
        finalDeliveryCharge: actualDelivery,
        freeDeliveryApplied: !!deliveryDetails.freeDeliveryApplied,
        pickupPincode: String(deliveryDetails.pickupPincode || "126102").trim(),
        deliveryPincode: String(deliveryDetails.deliveryPincode || getValueByPossibleKeys(shipping, ["pincode","zip","postalCode"]) || "").trim(),
        searchText: [
          id,
          customerName,
          email,
          mobile,
          ...items.map(item => [item.name, item.size].join(" "))
        ].join(" ").toLowerCase()
      };
    }

    function mergeOrderLists(lists){
      const mergedMap = new Map();
      lists.flat().forEach(function(order){
        if(!order || typeof order !== "object") return;
        const key = String(order.id || "").trim() || [order.email, order.mobile, order.amount, order.dateLabel].join("|");
        const previous = mergedMap.get(key) || {};
        mergedMap.set(key, { ...previous, ...order });
      });
      return Array.from(mergedMap.values());
    }

    function getOrdersFromStorage(){
      if(Array.isArray(firestoreOrdersCache) && firestoreOrdersCache.length){
        return firestoreOrdersCache;
      }
      return [];
    }

    function getSenderDetails(){
      const siteContentApi = window.SWADRA_SITE_CONTENT || {};
      try{
        const saved = typeof siteContentApi.getCached === "function" ? siteContentApi.getCached() : null;
        const contact = saved && typeof saved.contact === "object" ? saved.contact : {};
        return {
          company: String(contact.company || DEFAULT_SENDER_DETAILS.company || "").trim(),
          name: String(contact.name || DEFAULT_SENDER_DETAILS.name || "").trim(),
          phone: String(contact.phone || DEFAULT_SENDER_DETAILS.phone || "").trim(),
          address: String(contact.address || DEFAULT_SENDER_DETAILS.address || "").trim()
        };
      }catch(error){
        return { ...DEFAULT_SENDER_DETAILS };
      }
    }

    function buildLabelQrPayload(order){
      return [
        `Order: ${order.id || ""}`,
        `Shiprocket Shipment: ${order.shipmentId || "-"}`,
        `AWB: ${order.awb || "-"}`,
        `Customer: ${order.shippingName || order.customerName || ""}`,
        `Phone: ${order.shippingPhone || order.mobile || ""}`,
        `Address: ${order.shippingAddress || ""}`
      ].join("\n");
    }

    function openPrintLabel(order){
      if(!order || typeof order !== "object") return;
      const sender = getSenderDetails();
      const qrData = encodeURIComponent(buildLabelQrPayload(order));
      const qrUrl = `https://chart.googleapis.com/chart?cht=qr&chs=180x180&chl=${qrData}`;
      const printWindow = window;

      const shipmentLabel = order.shipmentId || "-";
      const awbLabel = order.awb || "-";
      const courierLabel = order.courierName || "Shiprocket";
      const customerName = order.shippingName || order.customerName || "Customer";
      const customerPhone = order.shippingPhone || order.mobile || "-";
      const customerAddress = order.shippingAddress || "Address not available";
      const senderCompany = sender.company || "Swadra Organics";
      const senderName = sender.name || "Swadra Dispatch";
      const senderPhone = sender.phone || "-";
      const senderAddress = sender.address || "Update sender/company address in admin label defaults.";
      const productSummary = escapeHtml(
        (Array.isArray(order.items) ? order.items : []).map(function(item){
          const itemName = item && item.name ? item.name : "Product";
          const itemSize = item && item.size ? " (" + item.size + ")" : "";
          const itemQty = Number(item && item.quantity ? item.quantity : 1);
          return itemName + itemSize + " x " + itemQty;
        }).join(", ") || "No items"
      );

      printWindow.document.write(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Shipping Label - ${escapeHtml(order.id)}</title>
          <style>
            body{margin:0;padding:24px;font-family:Arial,sans-serif;background:#f7f2ed;color:#1f1f1f}
            .sheet{max-width:900px;margin:0 auto;background:#fff;border:2px solid #2d2d2d;padding:24px}
            .top{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}
            .brand{font-size:28px;font-weight:800;color:#7a3d3d}
            .meta{display:grid;gap:8px;margin-top:16px}
            .meta strong{display:inline-block;min-width:150px}
            .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:20px}
            .box{border:1.5px solid #2d2d2d;padding:16px;min-height:170px}
            .box h3{margin:0 0 10px;font-size:18px}
            .value{font-size:16px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
            .qr{text-align:center}
            .qr img{width:180px;height:180px;object-fit:contain;border:1px solid #ddd;padding:8px;background:#fff}
            .footer{margin-top:18px;border:1.5px dashed #2d2d2d;padding:14px;font-size:14px;line-height:1.7}
            .actions{margin:0 auto 18px;max-width:900px;display:flex;justify-content:flex-end}
            .actions button{background:#7a3d3d;color:#fff;border:none;border-radius:10px;padding:12px 18px;font-weight:700;cursor:pointer}
            @media print{
              body{background:#fff;padding:0}
              .actions{display:none}
              .sheet{border:none;max-width:none;padding:0}
            }
          </style>
        </head>
        <body>
          <div class="actions"><button onclick="window.print()">Print Label</button></div>
          <div class="sheet">
            <div class="top">
              <div>
                <div class="brand">${escapeHtml(senderCompany)}</div>
                <div style="margin-top:8px;font-size:14px;color:#555;">Shiprocket-ready shipping label</div>
                <div class="meta">
                  <div><strong>Order ID:</strong> ${escapeHtml(order.id)}</div>
                  <div><strong>Shipment ID:</strong> ${escapeHtml(shipmentLabel)}</div>
                  <div><strong>AWB / Tracking:</strong> ${escapeHtml(awbLabel)}</div>
                  <div><strong>Courier:</strong> ${escapeHtml(courierLabel)}</div>
                  <div><strong>Date:</strong> ${escapeHtml(order.dateLabel || "-")}</div>
                </div>
              </div>
              <div class="qr">
                <img src="${qrUrl}" alt="Shipping QR">
                <div style="margin-top:8px;font-size:13px;color:#555;">Scan for shipment details</div>
              </div>
            </div>

            <div class="grid">
              <div class="box">
                <h3>Ship To</h3>
                <div class="value"><strong>${escapeHtml(customerName)}</strong>
${escapeHtml(customerPhone)}
${escapeHtml(customerAddress)}</div>
              </div>
              <div class="box">
                <h3>Ship From</h3>
                <div class="value"><strong>${escapeHtml(senderName)}</strong>
${escapeHtml(senderCompany)}
${escapeHtml(senderPhone)}
${escapeHtml(senderAddress)}</div>
              </div>
            </div>

            <div class="footer">
              <div><strong>Products:</strong> ${productSummary}</div>
              <div><strong>Total Amount:</strong> ${escapeHtml(rupee(order.amount))}</div>
            </div>
          </div>
        </body>
        </html>
      `);
      printWindow.document.close();
    }

    function getFilteredOrders(){
      const orders = getOrdersFromStorage();
      const query = normalizeText(document.getElementById("searchInput").value);
      const statusFilter = document.getElementById("statusFilter").value;
      const sortFilter = document.getElementById("sortFilter").value;

      let filtered = orders.filter(order => {
        const queryMatch = !query || order.searchText.includes(query);
        const statusMatch = statusFilter === "all" || order.status === statusFilter;
        return queryMatch && statusMatch;
      });

      filtered.sort((a, b) => {
        if(sortFilter === "oldest"){
          return (a.date ? a.date.getTime() : 0) - (b.date ? b.date.getTime() : 0);
        }
        if(sortFilter === "amount_high"){
          return Number(b.amount || 0) - Number(a.amount || 0);
        }
        if(sortFilter === "amount_low"){
          return Number(a.amount || 0) - Number(b.amount || 0);
        }
        return (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0);
      });

      return filtered;
    }

    function renderStats(allOrders, visibleOrders){
      const deliveredCount = allOrders.filter(item => item.status === "delivered").length;
      const cancelledCount = allOrders.filter(item => item.status === "cancelled").length;
      const activeOrderAmount = allOrders
        .filter(item => ["pending","confirmed","packed","shipped","out-for-delivery"].includes(item.status))
        .reduce((sum, item) => sum + Number(item.amount || 0), 0);
      const totalAmount = allOrders.reduce((sum, item) => sum + Number(item.amount || 0), 0);

      document.getElementById("orderStats").innerHTML = `
        <div class="stat-card">
          <div class="label">Total Orders</div>
          <div class="value">${allOrders.length}</div>
        </div>
        <div class="stat-card">
          <div class="label">Delivered</div>
          <div class="value">${deliveredCount}</div>
        </div>
        <div class="stat-card">
          <div class="label">Active Order Value</div>
          <div class="value">${rupee(activeOrderAmount)}</div>
        </div>
        <div class="stat-card">
          <div class="label">Total Value</div>
          <div class="value">${rupee(totalAmount)}</div>
        </div>
      `;

      setTextIfExists("visibleOrdersView", visibleOrders.length);
      setTextIfExists("deliveredOrdersView", visibleOrders.filter(item => item.status === "delivered").length);
      setTextIfExists("pendingAmountView", rupee(
        visibleOrders
          .filter(item => ["pending","confirmed","packed","shipped","out-for-delivery"].includes(item.status))
          .reduce((sum, item) => sum + Number(item.amount || 0), 0)
      ));
      setTextIfExists("cancelledOrdersView", visibleOrders.filter(item => item.status === "cancelled").length);
    }

    function buildOrderCardHtml(order){
        const statusText = order.cancelledBy === "user" ? "User Cancelled" : orderStatusLabel(order.status);
        const statusClass =
          order.status === "delivered" ? "green" :
          order.status === "cancelled" ? "red" :
          order.status === "non-delivered" ? "red" :
          order.status === "pending" ? "gold" :
          order.status === "packed" ? "gold" :
          order.status === "shipped" ? "gold" :
          order.status === "out-for-delivery" ? "gold" :
          order.status === "confirmed" ? "green" : "";

        const lineItemsHtml = order.items.length
          ? order.items.map(function(item){
              const safeName = escapeHtml(item.name || "Product");
              const safeSize = item.size ? escapeHtml(item.size) : "";
              const safeQty = Number(item.quantity || 1);
              const discountedTotal = Number(item.discountedLineTotal || (Number(item.price || 0) * safeQty) || 0);
              const originalTotal = Number(item.displayLineTotal || 0);
              const couponDiscount = Number(item.couponLineDiscount || 0);
              const showOriginal = originalTotal > discountedTotal;
              const rightHtml = [
                showOriginal ? '<div style="color:#c62828;text-decoration:line-through;font-weight:700;">' + rupee(originalTotal) + '</div>' : '',
                '<div style="font-weight:800;">' + rupee(discountedTotal) + '</div>',
                couponDiscount > 0 ? '<div style="color:#0a7a3d;font-size:13px;font-weight:700;">Coupon -' + rupee(couponDiscount) + '</div>' : ''
              ].join("");
              return [
                '<div class="line-item">',
                  '<div><b>', safeName, '</b>',
                  safeSize ? '<div class="item-meta">Pack size: ' + safeSize + '</div>' : '<div class="item-meta">Pack size: -</div>',
                  '</div>',
                  '<div class="qty-cell">Qty ', safeQty, '</div>',
                  '<div class="price-cell">', rightHtml, '</div>',
                '</div>'
              ].join("");
            }).join("")
          : '<div class="empty">No line items found</div>';

        return `
          <div class="order-card">
            <div class="order-head">
              <div>
                <h3>${escapeHtml(order.customerName)}</h3>
                <div class="badge-wrap">
                  <span class="badge ${statusClass}">${escapeHtml(statusText)}</span>
                  <span class="badge">Order ID: ${escapeHtml(order.id)}</span>
                  <span class="badge gold">Items: ${order.items.length}</span>
                  <span class="badge">Placed: ${escapeHtml(order.dateLabel || "-")}</span>
                </div>
              </div>
              <div class="badge-wrap">
                <span class="badge green">Amount: ${rupee(order.amount)}</span>
              </div>
            </div>

            <div class="order-content">
              <div class="order-main">
                <div>
                  <div class="section-title">Items purchased</div>
                  <div class="line-items">
                    ${lineItemsHtml}
                  </div>
                </div>

                <div>
                  <div class="section-title">Fulfillment status</div>
                  <div class="status-flow">${buildStatusFlow(order.status)}</div>
                </div>

                <div class="card-grid">
                  <div class="mini">
                    <div class="k">Delivery Zone</div>
                    <div class="v">${escapeHtml(order.deliveryZone || "-")}</div>
                  </div>
                  <div class="mini">
                    <div class="k">Chargeable Weight</div>
                    <div class="v">${order.chargeableWeight ? escapeHtml(order.chargeableWeight + " kg") : "-"}</div>
                  </div>
                  <div class="mini">
                    <div class="k">Lowest Courier Charge</div>
                    <div class="v">${order.lowestCourierCharge ? rupee(order.lowestCourierCharge) : "-"}</div>
                  </div>
                  <div class="mini">
                    <div class="k">Customer Charged</div>
                    <div class="v">${rupee(order.customerChargedAmount || 0)}</div>
                  </div>
                </div>
              </div>
              <div class="order-side">
                <div class="ship-block">
                  <div class="section-title">Customer</div>
                  <b>${escapeHtml(order.customerName || "Customer")}</b><br>
                  ${escapeHtml(order.email || "-")}<br>
                  ${escapeHtml(order.mobile || "-")}
                </div>
                <div class="ship-block">
                  <div class="section-title">Shipping</div>
                  ${escapeHtml(order.shippingName || order.customerName || "Customer")}<br>
                  ${escapeHtml(order.shippingPhone || order.mobile || "-")}<br>
                  ${escapeHtml(order.shippingAddress || "Address not available")}<br>
                  <b>Pincode:</b> ${escapeHtml(order.deliveryPincode || "-")}
                </div>
                <div class="ship-block">
                  <div class="section-title">Payment & refund</div>
                  <b>Total:</b> ${rupee(order.amount)}<br>
                  <b>Free Delivery:</b> ${order.freeDeliveryApplied ? "Yes" : "No"}<br>
                  <b>Refund:</b> ${escapeHtml(order.refundStatus || "-")}<br>
                  <b>Refund ID:</b> ${escapeHtml(order.refundId || "-")}<br>
                  <b>Refund Amount:</b> ${order.refundAmount ? rupee(order.refundAmount) : "-"}
                </div>
                <div class="ship-block">
                  <div class="section-title">Dispatch</div>
                  <b>Pickup:</b> ${escapeHtml(order.pickupPincode || "126102")}<br>
                  <b>Status:</b> ${escapeHtml(getShiprocketStatusText(order))}<br>
                  <b>AWB:</b> ${escapeHtml(order.awb || "-")}<br>
                  <b>Courier:</b> ${escapeHtml(order.courierName || "-")}
                </div>
              </div>
            </div>

            <div class="card-actions">
              <button class="btn-secondary" onclick="updateOrderStatus('${escapeHtml(order.id)}','confirmed')">Confirm</button>
              <button class="btn-primary" onclick="updateOrderStatus('${escapeHtml(order.id)}','packed')">Packed</button>
              <button class="btn-primary" onclick="updateOrderStatus('${escapeHtml(order.id)}','shipped')">Shipped</button>
              <button class="btn-secondary" onclick="updateOrderStatus('${escapeHtml(order.id)}','out-for-delivery')">Out for Delivery</button>
              <button class="btn-dark" onclick="updateOrderStatus('${escapeHtml(order.id)}','delivered')">Deliver</button>
              <button class="btn-danger" onclick="updateOrderStatus('${escapeHtml(order.id)}','non-delivered')">Non Delivered</button>
              <button class="btn-danger" onclick="updateOrderStatus('${escapeHtml(order.id)}','cancelled')">Cancel</button>
              <button class="btn-light" onclick="openInvoiceById('${escapeHtml(order.id)}')">View Invoice</button>
              <button class="btn-light" onclick="openPrintLabelById('${escapeHtml(order.id)}')">Print Label</button>
            </div>
          </div>
        `;
    }

    function toggleOrderDetails(orderId){
      const row = document.getElementById("orderDetail_" + String(orderId).replace(/[^a-zA-Z0-9_-]/g, "_"));
      if(!row) return;
      row.classList.toggle("open");
    }

    function getShiprocketStatusText(order){
      const status = String(
        order.trackingStatus ||
        order.shiprocket?.trackingStatus ||
        order.shiprocket?.shipmentStatus ||
        order.shiprocket?.shiprocketStatus ||
        order.shiprocket?.currentStatus ||
        order.shiprocket?.deliveryStatus ||
        order.shiprocket?.status ||
        order.shiprocket?.tracking_status ||
        order.shiprocket?.shipment_status ||
        ""
      ).trim();
      if(status) return status;
      if(order.awb) return "Tracking Created";
      if(order.shipmentId) return "Shipment Created";
      return "-";
    }

    function getShiprocketTrackingText(order){
      return String(
        order.awb ||
        order.shiprocket?.awb ||
        order.shiprocket?.trackingId ||
        order.shiprocket?.awbCode ||
        order.shiprocket?.awb_code ||
        ""
      ).trim() || "-";
    }

    function renderOrders(){
      const allOrders = getOrdersFromStorage();
      const orders = getFilteredOrders();
      const ordersList = document.getElementById("ordersList");

      renderStats(allOrders, orders);

      if(!orders.length){
        ordersList.innerHTML = `<div class="empty">No orders found.</div>`;
        return;
      }

      const groupedOrders = [];
      let activeDateKey = "";
      orders.forEach(function(order){
        const dateKey = getOrderDateKey(order);
        if(!activeDateKey || activeDateKey !== dateKey){
          const dateOrders = orders.filter(function(item){ return getOrderDateKey(item) === dateKey; });
          groupedOrders.push({
            type: "date",
            key: dateKey,
            order,
            orders: dateOrders
          });
          activeDateKey = dateKey;
        }
        groupedOrders.push({ type: "order", order });
      });

      const rowsHtml = groupedOrders.map((entry) => {
        if(entry.type === "date"){
          return `
            <tr class="date-group-row">
              <td colspan="7">
                <div class="date-group-head">
                  <div class="date-group-title">${escapeHtml(getOrderDateHeading(entry.order))}</div>
                  <div class="date-group-status">${buildDateStatusSummary(entry.orders)}</div>
                </div>
              </td>
            </tr>
          `;
        }
        const order = entry.order;
        const rowId = String(order.id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
        const statusClass =
          order.status === "delivered" ? "green" :
          order.status === "cancelled" ? "red" :
          order.status === "non-delivered" ? "red" :
          order.status === "pending" ? "gold" :
          order.status === "packed" ? "gold" :
          order.status === "shipped" ? "gold" :
          order.status === "out-for-delivery" ? "gold" :
          order.status === "confirmed" ? "green" : "";
        const statusText = order.cancelledBy === "user" ? "User Cancelled" : orderStatusLabel(order.status);
        const shiprocketStatus = getShiprocketStatusText(order);
        const shiprocketTracking = getShiprocketTrackingText(order);
        return `
          <tr class="order-main-row">
            <td>
              <div class="order-sheet-id">
                <strong>${escapeHtml(order.id || "-")}</strong>
                <span>${escapeHtml(order.dateLabel || "-")}</span>
              </div>
            </td>
            <td>
              <div class="order-sheet-customer">
                <strong>${escapeHtml(order.customerName || "Customer")}</strong>
                <span>${escapeHtml(order.items.length + " item(s)")}</span>
              </div>
            </td>
            <td>
              <div class="order-sheet-contact">
                <span>${escapeHtml(order.mobile || "-")}</span>
                <span>${escapeHtml(order.email || "-")}</span>
              </div>
            </td>
            <td>
              <div class="order-sheet-shiprocket">
                <strong>${escapeHtml(shiprocketStatus)}</strong>
                <span>Tracking: ${escapeHtml(shiprocketTracking)}</span>
                ${order.courierName ? `<span>${escapeHtml(order.courierName)}</span>` : ""}
              </div>
            </td>
            <td><span class="badge ${statusClass}">${escapeHtml(statusText)}</span></td>
            <td class="order-sheet-amount">${rupee(order.amount)}</td>
            <td>
              <button class="btn-light" onclick="toggleOrderDetails('${escapeHtml(order.id)}')">View More</button>
            </td>
          </tr>
          <tr class="order-detail-row" id="orderDetail_${escapeHtml(rowId)}">
            <td colspan="7">${buildOrderCardHtml(order)}</td>
          </tr>
        `;
      }).join("");

      ordersList.innerHTML = `
        <div class="orders-sheet-wrap">
          <table class="orders-sheet">
            <thead>
              <tr>
                <th>Order ID</th>
                <th>Customer</th>
                <th>Mobile / Email</th>
                <th>Shiprocket</th>
                <th>Status</th>
                <th>Paid Amount</th>
                <th>View More</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      `;
    }

    function openPrintLabelById(orderId){
      const order = getOrdersFromStorage().find(function(item){
        return String(item.id) === String(orderId);
      });
      if(!order){
        alert("Order not found.");
        return;
      }
      const liveShiprocketLabel = String(order.shiprocketLabelUrl || order.shiprocket?.label_url || "").trim();
      if(liveShiprocketLabel){
        window.location.href = liveShiprocketLabel;
        return;
      }
      openPrintLabel(order);
    }

    function openInvoiceById(orderId){
      if(!orderId) return;
      window.location.href = "invoice.html?orderId=" + encodeURIComponent(String(orderId));
    }

    async function updateOrderStatus(orderId, nextStatus){
      const order = getOrdersFromStorage().find(function(item){
        return String(item.id) === String(orderId);
      });
      if(!order){
        renderOrders();
        return;
      }

      const nextOrder = {
        ...order,
        status: nextStatus,
        orderStatus: nextStatus,
        updatedAt: new Date().toISOString()
      };

      const isPacked = String(nextStatus || "").toLowerCase() === "packed";
      if(isPacked && window.SWADRA_API_BASE){
        try{
          const response = await fetch(String(window.SWADRA_API_BASE || "") + "/api/orders/" + encodeURIComponent(String(orderId)) + "/packed", {
            method: "POST",
            headers: getAdminFetchHeaders({ "Content-Type": "application/json" })
          });
          const data = await response.json().catch(function(){ return {}; });
          if(!response.ok || !data.ok){
            alert(data.error || "Packed sync failed");
            return;
          }
          await refreshOrders();
          return;
        }catch(error){
          console.error("packed shiprocket sync failed", error);
          alert("Packed sync failed.");
          return;
        }
      }

      if(window.SWADRA_API_BASE){
        try{
          const response = await fetch(String(window.SWADRA_API_BASE || "") + "/api/orders/" + encodeURIComponent(String(orderId)) + "/status", {
            method: "PATCH",
            headers: getAdminFetchHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ status: nextStatus, note: "Updated by admin." })
          });
          const data = await response.json().catch(function(){ return {}; });
          if(!response.ok || !data.ok){
            alert(data.error || "Order status update failed.");
            return;
          }
          await refreshOrders();
          return;
        }catch(error){
          console.error("backend order status update failed", error);
          alert("Order status update failed.");
          return;
        }
      }

      renderOrders();
    }

    function clearFilters(){
      document.getElementById("searchInput").value = "";
      document.getElementById("statusFilter").value = "all";
      document.getElementById("sortFilter").value = "newest";
      renderOrders();
    }

    async function refreshOrders(){
      const orderLists = [];

      if(window.SWADRA_API_BASE){
        try{
          const response = await fetch(String(window.SWADRA_API_BASE || "") + "/api/orders", {
            method: "GET",
            cache: "no-store",
            credentials: "include",
            headers: getAdminFetchHeaders({ "Accept": "application/json" })
          });
          const data = await response.json().catch(function(){ return {}; });
          const backendOrders = Array.isArray(data) ? data : (Array.isArray(data.orders) ? data.orders : []);
          orderLists.push(backendOrders.map(function(item, index){
            return normalizeOrder(item, "backend", index);
          }));
        }catch(error){
          console.error("backend orders fetch failed", error);
        }
      }

      firestoreOrdersCache = mergeOrderLists(orderLists);
      renderOrders();
    }

    refreshOrders();
  
