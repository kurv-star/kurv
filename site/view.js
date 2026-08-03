/* Kurv view layer.
 *
 * Organising principle: every screen leads with a conclusion and hides its
 * evidence behind a tap. The model has a lot of moving parts and almost none
 * of them are worth looking at while you are standing in a shop.
 */

const K = window.Kurv;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let searchTimer = null;
let pending = null;       // item in the buy sheet
let searchTarget = null;  // list the search sheet is adding to
const open = new Set();   // expanded disclosures, remembered across re-renders

function disc(id, summary, body, badge) {
  return `<details class="disc" ${open.has(id) ? "open" : ""} data-disc="${esc(id)}">
    <summary>${summary}${badge ? `<span class="dbadge">${badge}</span>` : ""}</summary>
    <div class="dbody">${body}</div>
  </details>`;
}

/* ============================================================== shelf stamp */

function stampHTML(d) {
  if (d.kind === "flat") return "";
  const cells = [];
  if (d.priceAge != null && d.off >= 0.03 && d.kind !== "newnormal") {
    const n = Math.min(14, d.priceAge);
    for (let i = 1; i <= 14; i++) {
      if (i === 8) cells.push('<span class="notch"></span>');
      cells.push(`<i class="${i <= n ? "on" : ""}"></i>`);
    }
    if (d.priceAge > 14) cells.push(`<span class="over">+${d.priceAge - 14}d</span>`);
  }
  return `<div class="stamp ${d.kind}">
    <div class="stamp-head"><span>${esc(d.label)}</span><span>${d.regular != null && d.off >= 0.03 ? K.money(d.regular) + " usual" : ""}</span></div>
    ${cells.length ? `<div class="ticks">${cells.join("")}</div>` : ""}
    ${d.note ? `<div class="stamp-note">${esc(d.note)}</div>` : ""}
  </div>`;
}

function priceBlock(it, g) {
  const d = K.deal(it);
  const u = g ? g.canon : K.guessCanon(it.unit, it.quantity);
  const q = K.toCanon(it.quantity, it.unit, u);
  return `<div class="pblock">
    <div class="price ${d.off >= 0.03 ? "off" : ""}">${K.money(it.price)}</div>
    ${d.off >= 0.03 ? `<div class="was">${K.money(it.regular)}</div>` : ""}
    ${q ? `<div class="perunit">${K.money(it.price / q)}/${u}</div>` : ""}
  </div>`;
}

function productRow(it, g, opts) {
  opts = opts || {};
  const watched = g && g.items.includes(it.key);
  return `<div class="prow">
    <div class="rowline">
      ${opts.watchBtn ? `<button class="watch ${watched ? "on" : ""}" data-act="watch" data-key="${esc(it.key)}" aria-label="${watched ? "Stop watching" : "Watch"}">${watched ? "✓" : "+"}</button>` : ""}
      <div class="grow">
        <div class="name">${esc(it.name)}</div>
        <div class="store">${esc(it.store)} · ${it.quantity ?? ""} ${esc(it.unit || "")}</div>
      </div>
      ${priceBlock(it, g)}
    </div>
    ${stampHTML(K.deal(it))}
    <div class="btn-row" style="margin-top:9px">
      <button class="btn sm" data-act="buy" data-key="${esc(it.key)}" data-g="${esc(g ? g.name : "")}">I bought this</button>
      ${opts.unwatch ? `<button class="btn sm ghost" data-act="watch" data-key="${esc(it.key)}">Stop watching</button>` : ""}
    </div>
  </div>`;
}

/* ============================================================== today panel */

