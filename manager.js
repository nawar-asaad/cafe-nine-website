// Manager page: sales statistics and menu editing (orders/tables come from staff.js)

(function () {
  const S = window.Staff;
  const { escapeHtml, formatMoney, toNumber, startOfToday } = S;
  const $ = sel => document.querySelector(sel);
  const DAY = 24 * 3600 * 1000;

  let orderHistory = [];       // orders of the last ~61 days (for statistics)
  let period = "day";

  // ---------- Data ----------
  async function loadHistory() {
    const since = new Date(startOfToday().getTime() - 61 * DAY).toISOString();
    const { data, error } = await S.state.db
      .from("orders")
      .select("id,created_at,total,status,order_type,items")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(10000);
    if (!error) orderHistory = data || [];
  }

  function range(p) {
    const today = startOfToday();
    const now = new Date();
    if (p === "day") return { start: today, end: now, prevStart: new Date(today - DAY), prevEnd: new Date(now - DAY), prevName: "بنفس الوقت أمس", days: 1 };
    const days = p === "week" ? 7 : 30;
    const start = new Date(today - (days - 1) * DAY);
    return { start, end: now, prevStart: new Date(start - days * DAY), prevEnd: start, prevName: `بالـ ${days} يومًا السابقة`, days };
  }

  const counted = o => (o.status || "new") !== "cancelled";
  const inRange = (o, a, b) => { const t = new Date(o.created_at); return t >= a && t < b; };

  function summarize(list) {
    const sales = list.reduce((s, o) => s + toNumber(o.total), 0);
    const online = list.filter(o => o.order_type !== "table").length;
    return { sales, count: list.length, avg: list.length ? sales / list.length : 0, online, table: list.length - online };
  }

  // ---------- Formatting ----------
  function compact(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(v % 1e6 ? 1 : 0).replace(/\.0$/, "") + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(v % 1e3 ? 1 : 0).replace(/\.0$/, "") + "K";
    return String(Math.round(v));
  }

  function deltaHtml(cur, prev, name) {
    if (!prev) return cur ? `لا توجد بيانات ${name} للمقارنة` : "";
    const pct = Math.round((cur - prev) / prev * 100);
    if (pct === 0) return `بدون تغيير ${name}`;
    return `<b class="${pct > 0 ? "up" : "down"}">${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}%</b> ${name}`;
  }

  // ---------- Charts (inline SVG, single series) ----------
  function niceTicks(max, count) {
    const raw = max / count;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / pow;
    const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * pow;
    const ticks = [];
    for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
    if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
    return ticks;
  }

  function roundTop(x, y, w, h, r) {
    return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
  }

  function columnChart(el, data, label, fmtAxis) {
    const max = Math.max(0, ...data.map(d => d.value));
    if (!max) {
      el.innerHTML = '<div class="chart-empty">لا توجد بيانات في هذه الفترة</div>';
      return;
    }
    const W = Math.max(280, el.clientWidth || 600), H = 240, padL = 48, padR = 6, padT = 10, padB = 26;
    const ticks = niceTicks(max, 4), top = ticks[ticks.length - 1];
    const iw = W - padL - padR, ih = H - padT - padB, band = iw / data.length, bw = Math.max(3, Math.min(24, band * 0.68));
    const y = v => padT + ih - (v / top) * ih;
    const every = Math.ceil(data.length / Math.max(4, Math.floor(iw / 46)));
    let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${escapeHtml(label)}" style="direction:ltr">`;
    ticks.forEach(t => {
      s += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/>`;
      s += `<text class="axis-text" x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${fmtAxis(t)}</text>`;
    });
    data.forEach((d, i) => {
      const cx = padL + band * i + band / 2, yy = y(d.value), h = padT + ih - yy;
      s += `<rect class="hit" x="${padL + band * i}" y="${padT}" width="${band}" height="${ih}" data-i="${i}"/>`;
      if (h > 0.5) s += `<path class="bar" data-bar="${i}" pointer-events="none" d="${roundTop(cx - bw / 2, yy, bw, h, Math.min(4, h, bw / 2))}"/>`;
      if (i % every === 0) s += `<text class="axis-text" x="${cx}" y="${H - 8}" text-anchor="middle">${escapeHtml(d.label)}</text>`;
    });
    s += "</svg>";
    el.innerHTML = s + '<div class="tip hidden"></div>';

    const tip = el.querySelector(".tip");
    const svg = el.querySelector("svg");
    svg.addEventListener("mousemove", event => {
      const hit = event.target.closest(".hit");
      el.querySelectorAll(".bar.hover").forEach(b => b.classList.remove("hover"));
      if (!hit) { tip.classList.add("hidden"); return; }
      const i = Number(hit.dataset.i), d = data[i];
      const bar = el.querySelector(`[data-bar="${i}"]`);
      if (bar) bar.classList.add("hover");
      const scale = svg.getBoundingClientRect().width / W;
      tip.innerHTML = d.tip;
      tip.style.left = (padL + band * i + band / 2) * scale + "px";
      tip.style.top = Math.max(y(d.value), padT + 20) * scale + "px";
      tip.classList.remove("hidden");
    });
    svg.addEventListener("mouseleave", () => {
      tip.classList.add("hidden");
      el.querySelectorAll(".bar.hover").forEach(b => b.classList.remove("hover"));
    });
  }

  // ---------- Statistics ----------
  function renderStats() {
    if (!S.state.role) return;
    const r = range(period);
    const cur = orderHistory.filter(o => counted(o) && inRange(o, r.start, r.end));
    const prev = orderHistory.filter(o => counted(o) && inRange(o, r.prevStart, r.prevEnd));
    const a = summarize(cur), b = summarize(prev);

    $("#kSales").textContent = formatMoney(a.sales);
    $("#kSalesDelta").innerHTML = deltaHtml(a.sales, b.sales, r.prevName);
    $("#kOrders").textContent = a.count.toLocaleString("en-US");
    $("#kOrdersDelta").innerHTML = deltaHtml(a.count, b.count, r.prevName);
    $("#kAvg").textContent = formatMoney(Math.round(a.avg));
    $("#kAvgDelta").innerHTML = deltaHtml(a.avg, b.avg, r.prevName);
    $("#kOnline").textContent = a.online.toLocaleString("en-US");
    $("#kTable").textContent = a.table.toLocaleString("en-US");
    $("#kOnlineShare").textContent = a.count ? `${Math.round(a.online / a.count * 100)}% من الطلبات` : "";
    $("#kTableShare").textContent = a.count ? `${Math.round(a.table / a.count * 100)}% من الطلبات` : "";
    const cancelled = orderHistory.filter(o => (o.status || "") === "cancelled" && inRange(o, r.start, r.end)).length;
    $("#periodLabel").textContent = `من ${r.start.toLocaleDateString("ar-IQ")} حتى الآن — المبيعات لا تشمل الطلبات الملغاة${cancelled ? ` (${cancelled} ملغى)` : ""}`;

    // Sales over time: by hour today, by day otherwise
    let buckets;
    if (period === "day") {
      buckets = Array.from({ length: 24 }, (_, h) => ({ label: String(h), value: 0, n: 0, key: h }));
      cur.forEach(o => { const b = buckets[new Date(o.created_at).getHours()]; b.value += toNumber(o.total); b.n++; });
      buckets.forEach(b => { b.tip = `الساعة ${b.key}:00 — <b>${formatMoney(b.value)}</b> • ${b.n} طلب`; });
      $("#salesChartTitle").textContent = "المبيعات حسب الساعة (اليوم)";
    } else {
      buckets = Array.from({ length: r.days }, (_, i) => {
        const d = new Date(r.start.getTime() + i * DAY);
        return { label: `${d.getDate()}/${d.getMonth() + 1}`, value: 0, n: 0, date: d };
      });
      cur.forEach(o => {
        const i = Math.floor((new Date(o.created_at) - r.start) / DAY);
        if (buckets[i]) { buckets[i].value += toNumber(o.total); buckets[i].n++; }
      });
      buckets.forEach(b => { b.tip = `${b.date.toLocaleDateString("ar-IQ", { weekday: "long", day: "numeric", month: "numeric" })} — <b>${formatMoney(b.value)}</b> • ${b.n} طلب`; });
      $("#salesChartTitle").textContent = "المبيعات اليومية";
    }
    columnChart($("#salesChart"), buckets, "المبيعات", compact);
    $("#salesTable").innerHTML = `<table><tr><th>${period === "day" ? "الساعة" : "اليوم"}</th><th>الطلبات</th><th>المبيعات</th></tr>${
      buckets.filter(b => b.n).map(b => `<tr><td>${period === "day" ? b.key + ":00" : b.label}</td><td>${b.n}</td><td>${formatMoney(b.value)}</td></tr>`).join("") || '<tr><td colspan="3">لا توجد بيانات</td></tr>'}</table>`;

    // Peak hours (order count by hour of day)
    const hours = Array.from({ length: 24 }, (_, h) => ({ label: String(h), value: 0, key: h }));
    cur.forEach(o => { hours[new Date(o.created_at).getHours()].value++; });
    hours.forEach(h => { h.tip = `الساعة ${h.key}:00 — <b>${h.value}</b> طلب`; });
    columnChart($("#hoursChart"), hours, "أوقات الذروة", v => String(Math.round(v * 10) / 10));

    // Item popularity
    const stats = new Map();
    cur.forEach(o => (o.items || []).forEach(item => {
      const key = item.id != null ? String(item.id) : "name:" + item.name;
      const s = stats.get(key) || { name: item.name, qty: 0, revenue: 0 };
      const q = toNumber(item.quantity) || 1;
      s.qty += q;
      s.revenue += toNumber(item.subtotal) || toNumber(item.unit_price) * q;
      stats.set(key, s);
    }));
    const ranked = [...stats.values()].sort((x, y) => y.qty - x.qty || y.revenue - x.revenue);
    const topMax = ranked.length ? ranked[0].qty : 0;
    $("#topItems").innerHTML = ranked.length
      ? ranked.slice(0, 8).map(s => `
        <div class="hbar" title="${escapeHtml(s.name)}: ${s.qty} — ${formatMoney(s.revenue)}">
          <div class="name">${escapeHtml(s.name)}</div>
          <div class="track"><div class="fill" style="width:${Math.max(2, s.qty / topMax * 72)}%"></div><span class="v">${s.qty} • ${compact(s.revenue)}</span></div>
        </div>`).join("")
      : '<div class="chart-empty">لا توجد طلبات في هذه الفترة</div>';

    // Items that were not ordered / ordered least
    const menu = S.state.menu;
    if (!cur.length) {
      $("#slowItems").innerHTML = '<div class="chart-empty">لا توجد طلبات في هذه الفترة للمقارنة</div>';
      return;
    }
    const qtyOf = item => (stats.get(String(item.id)) || stats.get("name:" + item.arabic) || { qty: 0 }).qty;
    const zero = menu.filter(item => qtyOf(item) === 0);
    const low = menu.filter(item => qtyOf(item) > 0).sort((x, y) => qtyOf(x) - qtyOf(y)).slice(0, 5)
      .filter(item => qtyOf(item) < topMax);
    $("#slowItems").innerHTML =
      zero.slice(0, 12).map(item => `
        <div class="insight"><div><strong>${escapeHtml(item.arabic)}</strong> <small>${escapeHtml(S.categoryName(item.category))} • ${formatMoney(item.price)}</small></div><span class="tag zero">لم يُطلب</span></div>`).join("") +
      (zero.length > 12 ? `<div class="order-meta">و ${zero.length - 12} أصناف أخرى لم تُطلب في هذه الفترة.</div>` : "") +
      low.map(item => `
        <div class="insight"><div><strong>${escapeHtml(item.arabic)}</strong> <small>${escapeHtml(S.categoryName(item.category))} • ${formatMoney(item.price)}</small></div><span class="tag low">طُلب ${qtyOf(item)} مرة</span></div>`).join("") +
      '<div class="order-meta" style="margin-top:4px">💡 فكّر بعرض ترويجي، أو صورة أوضح، أو تغيير السعر لهذه الأصناف.</div>';
  }

  async function refreshStats() {
    await loadHistory();
    renderStats();
  }

  $("#periodSeg").addEventListener("click", event => {
    const btn = event.target.closest("button[data-period]");
    if (!btn) return;
    period = btn.dataset.period;
    document.querySelectorAll("#periodSeg button").forEach(b => b.classList.toggle("active", b === btn));
    renderStats();
  });
  $("#refreshStats").addEventListener("click", refreshStats);
  let resizeTimer = null;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderStats, 200); });

  // ---------- Menu editing ----------
  const categoryOptions = selected => S.CATEGORIES.map(c => `<option value="${c[0]}" ${c[0] === selected ? "selected" : ""}>${c[1]}</option>`).join("");
  $("#newCategory").innerHTML = categoryOptions("frappe");
  $("#menuCategory").insertAdjacentHTML("beforeend", categoryOptions(""));

  function renderMenuEditor() {
    const q = $("#menuSearch").value.trim().toLowerCase();
    const cat = $("#menuCategory").value;
    const list = S.state.menu.filter(item =>
      (!cat || item.category === cat) &&
      (!q || String(item.arabic || "").toLowerCase().includes(q) || String(item.english || "").toLowerCase().includes(q)));
    $("#menuCount").textContent = `(${list.length} من ${S.state.menu.length})`;
    $("#menuRows").innerHTML = list.length ? list.map(item => `
      <tr data-id="${escapeHtml(item.id)}">
        <td><input data-f="arabic" value="${escapeHtml(item.arabic)}" /></td>
        <td><input data-f="english" value="${escapeHtml(item.english || "")}" /></td>
        <td><input data-f="price" type="number" min="0" step="250" value="${toNumber(item.price)}" /></td>
        <td><select data-f="category">${categoryOptions(item.category)}</select></td>
        <td><input data-f="image" type="url" value="${escapeHtml(item.image || "")}" placeholder="—" /></td>
        <td><div class="row-actions"><button type="button" class="small-btn" data-save disabled>حفظ</button><button type="button" class="small-btn secondary" data-del>حذف</button></div></td>
      </tr>`).join("") : '<tr><td colspan="6"><div class="empty">لا توجد أصناف مطابقة.</div></td></tr>';
  }

  $("#menuSearch").addEventListener("input", renderMenuEditor);
  $("#menuCategory").addEventListener("change", renderMenuEditor);
  $("#menuRows").addEventListener("input", event => {
    const tr = event.target.closest("tr[data-id]");
    if (!tr) return;
    tr.classList.add("changed");
    tr.querySelector("[data-save]").disabled = false;
  });
  $("#menuRows").addEventListener("change", event => {
    const tr = event.target.closest("tr[data-id]");
    if (!tr || event.target.tagName !== "SELECT") return;
    tr.classList.add("changed");
    tr.querySelector("[data-save]").disabled = false;
  });
  $("#menuRows").addEventListener("click", async event => {
    const tr = event.target.closest("tr[data-id]");
    if (!tr) return;
    const id = tr.dataset.id;
    if (event.target.closest("[data-save]")) {
      const v = f => tr.querySelector(`[data-f="${f}"]`).value.trim();
      if (!v("arabic") || !(Number(v("price")) > 0)) { alert("الاسم والسعر مطلوبان."); return; }
      const btn = event.target.closest("[data-save]");
      btn.disabled = true;
      const { error } = await S.state.db.from("menu_items")
        .update({ arabic: v("arabic"), english: v("english"), price: String(Math.round(Number(v("price")))), category: v("category"), image: v("image") || null })
        .eq("id", id);
      if (error) { btn.disabled = false; alert("تعذر حفظ التعديل."); return; }
      await S.loadMenu();
      renderMenuEditor();
      S.showToast("✓ تم حفظ التعديل — يظهر للزبائن فورًا");
    }
    if (event.target.closest("[data-del]")) {
      const name = tr.querySelector('[data-f="arabic"]').value;
      if (!confirm(`حذف "${name}" من المنيو؟`)) return;
      const { error } = await S.state.db.from("menu_items").delete().eq("id", id);
      if (error) { alert("تعذر حذف الصنف."); return; }
      await S.loadMenu();
      renderMenuEditor();
      S.showToast("تم حذف الصنف");
    }
  });

  $("#addItem").addEventListener("click", async () => {
    const arabic = $("#newArabic").value.trim();
    const english = $("#newEnglish").value.trim();
    const price = Math.round(Number($("#newPrice").value));
    if (!arabic || !(price > 0)) { alert("يرجى إدخال الاسم والسعر."); return; }
    const btn = $("#addItem");
    btn.disabled = true;
    const { error } = await S.state.db.from("menu_items").insert([{
      arabic, english, price: String(price), category: $("#newCategory").value, image: $("#newImage").value.trim() || null
    }]);
    btn.disabled = false;
    if (error) { alert("تعذر إضافة الصنف."); return; }
    ["#newArabic", "#newEnglish", "#newPrice", "#newImage"].forEach(id => { $(id).value = ""; });
    await S.loadMenu();
    renderMenuEditor();
    S.showToast(`✓ تمت إضافة "${arabic}" للمنيو`);
  });

  // ---------- Start ----------
  let statsTimer = null;
  S.init({
    page: "manager",
    allowedRoles: ["manager"],
    views: ["stats", "orders", "menu"],
    wrongRoleMessage: role => role === "cashier"
      ? 'هذا حساب الكاشير ولا يملك صلاحية واجهة المدير. <a href="cashier.html" style="font-weight:700;text-decoration:underline">افتح واجهة الكاشير</a>'
      : "هذا الحساب ليس له صلاحية دخول.",
    onReady: async () => {
      renderMenuEditor();
      await refreshStats();
    },
    onView: name => { if (name === "stats") setTimeout(renderStats, 0); },
    // Keep statistics current when orders change (debounced)
    onOrders: () => {
      if (!S.state.role) return;
      clearTimeout(statsTimer);
      statsTimer = setTimeout(refreshStats, 1500);
    }
  });
})();
