#!/usr/bin/env node
/*
 * Downloads the full dagligepriser canonical dump and boils it down to a slim
 * catalog the phone can actually load.
 *
 * The expensive part is the price history. Every item carries a list of change
 * points; we replay them into day-weighted segments and derive, once, the three
 * numbers the app needs at runtime:
 *
 *   regular  the price the item sits at on most days over the trailing window
 *            (time-weighted mode, not the year high) -- this is the "what it
 *            costs when nobody is running a promo" number
 *   since    the date the current price took effect
 *   high     the highest price seen in the window, kept for context
 *
 * Output is two files:
 *   meta.json     tiny, fetched on every app open to check freshness
 *   catalog.json  the slim rows, cached on device until meta.built changes
 */

import { writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

const SOURCE = process.env.SOURCE_URL || "https://dagligepriser.dk/data/latest-canonical.json";
const OUT_DIR = process.env.OUT_DIR || "dist/data";
const WINDOW_DAYS = 365; // trailing window for regular-price and high
const MS_DAY = 86400000;

// ---------------------------------------------------------------- date utils

function toDay(iso) {
  // "2026-07-30" -> integer day number. Cheap and allocation-free enough.
  const y = +iso.slice(0, 4);
  const m = +iso.slice(5, 7);
  const d = +iso.slice(8, 10);
  return Math.floor(Date.UTC(y, m - 1, d) / MS_DAY);
}

function fromDay(n) {
  return new Date(n * MS_DAY).toISOString().slice(0, 10);
}

// ------------------------------------------------------------ price analysis

/**
 * Replay the change points into segments and derive the reference numbers.
 * `history` is the raw priceHistory array (descending by date per upstream).
 */
function analyse(history, currentPrice, todayDay) {
  const pts = [];
  for (const e of history || []) {
    if (!e || typeof e.price !== "number" || !e.date) continue;
    const d = String(e.date).slice(0, 10);
    if (d.length !== 10) continue;
    pts.push([toDay(d), e.price]);
  }

  if (!pts.length) {
    return { regular: currentPrice, since: null, high: currentPrice, points: 0 };
  }

  pts.sort((a, b) => a[0] - b[0]); // ascending

  const windowStart = todayDay - WINDOW_DAYS;
  const held = new Map(); // price (2dp string) -> days held inside window
  let high = -Infinity;

  for (let i = 0; i < pts.length; i++) {
    const from = pts[i][0];
    const price = pts[i][1];
    const to = i + 1 < pts.length ? pts[i + 1][0] : todayDay + 1;

    const clippedFrom = Math.max(from, windowStart);
    const clippedTo = Math.min(to, todayDay + 1);
    const days = clippedTo - clippedFrom;
    if (days <= 0) continue;

    if (price > high) high = price;
    const key = price.toFixed(2);
    held.set(key, (held.get(key) || 0) + days);
  }

  // Time-weighted mode. Ties break upward: a promo price and a regular price
  // that happen to have been held equally long should resolve to the higher
  // one, otherwise a long sale silently redefines "normal" and every future
  // discount looks like zero.
  let regular = null;
  let bestDays = -1;
  for (const [key, days] of held) {
    const p = +key;
    if (days > bestDays || (days === bestDays && p > regular)) {
      bestDays = days;
      regular = p;
    }
  }

  if (regular == null || !isFinite(high)) {
    return { regular: currentPrice, since: fromDay(pts[pts.length - 1][0]), high: currentPrice, points: pts.length };
  }

  return {
    regular,
    since: fromDay(pts[pts.length - 1][0]),
    high,
    points: pts.length,
  };
}

// -------------------------------------------------------------------- driver

async function main() {
  console.log(`Fetching ${SOURCE} ...`);
  const t0 = Date.now();
  const res = await fetch(SOURCE, {
    headers: { "user-agent": "kurv-price-tracker (personal, github actions)" },
  });
  if (!res.ok) throw new Error(`Source returned ${res.status} ${res.statusText}`);

  const lastModified = res.headers.get("last-modified");
  const raw = await res.json();
  console.log(`Fetched ${raw.length.toLocaleString()} items in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const todayDay = Math.floor(Date.now() / MS_DAY);
  const rows = [];
  const stores = new Set();
  let withHistory = 0;
  let discounted = 0;

  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const name = it.name;
    const price = it.price;
    if (!name || typeof price !== "number" || !isFinite(price)) continue;

    const store = it.store || "";
    const a = analyse(it.priceHistory, price, todayDay);
    if (a.points > 1) withHistory++;
    if (a.regular > price + 0.001) discounted++;
    stores.add(store);

    rows.push([
      store,
      name,
      round2(price),
      typeof it.quantity === "number" ? it.quantity : null,
      it.unit || "",
      round2(a.regular),
      a.since,
      round2(a.high),
    ]);
  }

  // Sort by store then name: helps gzip a lot, since adjacent names share
  // prefixes. Costs nothing at runtime because search is a linear scan anyway.
  rows.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : 1));

  const built = new Date().toISOString();
  const meta = {
    built,
    source: SOURCE,
    sourceLastModified: lastModified || null,
    count: rows.length,
    withHistory,
    discounted,
    stores: [...stores].filter(Boolean).sort(),
    fields: ["store", "name", "price", "quantity", "unit", "regular", "since", "high"],
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "meta.json"), JSON.stringify(meta));
  await writeFile(join(OUT_DIR, "catalog.json"), JSON.stringify({ built, rows }));

  const size = (await stat(join(OUT_DIR, "catalog.json"))).size;
  console.log(`Wrote ${rows.length.toLocaleString()} rows, ${(size / 1048576).toFixed(1)} MB raw`);
  console.log(`  ${withHistory.toLocaleString()} have real price history`);
  console.log(`  ${discounted.toLocaleString()} are currently below their usual price`);
}

function round2(n) {
  return typeof n === "number" && isFinite(n) ? Math.round(n * 100) / 100 : null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