function renderToday() {
  const el = $("todayBody");
  if (!K.S.order.length) {
    el.innerHTML = `<div class="empty">
      <strong>Start with one list</strong>
      A list is something you buy again and again — Pasta, Milk, Coffee — not a single product.
      <div class="btn-row" style="justify-content:center;margin-top:14px"><button class="btn" data-act="gosetup">Make a list</button></div>
    </div>`;
    return;
  }

  const vs = K.S.order.map((n) => ({ n, g: K.group(n), v: K.verdict(K.group(n)) }));
  const rank = { low: 0, deal: 1, "deal-full": 2, unknown: 3, empty: 4, ok: 5 };
  vs.sort((a, b) => rank[a.v.level] - rank[b.v.level]);

  const trip = vs.filter((x) => x.v.level === "low" || x.v.level === "deal");
  let html = "";

  if (trip.length) {
    html += `<div class="banner">
      <div class="eyebrow">Worth a trip</div>
      <div class="blist">${trip.map((x) => `<span>${esc(x.n)}</span>`).join("")}</div>
    </div>`;
  }

  html += vs.map(({ n, g, v }) => {
    const primary = v.action
      ? `<button class="btn sm" data-act="buy" data-key="${esc(v.action.key)}" data-g="${esc(n)}">I bought this</button>`
      : v.level === "empty"
        ? `<button class="btn sm" data-act="find" data-g="${esc(n)}">Add a product</button>`
        : `<button class="btn sm ghost" data-act="tune" data-g="${esc(n)}">Set how much you use</button>`;

    const detail = `
      <div class="stat"><span class="k">In stock</span><span class="v">${K.num(v.stock)} ${g.canon}</span></div>
      <div class="stat"><span class="k">Using about</span><span class="v">${K.num(v.rate.mu * 30.437, 1)} ${g.canon} a month</span></div>
      ${v.cover != null ? `<div class="stat"><span class="k">Lasts until</span><span class="v">${K.tsToISO(Math.floor(Date.now() / 1000) + Math.round(v.cover) * K.DAY)}</span></div>` : ""}
      <div style="margin-top:12px">${v.watched.map((it) => productRow(it, g, { unwatch: true })).join("") || `<div class="tiny">No products watched.</div>`}</div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn sm ghost" data-act="find" data-g="${esc(n)}">Add a product</button>
        <button class="btn sm ghost" data-act="tune" data-g="${esc(n)}">Adjust ${esc(n)}</button>
      </div>`;

    return `<div class="vcard ${v.level}">
      <div class="vtop">
        <div class="grow">
          <div class="vname">${esc(n)}</div>
          <div class="vhead">${esc(v.head)}</div>
          ${v.sub ? `<div class="vsub">${esc(v.sub)}</div>` : ""}
        </div>
        ${v.action ? priceBlock(v.action, g) : ""}
      </div>
      <div class="btn-row" style="margin-top:11px">${primary}</div>
      ${disc("d-" + n, "Details", detail, `${v.watched.length} watched`)}
    </div>`;
  }).join("");

  el.innerHTML = html;
}

/* =============================================================== stock panel */

