/* Kurv — grocery lookout, stock and spend ledger.
 * Everything you own lives in localStorage on this device. The catalog is a
 * read-only nightly snapshot fetched from this same site.
 */

const DAY = 86400;
const MS_DAY = 86400000;
const MONTH_DAYS = 30.437; // mean Gregorian month, so "7 per month" means 7

/* ============================================================ unit handling
 * The old version added raw pack quantities together, so a 500 g bag and a
 * 1 kg bag contributed 500 and 1 to the same total. Every group now has one
 * canonical unit and everything converts into it on the way in.
 */

const UNIT_TO_BASE = {
  g: ["kg", 0.001], gr: ["kg", 0.001], gram: ["kg", 0.001], grams: ["kg", 0.001],
  kg: ["kg", 1], kilo: ["kg", 1], kilogram: ["kg", 1],
  ml: ["L", 0.001], cl: ["L", 0.01], dl: ["L", 0.1],
  l: ["L", 1], lt: ["L", 1], ltr: ["L", 1], liter: ["L", 1], litre: ["L", 1],
  stk: ["pc", 1], st: ["pc", 1], pc: ["pc", 1], pcs: ["pc", 1], piece: ["pc", 1],
  pk: ["pc", 1], pkt: ["pc", 1], pak: ["pc", 1], bt: ["pc", 1], x: ["pc", 1],
};

const CANON_UNITS = ["kg", "L", "pc"];

function cleanUnit(u) {
  return String(u || "").trim().toLowerCase().replace(/[.\s_]/g, "");
}

/** Convert a pack quantity into a group's canonical unit. null if impossible. */
function toCanon(qty, unit, canon) {
  const q = Number(qty);
  if (!isFinite(q) || q <= 0) return null;
  const u = cleanUnit(unit);
  let entry = UNIT_TO_BASE[u];
  // Unlabelled whole numbers are almost always a piece count.
  if (!entry && u === "" && Number.isInteger(q)) entry = ["pc", 1];
  if (!entry) return null;
  const [base, factor] = entry;
  if (base !== canon) return null;
  return q * factor;
}

function guessCanon(unit, qty) {
  const u = cleanUnit(unit);
  const entry = UNIT_TO_BASE[u] || (u === "" && Number.isInteger(Number(qty)) ? ["pc", 1] : null);
  return entry ? entry[0] : "pc";
}

/* ================================================================= date bits */

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function isoToTs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso + "T00:00:00Z");
  return isFinite(t) ? Math.floor(t / 1000) : null;
}
function tsToISO(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}
function dayFloor(ts) {
  return Math.floor(ts / DAY) * DAY;
}
function daysBetween(isoA, isoB) {
  const a = Date.parse(isoA + "T00:00:00Z");
  const b = Date.parse(isoB + "T00:00:00Z");
  if (!isFinite(a) || !isFinite(b)) return null;
  return Math.round((a - b) / MS_DAY);
}
function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleDateString("da-DK", { day: "numeric", month: "short" });
}

/* ================================================================== storage */

const LS_KEY = "kurv.state.v1";

function blankGroup(name) {
  return {
    name,
    canon: "kg",
    items: [],              // catalog keys being watched
    lots: [],
    shelfDays: 180,         // unopened
    openedDays: 14,         // after opening
    halfLife: 21,           // EWMA half-life, days
    needDays: 14,           // cover below this = a real need
    minDiscount: 0.15,      // below usual price to count as an opportunity
    oppWeight: 0.25,        // how much an opportunity buy informs the rate
    expect: null,           // { count, packSize, packUnit } per month
    anchorTs: null,         // last "need" purchase, resets the interval clock
  };
}

const DEFAULT_STATE = {
  v: 1,
  groups: {},
  order: [],
  lotSeq: 1,
  ui: { tab: "shop", group: null, stores: null },
};

let S = load();

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_STATE));
    const parsed = JSON.parse(raw);
    return Object.assign(JSON.parse(JSON.stringify(DEFAULT_STATE)), parsed);
  } catch (e) {
    console.warn("State unreadable, starting fresh", e);
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(S));
    } catch (e) {
      toast("Could not save — device storage is full.");
    }
  }, 120);
}

