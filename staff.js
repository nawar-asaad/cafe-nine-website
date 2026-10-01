// Shared logic for the cashier and manager pages.
// Each page calls Staff.init({ page, allowedRoles, onReady, views }).

(function () {
  const SUPABASE_URL = "https://esvvealfrdvfmwmyeyed.supabase.co";
  const SUPABASE_KEY = "sb_publishable_22734JdUdH_lzfoyebadsw_OlegCH9K";

  const STATUS_AR = { new: "جديد", confirmed: "مؤكد", preparing: "قيد التحضير", ready: "جاهز", delivered: "تم التسليم", cancelled: "ملغى" };
  const ACTIVE = ["new", "confirmed", "preparing", "ready"];
  const NEXT = {
    new: ["confirmed", "✓ تأكيد الطلب"],
    confirmed: ["preparing", "☕ بدء التحضير"],
    preparing: ["ready", "🔔 جاهز للتسليم"],
    ready: ["delivered", "✅ تم التسليم"]
  };
  const CATEGORIES = [
    ["frappe", "فرابيه"], ["mojito", "موهيتو"], ["smoothie", "سموذي"], ["bakery", "مخبوزات"], ["desserts", "حلويات"],
    ["juice", "عصائر"], ["hot", "مشروبات ساخنة"], ["cold", "مشروبات باردة"], ["tea", "شاي"], ["addons", "إضافات"]
  ];
  const ROLE_AR = { manager: "مدير الكافيه", cashier: "الكاشير" };

  const $ = sel => document.querySelector(sel);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }
  function safeUrl(value) {
    return /^https:\/\//i.test(String(value || "")) ? escapeHtml(value) : "";
  }
  function toNumber(value) {
    return Number(String(value ?? 0).replace(/[^0-9.-]/g, "")) || 0;
  }
  function formatMoney(value) {
    return toNumber(value).toLocaleString("en-US") + " IQD";
  }
  function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  const state = {
    cfg: null,
    db: null,
    role: null,
    email: "",
    orders: [],
    tables: [],
    menu: [],
    orderType: "all",
    activeOnly: false,
    tableFilter: null,
    editingFloor: false,
    lastOrderId: null,
    freshIds: new Set()
  };

  // ---------- Navigation between views ----------
  function showView(name) {
    const views = state.cfg.views;
    if (!views.includes(name)) name = views[0];
    views.forEach(v => {
      const el = document.getElementById("view-" + v);
      if (el) el.classList.toggle("hidden", v !== name);
    });
    document.querySelectorAll(".nav-btn[data-view]").forEach(btn => btn.classList.toggle("active", btn.dataset.view === name));
    if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
    if (state.cfg.onView) state.cfg.onView(name);
  }

  // ---------- Toast & alerts ----------
  let toastTimer = null;
  function showToast(text) {
    const toast = $("#toast");
    toast.textContent = text;
    toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), 8000);
  }

  let audioCtx = null;
  function unlockAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!audioCtx && AC) audioCtx = new AC();
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  }
  document.addEventListener("click", unlockAudio);

  function playChime() {
    unlockAudio();
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    [[880, 0], [1318.5, 0.18]].forEach(([freq, delay]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.18, t + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.6);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 0.65);
    });
  }

  function updateAlertsButton() {
    const btn = $("#alertsBtn");
    if (!btn) return;
    const granted = "Notification" in window && Notification.permission === "granted";
    btn.classList.toggle("on", granted);
    if (!("Notification" in window)) btn.textContent = "🔔 تنبيه صوتي فقط";
    else if (granted) btn.textContent = "🔔 التنبيهات مفعّلة";
    else if (Notification.permission === "denied") btn.textContent = "🔕 الإشعارات محظورة";
    else btn.textContent = "🔔 تفعيل التنبيهات";
  }

  const baseTitle = document.title;
  let unseen = 0;
  function clearUnseen() {
    unseen = 0;
    document.title = baseTitle;
  }
  window.addEventListener("focus", clearUnseen);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) clearUnseen(); });

  function orderLabel(order) {
    return order.order_type === "table" ? `على طاولة ${order.table_number}` : `أونلاين من ${order.customer_name || "زبون"}`;
  }

  function notifyNewOrders(orders) {
    playChime();
    const first = orders[0];
    showToast(orders.length === 1
      ? `🔔 طلب جديد ${orderLabel(first)} — ${formatMoney(first.total)}`
      : `🔔 وصلت ${orders.length} طلبات جديدة`);
    if (document.hidden || !document.hasFocus()) {
      unseen += orders.length;
      document.title = `(${unseen}) طلب جديد — ${baseTitle}`;
    }
    if ("Notification" in window && Notification.permission === "granted") {
      orders.forEach(order => {
        const n = new Notification(order.order_type === "table" ? `🍽️ طلب طاولة ${order.table_number} — Café Nine` : "🛵 طلب أونلاين — Café Nine", {
          body: `${orderLabel(order)} • ${formatMoney(order.total)}`,
          tag: "order-" + order.id,
          icon: "logo.svg",
          requireInteraction: true
        });
        n.onclick = () => { window.focus(); showView("orders"); n.close(); };
      });
    }
  }

  // ---------- Orders ----------
  async function loadOrders() {
    // Recent orders (48h) plus anything still open, however old
    const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const { data, error } = await state.db
      .from("orders")
      .select("*")
      .or(`created_at.gte."${since}",status.in.(new,confirmed,preparing,ready)`)
      .order("created_at", { ascending: false })
      .limit(400);

    if (error) {
      $("#ordersList").innerHTML = '<div class="alert error">تعذر تحميل الطلبات.</div>';
      return;
    }

    const items = data || [];
    const maxId = items.reduce((max, order) => Math.max(max, Number(order.id) || 0), 0);
    if (state.lastOrderId !== null) {
      const fresh = items.filter(order => Number(order.id) > state.lastOrderId && (order.status || "new") === "new");
      fresh.forEach(order => state.freshIds.add(String(order.id)));
      if (fresh.length) notifyNewOrders(fresh);
    }
    state.lastOrderId = Math.max(state.lastOrderId ?? 0, maxId);
    state.orders = items;

    renderCounts();
    renderOrders();
    renderFloor();
    if (state.cfg.onOrders) state.cfg.onOrders(items);
  }

  function renderCounts() {
    const today = startOfToday();
    const counts = { new: 0, confirmed: 0, preparing: 0, ready: 0, delivered: 0 };
    state.orders.forEach(order => {
      const st = order.status || "new";
      if (ACTIVE.includes(st) || new Date(order.created_at) >= today) counts[st] = (counts[st] || 0) + 1;
    });
    Object.keys(counts).forEach(key => {
      const el = document.getElementById(key + "Count");
      if (el) el.textContent = counts[key];
    });
    const activeCount = counts.new + counts.confirmed + counts.preparing + counts.ready;
    const pill = $("#ordersPill");
    if (pill) {
      pill.textContent = activeCount;
      pill.classList.toggle("hidden", !activeCount);
    }
  }

  function visibleOrders() {
    return state.orders
      .filter(order => state.orderType === "all" || (state.orderType === "table") === (order.order_type === "table"))
      .filter(order => !state.activeOnly || ACTIVE.includes(order.status || "new"))
      .filter(order => state.tableFilter === null || order.table_number === state.tableFilter)
      .sort((a, b) => {
        const aActive = ACTIVE.includes(a.status || "new"), bActive = ACTIVE.includes(b.status || "new");
        if (aActive !== bActive) return aActive ? -1 : 1;
        return new Date(b.created_at) - new Date(a.created_at);
      });
  }

  function renderOrders() {
    const note = $("#tableFilterNote");
    if (state.tableFilter === null) note.classList.add("hidden");
    else {
      note.classList.remove("hidden");
      note.innerHTML = `<span>عرض طلبات طاولة ${state.tableFilter} فقط</span><button type="button" class="small-btn" data-clear-table>عرض كل الطلبات</button>`;
    }

    const items = visibleOrders();
    $("#ordersList").innerHTML = items.length
      ? items.map(order => {
          const st = order.status || "new";
          const isTable = order.order_type === "table";
          const next = NEXT[st];
          const time = new Date(order.created_at).toLocaleTimeString("ar-IQ", { hour: "numeric", minute: "2-digit" });
          const day = new Date(order.created_at) < startOfToday() ? " — " + new Date(order.created_at).toLocaleDateString("ar-IQ") : "";
          return `
          <div class="order-item${state.freshIds.has(String(order.id)) && st === "new" ? " fresh" : ""}${ACTIVE.includes(st) ? "" : " done"}">
            <div class="order-head">
              <div>
                <h3>${isTable
                  ? `<span class="type-badge table">🍽️ طاولة ${escapeHtml(order.table_number)}</span>`
                  : `<span class="type-badge online">🛵 أونلاين</span> ${escapeHtml(order.customer_name)}`}<span class="st st-${st}">${STATUS_AR[st] || st}</span></h3>
                <div class="order-meta" style="margin-top:6px;">#${escapeHtml(order.id)} • ${time}${day}${isTable ? "" : " • " + escapeHtml(order.customer_phone)}</div>
              </div>
              <select class="status-select" data-order-id="${escapeHtml(order.id)}" aria-label="حالة الطلب">
                ${Object.keys(STATUS_AR).map(key => `<option value="${key}" ${st === key ? "selected" : ""}>${STATUS_AR[key]}</option>`).join("")}
              </select>
            </div>
            ${isTable ? "" : `<div class="order-meta">العنوان: ${escapeHtml(order.address || "غير محدد")}</div>`}
            ${!isTable && safeUrl(order.map_url) ? `<div class="order-meta" style="margin-top:4px;"><a href="${safeUrl(order.map_url)}" target="_blank" rel="noopener" style="color:var(--green);font-weight:700">📍 فتح موقع الزبون</a></div>` : ""}
            <ul class="item-list">
              ${(order.items || []).map(item => `<li>${escapeHtml(item.name)} × ${escapeHtml(item.quantity)} — ${formatMoney(item.subtotal || item.unit_price * item.quantity)}</li>`).join("")}
            </ul>
            ${order.notes ? `<div class="order-meta">📝 ${escapeHtml(order.notes)}</div>` : ""}
            <div class="order-meta" style="margin-top:6px;">الإجمالي: <strong style="color:var(--dark);font-size:15px">${formatMoney(order.total)}</strong></div>
            ${next ? `<button type="button" class="next-btn" data-next="${next[0]}" data-order-id="${escapeHtml(order.id)}">${next[1]}</button>` : ""}
          </div>`;
        }).join("")
      : `<div class="empty">${state.tableFilter !== null ? "لا توجد طلبات لهذه الطاولة." : "لا توجد طلبات هنا حاليًا."}</div>`;
  }

  async function setStatus(orderId, status) {
    const { error } = await state.db.from("orders").update({ status }).eq("id", orderId);
    if (error) {
      alert("تعذر تحديث حالة الطلب.");
      return;
    }
    await loadOrders();
  }

  // ---------- Floor plan ----------
  async function loadTables() {
    const { data, error } = await state.db.from("cafe_tables").select("number,pos_x,pos_y").order("number");
    if (!error) state.tables = data || [];
    renderFloor();
  }

  function renderFloor() {
    const floor = $("#floor");
    if (!floor) return;
    floor.querySelectorAll(".tbl").forEach(el => el.remove());
    state.tables.forEach(t => {
      const active = state.orders.filter(order => order.table_number === t.number && ACTIVE.includes(order.status || "new"));
      const status = ACTIVE.find(st => active.some(order => (order.status || "new") === st));
      const sum = active.reduce((acc, order) => acc + toNumber(order.total), 0);
      const el = document.createElement("div");
      el.className = "tbl" + (status ? " st-" + status : "") + (state.tableFilter === t.number ? " selected" : "");
      el.style.left = t.pos_x + "%";
      el.style.top = t.pos_y + "%";
      el.dataset.table = t.number;
      el.title = `طاولة ${t.number}`;
      el.innerHTML = `<div><strong>${t.number}</strong><span>${status ? (status === "new" ? "طلب جديد" : STATUS_AR[status]) : "فارغة"}</span>${active.length ? `<span>${active.length} طلب • ${formatMoney(sum)}</span>` : ""}</div>`;
      floor.appendChild(el);
    });
  }

  function setupFloor() {
    const floor = $("#floor");
    if (!floor) return;
    let drag = null;
    floor.addEventListener("pointerdown", event => {
      const el = event.target.closest(".tbl");
      if (!el) return;
      if (!state.editingFloor) {
        const n = Number(el.dataset.table);
        state.tableFilter = state.tableFilter === n ? null : n;
        renderOrders();
        renderFloor();
        return;
      }
      drag = el;
      el.setPointerCapture(event.pointerId);
    });
    floor.addEventListener("pointermove", event => {
      if (!drag) return;
      const box = floor.getBoundingClientRect();
      const x = Math.min(95, Math.max(5, (event.clientX - box.left) / box.width * 100));
      const y = Math.min(90, Math.max(10, (event.clientY - box.top) / box.height * 100));
      drag.style.left = x + "%";
      drag.style.top = y + "%";
      const t = state.tables.find(t => t.number === Number(drag.dataset.table));
      t.pos_x = Math.round(x * 10) / 10;
      t.pos_y = Math.round(y * 10) / 10;
    });
    floor.addEventListener("pointerup", () => { drag = null; });

    const editBtn = $("#editFloor");
    if (!editBtn) return;
    editBtn.addEventListener("click", async () => {
      if (!state.editingFloor) {
        state.editingFloor = true;
        floor.classList.add("editing");
        editBtn.textContent = "💾 حفظ الترتيب";
        editBtn.classList.remove("secondary");
        return;
      }
      editBtn.disabled = true;
      const results = await Promise.all(state.tables.map(t =>
        state.db.from("cafe_tables").update({ pos_x: t.pos_x, pos_y: t.pos_y }).eq("number", t.number)
      ));
      editBtn.disabled = false;
      if (results.some(r => r.error)) {
        alert("تعذر حفظ ترتيب الطاولات.");
        return;
      }
      state.editingFloor = false;
      floor.classList.remove("editing");
      editBtn.textContent = "✏️ ترتيب الطاولات";
      editBtn.classList.add("secondary");
      showToast("✓ تم حفظ ترتيب الطاولات");
    });
  }

  // ---------- Menu ----------
  async function loadMenu() {
    const { data, error } = await state.db.from("menu_items").select("*").order("category").order("id");
    if (error) {
      state.menu = [];
      return false;
    }
    state.menu = data || [];
    return true;
  }

  function categoryName(key) {
    const found = CATEGORIES.find(c => c[0] === key);
    return found ? found[1] : (key || "بدون قسم");
  }

  // Read-only grouped menu with prices (cashier view)
  function renderMenuReadOnly(container, query, category) {
    const q = (query || "").trim().toLowerCase();
    const list = state.menu.filter(item =>
      (!category || item.category === category) &&
      (!q || String(item.arabic || "").toLowerCase().includes(q) || String(item.english || "").toLowerCase().includes(q)));
    if (!list.length) {
      container.innerHTML = '<div class="empty">لا توجد أصناف مطابقة.</div>';
      return;
    }
    const groups = CATEGORIES.map(c => c[0]).concat([...new Set(list.map(i => i.category))].filter(k => !CATEGORIES.some(c => c[0] === k)));
    container.innerHTML = groups.map(key => {
      const rows = list.filter(i => i.category === key);
      if (!rows.length) return "";
      return `<div class="menu-group"><h3>${escapeHtml(categoryName(key))} <span class="order-meta">(${rows.length})</span></h3>
        <div class="menu-grid">${rows.map(item => `
          <div class="menu-row"><div><strong>${escapeHtml(item.arabic)}</strong><small>${escapeHtml(item.english || "")}</small></div><div class="price">${formatMoney(item.price)}</div></div>`).join("")}
        </div></div>`;
    }).join("");
  }

  // ---------- Live updates ----------
  let channel = null, pollTimer = null;
  function startLive() {
    stopLive();
    channel = state.db.channel("orders-feed-" + state.cfg.page)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => loadOrders())
      .subscribe();
    pollTimer = setInterval(loadOrders, 30000);
  }
  function stopLive() {
    if (channel) state.db.removeChannel(channel);
    channel = null;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // ---------- Auth ----------
  function showLogin(message, isInfo) {
    $("#appView").classList.add("hidden");
    $("#loginView").classList.remove("hidden");
    const box = $("#loginError");
    if (message) {
      box.className = "alert " + (isInfo ? "info" : "error");
      box.innerHTML = message;
    } else box.className = "alert error hidden";
  }

  async function enter(session) {
    const { data, error } = await state.db.from("admin_users").select("role").eq("user_id", session.user.id).maybeSingle();
    if (error || !data) {
      await state.db.auth.signOut();
      showLogin("هذا الحساب ليس له صلاحية دخول.");
      return;
    }
    if (!state.cfg.allowedRoles.includes(data.role)) {
      await state.db.auth.signOut();
      showLogin(state.cfg.wrongRoleMessage(data.role));
      return;
    }
    state.role = data.role;
    state.email = session.user.email || "";
    $("#loginView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
    const who = $("#whoAmI");
    if (who) who.textContent = `${ROLE_AR[state.role]} • ${state.email}`;
    showView(location.hash.slice(1));
    await Promise.all([loadOrders(), loadTables(), loadMenu()]);
    if (state.cfg.onReady) await state.cfg.onReady();
    startLive();
  }

  function init(cfg) {
    state.cfg = cfg;
    // Separate login per page so the cashier and the manager can be signed in on the same computer
    state.db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { storageKey: "cafe-nine-" + cfg.page } });

    $("#loginForm").addEventListener("submit", async event => {
      event.preventDefault();
      const btn = event.target.querySelector("button[type=submit]");
      btn.disabled = true;
      const { data, error } = await state.db.auth.signInWithPassword({
        email: $("#email").value.trim(),
        password: $("#password").value
      });
      btn.disabled = false;
      if (error) {
        showLogin("البريد أو كلمة المرور غير صحيحة.");
        return;
      }
      $("#password").value = "";
      await enter(data.session);
    });

    $("#logoutBtn").addEventListener("click", async () => {
      stopLive();
      state.lastOrderId = null;
      await state.db.auth.signOut();
      showLogin("تم تسجيل الخروج.", true);
    });

    $("#alertsBtn").addEventListener("click", async () => {
      unlockAudio();
      if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
      updateAlertsButton();
      playChime();
    });
    updateAlertsButton();

    document.querySelectorAll(".nav-btn[data-view]").forEach(btn => btn.addEventListener("click", () => showView(btn.dataset.view)));
    window.addEventListener("hashchange", () => showView(location.hash.slice(1)));

    $("#orderTypeSeg").addEventListener("click", event => {
      const btn = event.target.closest("button[data-type]");
      if (!btn) return;
      state.orderType = btn.dataset.type;
      document.querySelectorAll("#orderTypeSeg button").forEach(b => b.classList.toggle("active", b === btn));
      renderOrders();
    });
    $("#activeOnly").addEventListener("change", event => {
      state.activeOnly = event.target.checked;
      renderOrders();
    });
    $("#refreshOrders").addEventListener("click", loadOrders);
    $("#tableFilterNote").addEventListener("click", event => {
      if (!event.target.closest("[data-clear-table]")) return;
      state.tableFilter = null;
      renderOrders();
      renderFloor();
    });
    $("#ordersList").addEventListener("change", event => {
      const sel = event.target.closest(".status-select");
      if (sel) setStatus(sel.dataset.orderId, sel.value);
    });
    $("#ordersList").addEventListener("click", event => {
      const btn = event.target.closest("[data-next]");
      if (!btn) return;
      btn.disabled = true;
      setStatus(btn.dataset.orderId, btn.dataset.next);
    });
    setupFloor();

    state.db.auth.getSession().then(({ data }) => {
      if (data.session) enter(data.session);
      else showLogin();
    });
  }

  window.Staff = {
    init, state, loadOrders, loadMenu, loadTables, renderMenuReadOnly, showToast, showView,
    escapeHtml, formatMoney, toNumber, categoryName, CATEGORIES, STATUS_AR, ACTIVE, startOfToday
  };
})();