function renderStock() {
  const el = $("stockBody");
  if (!K.S.order.length) { el.innerHTML = `<div class="empty"><strong>Nothing to track yet</strong>Make a list first.</div>`; return; }
  const now = Math.floor(Date.now() / 1000);

  el.innerHTML = K.S.order.map((name) => {
    const g = K.group(name);
    K.ensureOneOpen(g);
    const sim = K.simulate(g, now, 60);
    const stock = K.stockAt(g, now);
    const lots = [...g.lots].sort((a, b) => K.lotExpiry(g, a, now) - K.lotExpiry(g, b, now));
    const soon = lots.filter((l) => (l.units || 0) > 0 && (K.lotExpiry(g, l, now) - now) / K.DAY < 7).length;

    let warn = "";
    if (sim.alreadyLost > 0.001) warn += `<div class="vsub warnc">${K.num(sim.alreadyLost)} ${g.canon} is already past its date. Remove it below once it's binned.</div>`;
    if (sim.totalWaste > 0.001) warn += `<div class="vsub warnc">${K.num(sim.totalWaste)} ${g.canon} will expire unused at this pace.</div>`;

    const lotList = lots.map((l) => {
      const exp = K.lotExpiry(g, l, now);
      const left = Math.ceil((exp - now) / K.DAY);
      const cls = left < 0 ? "gone" : left < 7 ? "soon" : "ok";
      return `<div class="lot">
        <div class="rowline">
          <div class="grow">
            <div class="name" style="font-size:14px">${esc(l.name)}</div>
            <div class="store">${l.packs}× ${l.packQty ?? ""} ${esc(l.packUnit || "")} = ${K.num(l.units)} ${g.canon}${l.opened ? " · open" : ""}</div>
            <div class="tiny">${K.fmtDate(l.ts)} · ${K.money(l.price)}</div>
          </div>
          <div class="pblock">
            <div class="exp ${cls}">${left < 0 ? -left + "d past" : left + "d left"}</div>
            <button class="btn sm danger" data-act="rmlot" data-g="${esc(name)}" data-id="${l.id}" style="margin-top:5px">Remove</button>
          </div>
        </div>
      </div>`;
    }).join("") || `<div class="tiny">Nothing logged.</div>`;

    const forecast = `<div class="scroll"><table>
      <thead><tr><th>Date</th><th class="r">Left</th><th>Event</th></tr></thead>
      <tbody>${sim.rows.slice(0, 30).map((s) => `<tr class="${s.short ? "short" : ""}">
        <td>${s.date.slice(5)}</td><td class="r">${s.remaining.toFixed(2)}</td><td>${esc(s.events)}</td></tr>`).join("")}</tbody>
    </table><div class="tiny" style="margin-top:6px">▲ marks a day stock can't cover.</div></div>`;

    return `<div class="vcard ${sim.firstEmpty && sim.firstEmpty < 14 ? "low" : "ok"}">
      <div class="vname">${esc(name)}</div>
      <div class="vhead">${sim.firstEmpty ? `Runs out in ${K.plural(sim.firstEmpty, "day")}` : "Enough for the next 60 days"}</div>
      <div class="vsub">${K.num(stock)} ${g.canon} on hand${soon ? ` · ${soon} lot${soon > 1 ? "s" : ""} expiring this week` : ""}</div>
      ${warn}
      ${disc("s-" + name, "What's in stock", lotList, String(lots.length))}
      ${disc("f-" + name, "Day by day", forecast)}
    </div>`;
  }).join("");
}

/* ============================================================== money panel */