function group(name) {
  return S.groups[name];
}
function activeGroup() {
  if (!S.ui.group || !S.groups[S.ui.group]) S.ui.group = S.order[0] || null;
  return S.ui.group ? S.groups[S.ui.group] : null;
}
function addGroup(name, canon) {
  name = (name || "").trim();
  if (!name || S.groups[name]) return null;
  const g = blankGroup(name);
  g.canon = canon || "kg";
  S.groups[name] = g;
  S.order.push(name);
  S.ui.group = name;
  save();
  return g;
}
function removeGroup(name) {
  delete S.groups[name];
  S.order = S.order.filter((n) => n !== name);
  if (S.ui.group === name) S.ui.group = S.order[0] || null;
  save();
}

/* ================================================== catalog: fetch and cache
 * meta.json is small and always refetched. catalog.json is a few MB and only
 * refetched when meta.built changes, so a normal open is one tiny request.
 */

const CAT = { meta: null, rows: [], norm: [], byKey: new Map(), ready: false, error: null };

function itemKey(store, name) {
  // Keys round-trip through HTML data attributes, so no control characters:
  // the parser rewrites NUL to U+FFFD and the key stops matching. Store slugs
  // never contain a pipe, so this stays unambiguous.
  return store + "|" + name;
}

function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("kurv", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("cache");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((res, rej) => {
      const t = db.transaction("cache", "readonly").objectStore("cache").get(key);
      t.onsuccess = () => res(t.result);
      t.onerror = () => rej(t.error);
    });
  } catch { return undefined; }
}
async function idbSet(key, val) {
  try {
    const db = await idbOpen();
    await new Promise((res, rej) => {
      const t = db.transaction("cache", "readwrite").objectStore("cache").put(val, key);
      t.onsuccess = () => res();
      t.onerror = () => rej(t.error);
    });
  } catch (e) { console.warn("cache write failed", e); }
}

function normalizeName(s) {
  let t = String(s || "");
  // Compose first: an iOS keyboard can emit "a" + combining ring for å, and
  // the folds below only see the precomposed letter.
  if (t.normalize) t = t.normalize("NFC");
  t = t.replace(/[ÆæÄä]/g, "a").replace(/[ØøÖö]/g, "o").replace(/[Åå]/g, "a");
  t = t.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  t = t.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  // Then collapse the written-out spellings, so "mælk", "maelk" and "malk"
  // all reduce to the same string. Applied to the catalog and the query
  // alike, so nothing can disagree. It over-matches slightly, which in a
  // search box costs nothing.
  t = t.replace(/aa/g, "a").replace(/ae/g, "a").replace(/oe/g, "o");
  return t.trim();
}

function indexCatalog(rows) {
  CAT.rows = rows;
  CAT.norm = new Array(rows.length);
  CAT.byKey = new Map();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    CAT.norm[i] = normalizeName(r[0] + " " + r[1]);
    CAT.byKey.set(itemKey(r[0], r[1]), i);
  }
  CAT.ready = true;
}