function chart(pts) {
  if (pts.length < 2) return `<div class="tiny" style="padding:10px 0">Log two purchases and the curve appears here.</div>`;
  const W = 640, H = 200, P = { t: 12, r: 12, b: 22, l: 50 };
  const t0 = pts[0].ts;
  const t1 = Math.max(pts[pts.length - 1].ts, t0 + K.DAY, Math.floor(Date.now() / 1000));
  const span = t1 - t0;
  const maxY = Math.max(pts[pts.length - 1].regular, 1) * 1.06;
  const x = (ts) => P.l + ((ts - t0) / span) * (W - P.l - P.r);
  const y = (v) => H - P.b - (v / maxY) * (H - P.t - P.b);

  // Spend is a step function: it jumps on the day of a purchase and is flat in
  // between. A smooth line would imply spending you did not do.
  const step = (key) => {
    let d = `M ${x(t0)} ${y(0)}`, prev = 0;
    for (const p of pts) { d += ` L ${x(p.ts)} ${y(prev)} L ${x(p.ts)} ${y(p[key])}`; prev = p[key]; }
    return d + ` L ${x(t1)} ${y(prev)}`;
  };
  const band = () => {
    let d = `M ${x(t0)} ${y(0)}`, prev = 0;
    for (const p of pts) { d += ` L ${x(p.ts)} ${y(prev)} L ${x(p.ts)} ${y(p.regular)}`; prev = p.regular; }
    d += ` L ${x(t1)} ${y(prev)} L ${x(t1)} ${y(pts[pts.length - 1].actual)}`;
    for (let i = pts.length - 1; i >= 0; i--) {
      const before = i === 0 ? 0 : pts[i - 1].actual;
      d += ` L ${x(pts[i].ts)} ${y(pts[i].actual)} L ${x(pts[i].ts)} ${y(before)}`;
    }
    return d + " Z";
  };
  const ticks = [0, 0.5, 1].map((f) => {
    const v = maxY * f;
    return `<line x1="${P.l}" y1="${y(v)}" x2="${W - P.r}" y2="${y(v)}" stroke="var(--rule2)"/>
      <text x="${P.l - 6}" y="${y(v) + 3.5}" text-anchor="end" font-size="10" fill="var(--ink3)">${Math.round(v)}</text>`;
  }).join("");

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative spending against usual prices">
    ${ticks}
    <path d="${band()}" fill="var(--stock)" opacity=".10"/>
    <path d="${step("regular")}" fill="none" stroke="var(--ink3)" stroke-width="1.5" stroke-dasharray="4 3"/>
    <path d="${step("actual")}" fill="none" stroke="var(--ink)" stroke-width="2"/>
    <text x="${P.l}" y="${H - 6}" font-size="10" fill="var(--ink3)">${K.tsToISO(t0)}</text>
    <text x="${W - P.r}" y="${H - 6}" text-anchor="end" font-size="10" fill="var(--ink3)">${K.tsToISO(t1)}</text>
  </svg>
  <div class="legend">
    <span><i style="background:var(--ink)"></i>Paid</span>
    <span><i style="background:var(--ink3)"></i>Usual price</span>
    <span><i style="background:var(--stock);height:8px;opacity:.3"></i>Saved</span>
  </div>`;
}

function renderMoney() {
  const el = $("moneyBody");
  const all = [];
  for (const n of K.S.order) for (const l of K.group(n).lots) all.push(l);
  if (!all.length) {
    el.innerHTML = `<div class="empty"><strong>Nothing logged yet</strong>Tap "I bought this" after a shop and the numbers start here.</div>`;
    return;
  }
  all.sort((a, b) => a.ts - b.ts);

  let ca = 0, cr = 0;
  const merged = all.map((l) => {
    ca += l.price || 0;
    cr += l.regular || l.price || 0;
    return { ts: l.ts, actual: ca, regular: cr };
  });

  let html = `<div class="vcard ok">
    <div class="bigsave"><div class="v">${K.money(cr - ca)}</div><div class="k">saved against usual prices</div></div>
    <div class="stat"><span class="k">Paid</span><span class="v">${K.money(ca)}</span></div>
    <div class="stat"><span class="k">Same goods, no discounts</span><span class="v">${K.money(cr)}</span></div>
    <div style="margin-top:12px">${chart(merged)}</div>
  </div>`;

  for (const n of K.S.order) {
    const g = K.group(n);
    if (!g.lots.length) continue;
    const cs = K.classSummary(g);
    const gap = cs.opportunity.n && cs.need.n ? (cs.opportunity.avgOff - cs.need.avgOff) * 100 : null;

    // The one diagnostic worth showing unprompted: are the buys you chose to
    // make actually cheaper than the ones you were forced into?
    let call = "";
    if (gap != null) {
      call = gap >= 8
        ? `<div class="vsub goodc">Stocking up is working — those buys ran ${gap.toFixed(0)} points cheaper than the ones you had to make.</div>`
        : `<div class="vsub warnc">Stocking up isn't paying off. Those buys were only ${gap.toFixed(0)} points cheaper than buying when you had to.</div>`;
    }
    if (cs.overstock.n) call += `<div class="vsub warnc">${cs.overstock.n} purchase${cs.overstock.n > 1 ? "s were" : " was"} more than fits before expiry.</div>`;
    if (cs.topup.n) call += `<div class="vsub">${cs.topup.n} at full price with stock already in.</div>`;

    const breakdown = Object.keys(K.CLASSES).map((k) => {
      const c = cs[k];
      if (!c.n) return "";
      return `<div class="stat">
        <span class="k"><span class="chip ${k}">${K.CLASSES[k].label}</span> ${c.n}×<div class="tiny">${esc(K.CLASSES[k].hint)}</div></span>
        <span class="v">${K.money(c.spend)}<div class="tiny">${Math.round(c.avgOff * 100)}% off avg</div></span>
      </div>`;
    }).join("");

    const rows = `<div class="scroll"><table>
      <thead><tr><th>Date</th><th>Item</th><th class="r">Paid</th><th class="r">Saved</th><th>Why</th></tr></thead>
      <tbody>${[...g.lots].sort((a, b) => b.ts - a.ts).map((l) => `<tr>
        <td>${K.tsToISO(l.ts).slice(5)}</td><td>${esc(l.name.slice(0, 22))}</td>
        <td class="r">${l.price.toFixed(2)}</td><td class="r">${((l.regular || l.price) - l.price).toFixed(2)}</td>
        <td><span class="chip ${l.cls}">${K.CLASSES[l.cls].label}</span></td></tr>
        <tr><td colspan="5" class="tiny" style="border-bottom:1px solid var(--rule)">${esc(l.why)}</td></tr>`).join("")}</tbody>
    </table></div>`;

    html += `<div class="vcard ok">
      <div class="vname">${esc(n)}</div>
      <div class="vhead">${K.money(g.lots.reduce((s, l) => s + l.price, 0))} across ${g.lots.length} purchase${g.lots.length > 1 ? "s" : ""}</div>
      ${call}
      ${disc("b-" + n, "Why you bought", breakdown)}
      ${disc("l-" + n, "Every purchase", rows)}
    </div>`;
  }
  el.innerHTML = html;
}

/* ============================================================== setup panel */

function renderSetup() {
  const el = $("setupBody");
  let html = `<div class="vcard ok">
    <div class="vname">New list</div>
    <div class="vsub">Something you buy repeatedly. Everything in it converts to one unit, so brands and pack sizes compare fairly.</div>
    <div class="f2" style="margin-top:12px">
      <div class="field"><label>Name</label><input id="ngName" placeholder="Pasta"></div>
      <div class="field"><label>Measured in</label><select id="ngUnit">${K.CANON_UNITS.map((u) => `<option>${u}</option>`).join("")}</select></div>
    </div>
    <button class="btn" data-act="addgroup">Create list</button>
  </div>`;

  for (const n of K.S.order) {
    const g = K.group(n);
    const prior = K.priorMu(g);
    const r = K.rate(g);

    const advanced = `
      <div class="f2">
        <div class="field"><label>Buy when cover drops below</label><input class="cfg" data-f="needDays" type="number" min="0" step="any" value="${g.needDays}"><div class="hint">days</div></div>
        <div class="field"><label>Counts as a deal from</label><input class="cfg" data-f="minDiscount" type="number" min="0" max="90" step="1" value="${Math.round(g.minDiscount * 100)}"><div class="hint">% under usual</div></div>
      </div>
      <div class="field"><label>How fast habits change</label><input class="cfg" data-f="halfLife" type="number" min="1" step="any" value="${g.halfLife}">
        <div class="hint">Days. Lower means recent purchases count for more. 21 is a sensible default.</div></div>
      <div class="btn-row"><button class="btn sm ghost" data-act="reclass" data-g="${esc(n)}">Re-judge past purchases</button></div>`;

    html += `<div class="vcard ok" data-g="${esc(n)}">
      <div class="vname">${esc(n)} <span class="tiny">in ${g.canon}</span></div>

      <div class="eyebrow" style="margin:14px 0 7px">How much you use</div>
      <div class="f3">
        <div class="field"><label>How many</label><input class="cfg" data-f="expCount" type="number" step="any" min="0" value="${g.expect ? g.expect.count : ""}" placeholder="7"></div>
        <div class="field"><label>of</label><input class="cfg" data-f="expSize" type="number" step="any" min="0" value="${g.expect ? g.expect.packSize : ""}" placeholder="500"></div>
        <div class="field"><label>unit</label><input class="cfg" data-f="expUnit" value="${g.expect ? esc(g.expect.packUnit) : ""}" placeholder="g"></div>
      </div>
      <div class="hint">${prior != null
        ? `That's <strong>${K.num(g.expect.count * K.toCanon(g.expect.packSize, g.expect.packUnit, g.canon), 1)} ${g.canon} a month</strong>. With ${r.n} purchase${r.n === 1 ? "" : "s"} logged, the app is working from ${K.num(r.mu * 30.437, 1)} ${g.canon} a month.`
        : `Per month. Brand and pack size don't matter — "7 of 500 g" and "3 of 1 kg" both convert to ${g.canon}.`}</div>

      <div class="eyebrow" style="margin:18px 0 7px">How long it keeps</div>
      <div class="f2">
        <div class="field"><label>Unopened</label><input class="cfg" data-f="shelfDays" type="number" min="1" value="${g.shelfDays}"><div class="hint">days</div></div>
        <div class="field"><label>Once opened</label><input class="cfg" data-f="openedDays" type="number" min="1" value="${g.openedDays}"><div class="hint">days</div></div>
      </div>

      ${disc("a-" + n, "Fine tuning", advanced)}

      <div class="btn-row" style="margin-top:12px">
        <button class="btn" data-act="savecfg" data-g="${esc(n)}">Save</button>
        <button class="btn ghost danger" data-act="delgroup" data-g="${esc(n)}">Delete list</button>
      </div>
    </div>`;
  }

  const m = K.CAT.meta;
  html += `<div class="vcard ok">
    <div class="vname">Prices</div>
    <div class="vsub">${m ? `${m.count.toLocaleString("da-DK")} products, built ${new Date(m.built).toLocaleString("da-DK")}` : "No snapshot loaded."}</div>
    <div class="btn-row" style="margin-top:10px"><button class="btn sm ghost" data-act="refresh">Check for new prices</button></div>
  </div>
  <div class="vcard ok">
    <div class="vname">Your data</div>
    <div class="vsub">Lists and purchases live only on this phone. Nothing is uploaded. Export before clearing Safari data or changing phones.</div>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn sm ghost" data-act="export">Export backup</button>
      <button class="btn sm ghost" data-act="import">Import backup</button>
    </div>
  </div>`;
  el.innerHTML = html;
}

/* ============================================================= search sheet */

function openSearch(name) {
  searchTarget = name || K.S.order[0] || null;
  if (!searchTarget) { K.toast("Make a list first."); return setTab("setup"); }
  $("searchFor").textContent = searchTarget;
  $("q").value = "";
  $("results").innerHTML = `<div class="tiny" style="padding:14px 2px">Two letters or more. Danish spelling is forgiving — "malk", "maelk" and "mælk" all find the same thing.</div>`;
  renderStoreFilter();
  $("searchModal").classList.add("on");
  setTimeout(() => $("q").focus(), 80);
}

function renderSearch() {
  const g = searchTarget ? K.group(searchTarget) : null;
  const q = $("q").value.trim();
  const box = $("results");
  if (q.length < 2) { box.innerHTML = ""; return; }
  if (!K.CAT.ready) { box.innerHTML = `<div class="empty">${esc(K.CAT.error || "Prices still loading…")}</div>`; return; }
  const hits = K.search(q, K.S.ui.stores, 30);
  box.innerHTML = hits.length
    ? hits.map((it) => productRow(it, g, { watchBtn: true })).join("")
    : `<div class="empty"><strong>No match</strong>Try fewer words, or a shorter one.</div>`;
}

function renderStoreFilter() {
  const stores = (K.CAT.meta && K.CAT.meta.stores) || [];
  const sel = K.S.ui.stores;
  $("stores").innerHTML = stores.map((s) =>
    `<button data-store="${esc(s)}" class="${!sel || sel.includes(s) ? "on" : ""}">${esc(s)}</button>`).join("");
}

/* ================================================================ buy sheet */

function openBuy(key, gname) {
  const g = K.group(gname) || K.group(searchTarget) || K.group(K.S.order[0]);
  const it = K.itemByKey(key);
  if (!g || !it) return;
  pending = { it, g };
  const per = K.toCanon(it.quantity, it.unit, g.canon);
  $("buyTitle").textContent = it.name;
  $("buySub").innerHTML = `${esc(it.store)} · ${K.money(it.price)} · goes into <strong>${esc(g.name)}</strong>`;
  $("buyDate").value = K.todayISO();
  $("buyPacks").value = 1;
  $("buyUnits").value = per != null ? per : "";
  $("buyUnitsLabel").textContent = `${g.canon} in one pack`;
  $("buyUnitsHint").innerHTML = per != null
    ? `From the pack size (${it.quantity} ${esc(it.unit || "")}).`
    : `<strong class="warnc">This pack is listed as "${esc(it.unit || "no unit")}", which doesn't convert to ${g.canon}. Enter it yourself or the stock count will be wrong.</strong>`;
  $("buyShelf").value = "";
  $("buyOpened").value = "";
  updateBuyPreview();
  $("buyModal").classList.add("on");
}