async function loadCatalog(onProgress) {
  onProgress && onProgress("Checking for new prices…");
  let meta = null;
  try {
    const r = await fetch("data/meta.json", { cache: "no-store" });
    if (r.ok) meta = await r.json();
  } catch (e) { /* offline is fine, fall through to cache */ }

  const cached = await idbGet("catalog");
  if (cached && (!meta || cached.built === meta.built)) {
    CAT.meta = meta || cached.meta || { built: cached.built, count: cached.rows.length, stores: [] };
    indexCatalog(cached.rows);
    onProgress && onProgress(null);
    return;
  }
  if (!meta) {
    CAT.error = "No prices on this device yet, and no connection to fetch them.";
    onProgress && onProgress(null);
    return;
  }

  onProgress && onProgress(`Downloading ${meta.count.toLocaleString("da-DK")} prices…`);
  try {
    const r = await fetch("data/catalog.json", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    CAT.meta = meta;
    indexCatalog(data.rows);
    await idbSet("catalog", { built: meta.built, rows: data.rows, meta });
  } catch (e) {
    if (cached) {
      CAT.meta = cached.meta || { built: cached.built, count: cached.rows.length, stores: [] };
      indexCatalog(cached.rows);
      toast("Using the prices already on this device — download failed.");
    } else {
      CAT.error = "Could not download prices: " + e.message;
    }
  }
  onProgress && onProgress(null);
}

/** Row -> object. Columns: store,name,price,quantity,unit,regular,since,high */
function item(i) {
  const r = CAT.rows[i];
  if (!r) return null;
  return { key: itemKey(r[0], r[1]), store: r[0], name: r[1], price: r[2], quantity: r[3], unit: r[4], regular: r[5], since: r[6], high: r[7] };
}
function itemByKey(k) {
  const i = CAT.byKey.get(k);
  return i === undefined ? null : item(i);
}

/* =================================================================== search */

function search(query, stores, limit = 40) {
  const q = normalizeName(query);
  if (q.length < 2 || !CAT.ready) return [];
  const tokens = q.split(" ").filter(Boolean);
  if (!tokens.length) return [];
  const useStores = stores && stores.length ? new Set(stores) : null;

  const hits = [];
  for (let i = 0; i < CAT.norm.length; i++) {
    if (useStores && !useStores.has(CAT.rows[i][0])) continue;
    const n = CAT.norm[i];
    let ok = true;
    for (let t = 0; t < tokens.length; t++) {
      if (n.indexOf(tokens[t]) === -1) { ok = false; break; }
    }
    if (ok) {
      hits.push(i);
      if (hits.length >= 3000) break;
    }
  }
  hits.sort((a, b) => {
    const pa = CAT.norm[a].indexOf(tokens[0]);
    const pb = CAT.norm[b].indexOf(tokens[0]);
    if (pa !== pb) return pa - pb;
    return (CAT.rows[a][2] ?? 9e9) - (CAT.rows[b][2] ?? 9e9);
  });
  return hits.slice(0, limit).map(item);
}

/* ============================================================ deal freshness
 * The question this answers: the price is low, but is the low price still
 * true? Two separate clocks matter and the old version tracked neither.
 *
 *   priceAge   how long the item has sat at this price, per the snapshot.
 *              Danish promos run a calendar week, so a two-day-old drop is
 *              almost certainly live and a twenty-day-old one is not a promo.
 *   dataAge    how old the whole snapshot is. A perfectly fresh-looking deal
 *              in a week-old file tells you nothing.
 */

function dataAgeDays() {
  if (!CAT.meta || !CAT.meta.built) return null;
  return Math.max(0, Math.floor((Date.now() - Date.parse(CAT.meta.built)) / MS_DAY));
}
function snapshotISO() {
  return CAT.meta && CAT.meta.built ? CAT.meta.built.slice(0, 10) : todayISO();
}

function deal(it) {
  const reg = it.regular;
  const off = reg > 0 ? (reg - it.price) / reg : 0;
  const priceAge = it.since ? daysBetween(snapshotISO(), it.since) : null;
  const dAge = dataAgeDays();

  let kind, label, note;
  if (off < 0.03) {
    if (off < -0.03) { kind = "up"; label = `${Math.round(-off * 100)}% over usual`; note = `Usually ${money(reg)}.`; }
    else { kind = "flat"; label = "Usual price"; note = null; }
  } else if (priceAge == null) {
    kind = "unknown"; label = `${Math.round(off * 100)}% under usual`; note = "No history — start date unknown.";
  } else if (priceAge > 28) {
    kind = "newnormal"; label = `${Math.round(off * 100)}% under the old price`;
    note = `Held for ${priceAge} days. This is the shelf price now, not a promo.`;
  } else if (priceAge <= 7) {
    kind = "fresh"; label = `${Math.round(off * 100)}% off`;
    note = `Dropped ${priceAge === 0 ? "today" : priceAge + (priceAge === 1 ? " day" : " days") + " ago"}. Inside the usual promo week.`;
  } else if (priceAge <= 14) {
    kind = "aging"; label = `${Math.round(off * 100)}% off`;
    note = `Running ${priceAge} days — past a normal promo week, may have ended.`;
  } else {
    kind = "stale"; label = `${Math.round(off * 100)}% off`;
    note = `Running ${priceAge} days. Either a long campaign or the price has moved and the feed missed it.`;
  }

  return { off, regular: reg, priceAge, dataAge: dAge, kind, label, note };
}

/* ======================================================= consumption rate
 * Two sources, blended. The EWMA over purchase intervals learns from what you
 * actually do; the monthly expectation from Settings is a prior that carries
 * the model until there is enough real data. k is a pseudo-count: with three
 * purchases logged, the two sources weigh equally.
 */

const PRIOR_K = 3;

function priorMu(g) {
  if (!g.expect) return null;
  const { count, packSize, packUnit } = g.expect;
  const per = toCanon(packSize, packUnit, g.canon);
  if (per == null || !(count > 0)) return null;
  return (count * per) / MONTH_DAYS;
}

function alphaFromHalfLife(hl) {
  return hl <= 0 ? 1 : 1 - Math.exp(-Math.LN2 / hl);
}

function classWeight(g, cls) {
  if (cls === "need") return 1.0;
  if (cls === "topup") return 0.4;
  if (cls === "overstock") return 0.1;
  return g.oppWeight; // opportunity
}

function rateSamples(g, uptoTs) {
  const lots = g.lots.filter((l) => l.ts != null && l.ts <= uptoTs).sort((a, b) => a.ts - b.ts);
  if (!lots.length) return [];
  const out = [];
  let prev = g.anchorTs && g.anchorTs <= uptoTs ? g.anchorTs : lots[0].ts;
  for (const l of lots) {
    if (l.ts <= prev) { prev = l.ts; continue; }
    const days = Math.max(1, Math.round((l.ts - prev) / DAY));
    out.push({ ts: l.ts, rate: (l.units || 0) / days, w: classWeight(g, l.cls) });
    prev = l.ts;
  }
  return out;
}

function rate(g, uptoTs) {
  uptoTs = uptoTs || Math.floor(Date.now() / 1000);
  const samples = rateSamples(g, uptoTs);
  const prior = priorMu(g);
  const a0 = alphaFromHalfLife(g.halfLife);

  let m = prior != null ? prior : samples.length ? samples[0].rate : 0;
  let v = 0;
  for (const s of samples) {
    const a = a0 * Math.max(0, Math.min(1, s.w));
    const d = s.rate - m;
    m += a * d;
    v = (1 - a) * (v + a * d * d);
  }
  const ewma = m;
  const n = samples.length;
  const mu = prior == null ? ewma : (n * ewma + PRIOR_K * prior) / (n + PRIOR_K);

  return { mu, ewma, prior, sigma: Math.sqrt(Math.max(v, 0)), n };
}

/* =============================================================== stock model */

function lotExpiry(g, lot, nowTs) {
  const shelf = lot.shelfDays ?? g.shelfDays;
  const opened = lot.openedDays ?? g.openedDays;
  const unopenedExp = lot.ts + shelf * DAY;
  if (lot.opened) {
    const ot = lot.openedTs ?? lot.ts;
    return Math.min(unopenedExp, ot + opened * DAY);
  }
  return unopenedExp;
}

function stockAt(g, ts) {
  return g.lots
    .filter((l) => l.ts <= ts && lotExpiry(g, l, ts) > ts)
    .reduce((s, l) => s + (l.units || 0), 0);
}

function longestHorizon(g, ts, newShelfDays) {
  let best = newShelfDays;
  for (const l of g.lots) {
    if (l.ts > ts) continue;
    const left = Math.max(0, Math.round((lotExpiry(g, l, ts) - ts) / DAY));
    if (left > best) best = left;
  }
  return best;
}

/* ========================================================== classification
 * Four outcomes, not two. The binary need/opportunity split hid the two cases
 * worth catching: buying more than you can finish, and buying at full price
 * for no reason.
 */

const CLASSES = {
  need:       { label: "Need",       hint: "Stock was about to run out." },
  opportunity:{ label: "Opportunity",hint: "Not needed yet, but genuinely cheap and it keeps." },
  overstock:  { label: "Overstock",  hint: "More than can be used before it expires." },
  topup:      { label: "Top-up",     hint: "Neither needed nor discounted." },
};

function classify(g, ts, units, shelfDays, price, regular) {
  const r = rate(g, ts);
  const mu = r.mu;
  const stock = stockAt(g, ts);
  const coverBefore = mu > 1e-9 ? stock / mu : Infinity;
  const coverAfter = mu > 1e-9 ? (stock + units) / mu : Infinity;
  const horizon = longestHorizon(g, ts, shelfDays);
  const off = regular > 0 ? (regular - price) / regular : 0;
  const wasteRisk = isFinite(coverAfter) && coverAfter > horizon + 1e-9;

  let cls, why;
  if (mu <= 1e-9) {
    cls = "opportunity";
    why = "No consumption rate yet. Set an expected monthly amount in Setup and this gets sharper.";
  } else if (wasteRisk) {
    // Checked before the need gate on purpose. Running low and buying far more
    // than will keep are not mutually exclusive, and the overstock is the part
    // worth telling you about.
    cls = "overstock";
    why = `Leaves ${coverAfter.toFixed(0)} days of cover but it only keeps ${horizon} days` +
      (coverBefore <= g.needDays ? `. You were low (${coverBefore.toFixed(1)}d), so buy some — just less.` : ".");
  } else if (coverBefore <= g.needDays) {
    cls = "need";
    why = `${coverBefore.toFixed(1)} days of cover left, below the ${g.needDays}-day gate.`;
  } else if (off >= g.minDiscount) {
    cls = "opportunity";
    why = `${Math.round(off * 100)}% under usual, ${coverAfter.toFixed(0)} days of cover, keeps ${horizon} days.`;
  } else {
    cls = "topup";
    why = `${coverBefore.toFixed(0)} days of cover already and only ${Math.round(off * 100)}% off.`;
  }
  return { cls, why, mu, coverBefore, coverAfter, horizon, off, stock, wasteRisk };
}

/* ================================================================== verdict
 * The whole model, reduced to the one sentence you need while standing in a
 * shop. Everything else in the app is this answer's supporting evidence, and
 * should stay out of the way until asked for.
 */

function verdict(g) {
  const now = Math.floor(Date.now() / 1000);
  const r = rate(g);
  const stock = stockAt(g, now);
  const cover = r.mu > 1e-9 ? stock / r.mu : null;
  const watched = g.items.map(itemByKey).filter(Boolean);

  // Cheapest per canonical unit, so brands and pack sizes compare honestly.
  let best = null, bestUnit = Infinity;
  for (const it of watched) {
    const q = toCanon(it.quantity, it.unit, g.canon);
    if (q == null || !it.price) continue;
    const per = it.price / q;
    if (per < bestUnit) { bestUnit = per; best = it; }
  }

  // The best deal we would actually trust: discounted, and recent enough that
  // the price is probably still on the shelf.
  let offer = null;
  for (const it of watched) {
    const d = deal(it);
    if ((d.kind === "fresh" || d.kind === "aging") && d.off >= g.minDiscount) {
      if (!offer || d.off > offer.d.off) offer = { it, d };
    }
  }

  const base = { rate: r, stock, cover, best, bestUnit: isFinite(bestUnit) ? bestUnit : null, offer, watched };

  if (!watched.length) {
    return { ...base, level: "empty", head: "Nothing being watched", sub: "Add a product to start tracking its price." };
  }
  if (cover == null) {
    return { ...base, level: "unknown", head: "No consumption rate yet", sub: "Say roughly how much you use a month and this turns into a real answer." };
  }

  const days = Math.round(cover);
  if (cover <= g.needDays) {
    const s = offer
      ? `${Math.round(offer.d.off * 100)}% off at ${offer.it.store} right now.`
      : best ? `Cheapest is ${best.store} at ${money(bestUnit)} per ${g.canon}.` : "";
    return { ...base, level: "low", head: days <= 0 ? "Out of stock" : `Running out in ${days} ${days === 1 ? "day" : "days"}`, sub: s, action: offer ? offer.it : best };
  }

  if (offer) {
    // Only call it worth stocking up if it will actually get used in time.
    const perPack = toCanon(offer.it.quantity, offer.it.unit, g.canon) || 0;
    const after = r.mu > 1e-9 ? (stock + perPack) / r.mu : Infinity;
    const fits = after <= longestHorizon(g, now, g.shelfDays);
    return {
      ...base,
      level: fits ? "deal" : "deal-full",
      head: fits ? `Worth stocking up — ${Math.round(offer.d.off * 100)}% off` : `${Math.round(offer.d.off * 100)}% off, but you have plenty`,
      sub: fits
        ? `${offer.it.name} at ${offer.it.store}. ${offer.d.note || ""}`
        : `${days} days of cover already, and it keeps ${longestHorizon(g, now, g.shelfDays)} days.`,
      action: offer.it,
    };
  }

  return { ...base, level: "ok", head: `Stocked for ${days} days`, sub: best ? `No deals on. Cheapest is ${best.store} at ${money(bestUnit)} per ${g.canon}.` : "No deals on." };
}

function buy(g, it, opts) {
  const ts = isoToTs(opts.date) || dayFloor(Math.floor(Date.now() / 1000));
  const auto = toCanon(it.quantity, it.unit, g.canon);
  const override = Number(opts.unitsPerPack);
  const units = isFinite(override) && override > 0 ? override : auto;
  const shelfDays = opts.shelfDays || g.shelfDays;
  const openedDays = opts.openedDays || g.openedDays;
  const packs = Math.max(1, Number(opts.packs) || 1);
  const totalUnits = units == null ? 0 : units * packs;

  const d = classify(g, ts, totalUnits, shelfDays, it.price, it.regular);

  const lot = {
    id: S.lotSeq++,
    key: it.key,
    name: it.name,
    store: it.store,
    packs,
    packQty: it.quantity,
    packUnit: it.unit,
    units: totalUnits,
    unitsUnknown: units == null,
    price: it.price * packs,          // paid
    regular: (it.regular ?? it.price) * packs, // what it normally costs
    since: it.since,
    ts,
    shelfDays,
    openedDays,
    opened: false,
    openedTs: null,
    cls: d.cls,
    why: d.why,
    snap: { mu: d.mu, coverBefore: d.coverBefore, coverAfter: d.coverAfter, horizon: d.horizon, off: d.off, stock: d.stock },
  };
  g.lots.push(lot);
  if (d.cls === "need") g.anchorTs = ts;
  ensureOneOpen(g);
  save();
  return lot;
}

function ensureOneOpen(g) {
  const live = g.lots.filter((l) => (l.units || 0) > 0).sort((a, b) => a.ts - b.ts);
  const target = live[0] || null;
  for (const l of g.lots) if (l !== target && l.opened) { l.opened = false; l.openedTs = null; }
  if (target && !target.opened) { target.opened = true; target.openedTs = target.openedTs || target.ts; }
}

function removeLot(g, id) {
  g.lots = g.lots.filter((l) => l.id !== id);
  ensureOneOpen(g);
  save();
}

/** Re-run classification on every lot in order. Used after settings change. */
function reclassify(g) {
  const lots = [...g.lots].sort((a, b) => a.ts - b.ts);
  g.lots = [];
  g.anchorTs = null;
  for (const l of lots) {
    const d = classify(g, l.ts, l.units || 0, l.shelfDays, l.price / l.packs, l.regular / l.packs);
    l.cls = d.cls;
    l.why = d.why;
    l.snap = { mu: d.mu, coverBefore: d.coverBefore, coverAfter: d.coverAfter, horizon: d.horizon, off: d.off, stock: d.stock };
    g.lots.push(l);
    if (d.cls === "need") g.anchorTs = l.ts;
  }
  ensureOneOpen(g);
  save();
}

/* =============================================================== simulation */

function simulate(g, startTs, days) {
  const mu = rate(g, startTs).mu;
  const lots = g.lots.map((l) => ({ ...l }));
  const active = lots.filter((l) => l.ts <= startTs);
  const pending = lots.filter((l) => l.ts > startTs).sort((a, b) => a.ts - b.ts);

  // Anything already past its date is gone before the forecast begins. It is
  // not waste the next 30 days can still avoid, and counting it as such would
  // contradict the on-hand figure, which excludes it.
  let alreadyLost = 0;
  for (const l of active) {
    if ((l.units || 0) > 0 && lotExpiry(g, l, startTs) < dayFloor(startTs)) {
      alreadyLost += l.units;
      l.units = 0;
    }
  }

  const out = [];
  let dayTs = dayFloor(startTs);
  let firstEmpty = null;
  let totalWaste = 0;

  for (let d = 1; d <= days; d++) {
    const events = [];
    let waste = 0;

    for (const l of active) {
      if ((l.units || 0) > 0 && lotExpiry(g, l, dayTs) < dayTs) {
        waste += l.units;
        events.push(`${l.units.toFixed(2)} ${g.canon} expired`);
        l.units = 0;
      }
    }
    while (pending.length && dayFloor(pending[0].ts) <= dayTs) {
      const l = pending.shift();
      active.push(l);
      events.push(`bought ${l.units.toFixed(2)} ${g.canon}`);
    }

    active.sort((a, b) => lotExpiry(g, a, dayTs) - lotExpiry(g, b, dayTs));
    let need = mu;
    let used = 0;
    for (const l of active) {
      if (need <= 1e-9) break;
      const avail = l.units || 0;
      if (avail <= 1e-9) continue;
      const take = Math.min(avail, need);
      l.units = avail - take;
      need -= take;
      used += take;
    }

    const remaining = active.reduce((s, l) => s + (l.units || 0), 0);
    const short = used + 1e-9 < mu;
    if (short && firstEmpty == null) firstEmpty = d;
    totalWaste += waste;

    out.push({ day: d, date: tsToISO(dayTs), mu, used, waste, remaining, short, events: events.join(", ") });
    dayTs += DAY;
  }
  return { rows: out, mu, firstEmpty, totalWaste, alreadyLost };
}

/* ============================================================== spend ledger */

function spendSeries(g) {
  const lots = [...g.lots].sort((a, b) => a.ts - b.ts);
  const pts = [];
  let actual = 0, regular = 0;
  for (const l of lots) {
    actual += l.price || 0;
    regular += l.regular || l.price || 0;
    pts.push({ ts: l.ts, actual, regular, lot: l });
  }
  return pts;
}

function classSummary(g) {
  const acc = {};
  for (const k of Object.keys(CLASSES)) acc[k] = { n: 0, spend: 0, regular: 0, units: 0, offSum: 0 };
  for (const l of g.lots) {
    const a = acc[l.cls] || acc.topup;
    a.n++;
    a.spend += l.price || 0;
    a.regular += l.regular || l.price || 0;
    a.units += l.units || 0;
    a.offSum += l.snap ? l.snap.off : 0;
  }
  for (const k of Object.keys(acc)) acc[k].avgOff = acc[k].n ? acc[k].offSum / acc[k].n : 0;
  return acc;
}

/* ==================================================================== output */

function money(n) {
  if (n == null || !isFinite(n)) return "—";
  return n.toFixed(2).replace(".", ",") + " kr";
}
function plural(n, one, many) {
  return `${n} ${n === 1 ? one : (many || one + "s")}`;
}
function num(n, d = 2) {
  return n == null || !isFinite(n) ? "—" : n.toFixed(d).replace(".", ",");
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), 2600);
}

/* Export for the view layer. */
window.Kurv = {
  DAY, MONTH_DAYS, CANON_UNITS, CLASSES,
  get S() { return S; }, set S(v) { S = v; },
  save, load, group, activeGroup, addGroup, removeGroup, blankGroup,
  CAT, loadCatalog, item, itemByKey, itemKey, search,
  deal, dataAgeDays, snapshotISO,
  toCanon, guessCanon, cleanUnit, priorMu, rate,
  stockAt, lotExpiry, classify, buy, removeLot, reclassify, ensureOneOpen,
  simulate, spendSeries, classSummary, verdict, longestHorizon,
  money, num, plural, toast, todayISO, isoToTs, tsToISO, dayFloor, fmtDate, daysBetween, normalizeName,
};