function updateBuyPreview() {
  if (!pending) return;
  const { it, g } = pending;
  const packs = Math.max(1, Number($("buyPacks").value) || 1);
  const per = Number($("buyUnits").value);
  const ts = K.isoToTs($("buyDate").value) || K.dayFloor(Math.floor(Date.now() / 1000));
  const shelf = Number($("buyShelf").value) || g.shelfDays;
  const units = isFinite(per) && per > 0 ? per * packs : 0;
  const d = K.classify(g, ts, units, shelf, it.price, it.regular);
  const saved = ((it.regular ?? it.price) - it.price) * packs;
  const tone = d.cls === "overstock" ? "warnc" : d.cls === "topup" ? "" : "goodc";

  $("buyPreview").innerHTML = `<div class="verdictbox ${d.cls}">
    <div class="vhead">${K.money(it.price * packs)}${saved > 0.005 ? ` · saves ${K.money(saved)}` : ""}</div>
    <div class="vsub ${tone}">${esc(d.why)}</div>
    ${isFinite(d.coverAfter) ? `<div class="tiny">Leaves ${Math.round(d.coverAfter)} days of cover.</div>` : ""}
  </div>`;
}

function confirmBuy() {
  if (!pending) return;
  const { it, g } = pending;
  K.buy(g, it, {
    date: $("buyDate").value,
    packs: Number($("buyPacks").value),
    unitsPerPack: Number($("buyUnits").value),
    shelfDays: Number($("buyShelf").value) || null,
    openedDays: Number($("buyOpened").value) || null,
  });
  if (!g.items.includes(it.key)) { g.items.push(it.key); K.save(); }
  $("buyModal").classList.remove("on");
  K.toast("Logged.");
  renderAll();
}

/* ===================================================================== shell */

function renderHeader() {
  const age = K.dataAgeDays();
  const snap = $("snapshot");
  if (age == null) {
    snap.className = "snapshot warn";
    snap.innerHTML = `<span class="dot"></span>No prices loaded`;
  } else {
    snap.className = "snapshot" + (age >= 2 ? " warn" : "");
    snap.innerHTML = `<span class="dot"></span>Prices from ${age === 0 ? "today" : age === 1 ? "yesterday" : age + " days ago"}` +
      (age >= 2 ? " — deals may be over" : "");
  }
}

function renderAll() {
  renderHeader();
  const t = K.S.ui.tab;
  if (t === "today") renderToday();
  if (t === "stock") renderStock();
  if (t === "money") renderMoney();
  if (t === "setup") renderSetup();
}

function setTab(t) {
  K.S.ui.tab = t;
  K.save();
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("on", p.id === "panel-" + t));
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  $("gear").classList.toggle("on", t === "setup");
  renderAll();
  window.scrollTo(0, 0);
}

/* ==================================================================== events */

// Remember which disclosures are open, so a re-render doesn't collapse one
// under your finger.
document.addEventListener("toggle", (e) => {
  const d = e.target.closest && e.target.closest("details[data-disc]");
  if (!d) return;
  if (d.open) open.add(d.dataset.disc); else open.delete(d.dataset.disc);
}, true);

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act], [data-tab], [data-store]");
  if (!b) return;

  if (b.dataset.tab) return setTab(b.dataset.tab);

  if (b.dataset.store) {
    const s = b.dataset.store;
    const all = (K.CAT.meta && K.CAT.meta.stores) || [];
    let sel = K.S.ui.stores || all.slice();
    sel = sel.includes(s) ? sel.filter((x) => x !== s) : sel.concat([s]);
    K.S.ui.stores = sel.length === all.length ? null : sel;
    K.save(); renderStoreFilter(); renderSearch();
    return;
  }

  const act = b.dataset.act;

  if (act === "watch") {
    const holder = b.closest("[data-g]");
    const target = (searchTarget && $("searchModal").classList.contains("on"))
      ? K.group(searchTarget)
      : K.group(holder ? holder.dataset.g : null) || K.group(K.S.order[0]);
    if (!target) return K.toast("Make a list first.");
    const k = b.dataset.key;
    const on = !target.items.includes(k);
    target.items = on ? target.items.concat([k]) : target.items.filter((x) => x !== k);
    K.save();
    // Update the tapped control in place — rebuilding the list here would
    // scroll you to the top halfway through picking products.
    document.querySelectorAll(`.watch[data-key="${CSS.escape(k)}"]`).forEach((el) => {
      el.classList.toggle("on", on);
      el.textContent = on ? "✓" : "+";
    });
    if (!$("searchModal").classList.contains("on")) renderAll();
  }
  else if (act === "buy") openBuy(b.dataset.key, b.dataset.g);
  else if (act === "confirmbuy") confirmBuy();
  else if (act === "closesheet") b.closest(".modal").classList.remove("on");
  else if (act === "find") openSearch(b.dataset.g);
  else if (act === "gosetup") setTab("setup");
  else if (act === "gear") setTab(K.S.ui.tab === "setup" ? "today" : "setup");
  else if (act === "tune") { open.add("a-" + b.dataset.g); setTab("setup"); }
  else if (act === "rmlot") {
    if (!confirm("Remove this lot?")) return;
    K.removeLot(K.group(b.dataset.g), Number(b.dataset.id));
    renderStock();
  }
  else if (act === "addgroup") {
    if (!K.addGroup($("ngName").value, $("ngUnit").value)) return K.toast("Pick a name that isn't already used.");
    renderAll();
  }
  else if (act === "delgroup") {
    if (!confirm(`Delete "${b.dataset.g}" and everything logged in it?`)) return;
    K.removeGroup(b.dataset.g); renderAll();
  }
  else if (act === "savecfg") saveCfg(b.dataset.g);
  else if (act === "reclass") { K.reclassify(K.group(b.dataset.g)); K.toast("Re-judged."); renderSetup(); }
  else if (act === "refresh") {
    K.CAT.ready = false;
    K.loadCatalog((m) => m && K.toast(m)).then(() => { renderAll(); K.toast("Prices up to date."); });
  }
  else if (act === "export") doExport();
  else if (act === "import") $("importFile").click();
});

function saveCfg(name) {
  const g = K.group(name);
  const card = document.querySelector(`.vcard[data-g="${CSS.escape(name)}"]`);
  if (!g || !card) return;
  const val = (f) => { const el = card.querySelector(`.cfg[data-f="${f}"]`); return el ? el.value : ""; };

  const c = Number(val("expCount")), sz = Number(val("expSize")), un = val("expUnit").trim();
  if (c > 0 && sz > 0 && un) {
    if (K.toCanon(sz, un, g.canon) == null) return K.toast(`"${un}" doesn't convert to ${g.canon}. Use g, kg, ml, dl, L or stk.`);
    g.expect = { count: c, packSize: sz, packUnit: un };
  } else g.expect = null;

  g.shelfDays = Math.max(1, Number(val("shelfDays")) || g.shelfDays);
  g.openedDays = Math.max(1, Number(val("openedDays")) || g.openedDays);
  if (val("needDays") !== "") g.needDays = Math.max(0, Number(val("needDays")));
  if (val("minDiscount") !== "") g.minDiscount = Math.min(0.9, Math.max(0, Number(val("minDiscount")) / 100));
  if (val("halfLife") !== "") g.halfLife = Math.max(1, Number(val("halfLife")) || g.halfLife);
  K.save();
  K.toast(`${name} saved.`);
  renderSetup();
}

function doExport() {
  const blob = new Blob([JSON.stringify(K.S, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `kurv-backup-${K.todayISO()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

document.addEventListener("change", (e) => {
  if (e.target.id === "importFile") {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then((t) => {
      try {
        const parsed = JSON.parse(t);
        if (!parsed.groups || !parsed.order) throw new Error("bad file");
        K.S = parsed; K.save(); renderAll(); K.toast("Backup restored.");
      } catch { K.toast("That file isn't a Kurv backup."); }
    });
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "q") { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearch, 160); }
  if (e.target.closest("#buyModal")) updateBuyPreview();
});

/* ======================================================================= boot */

(async function boot() {
  if (!["today", "stock", "money", "setup"].includes(K.S.ui.tab)) K.S.ui.tab = "today";
  setTab(K.S.ui.tab);
  await K.loadCatalog();
  renderAll();
})();
