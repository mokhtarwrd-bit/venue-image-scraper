#!/usr/bin/env node
// =============================================================================
// discover-maps.js — PROSPECTING tool. Query -> list of qualified leads.
//
// This is NOT orchestrate.js. That script enriches ONE venue you already have
// (and downloads its imagery). This one finds venues you DON'T have yet.
// Output is a ranked CSV list, not an image tree.
//
//   TIER 1  sweep the Maps search feed          -> name, rating, reviews, CID
//   TIER 2  visit each place page (existing      -> phone, address, WEBSITE
//           analyzeListing) and classify
//
// Tier 2 exists because card-level website detection is provably wrong: the feed
// claimed 50/54 Marrakech restaurants had no site; spot-checking 3 disproved 2.
// The website verdict ONLY ever comes from the place page.
//
// Owner's priority: slow > fast. Never get blocked. Every phase is jittered,
// serial, rests periodically, stops dead on a challenge, and saves after every
// single record so a halted run resumes instead of restarting.
//
// USAGE
//   node scripts/discover-maps.js --city "Marrakech" --queries "restaurants"
//   node scripts/discover-maps.js --city "Marrakech" \
//        --queries "moroccan restaurant,seafood restaurant,rooftop restaurant" \
//        --center 31.6295,-7.9811 --grid 3 --spread 0.02 \
//        --min-rating 4.0 --min-reviews 30
//
// FLAGS
//   --city <name>          city label (also appended to bare queries)
//   --queries "a,b,c"      comma-separated category terms (default "restaurants")
//   --center lat,lng       anchor point for geographic tiling
//   --grid <n>             n x n tile grid around center (default 1 = no tiling)
//   --spread <deg>         degrees between tiles (default 0.02 ~ 2km)
//   --zoom <n>             tile zoom level (default 15)
//   --min-rating <n>       Tier-1 gate before deep-visiting (default 0 = all)
//   --min-reviews <n>      Tier-1 gate before deep-visiting (default 0 = all)
//   --deep all|none        deep-pass scope (default all that pass the gates)
//   --max-deep <n>         hard cap on place visits this run (default 500)
//   --slow                 extra-conservative pacing (roughly doubles all gaps)
//   --resume               reuse a previous run's deep results in the same out dir
//   --out <dir>            output dir (default leads/_prospects/<city>-<date>)
//   --port <n>             CDP port (default 9222)
// =============================================================================

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getClient, closeClient } from './lib/cdp.js';
import { analyzeListing } from './sources/googleMaps.js';
import { buildSearchUrls, sweepFeed, classifyWebsite, scoreProspect } from './sources/mapsDiscovery.js';
import { wait, jitter } from './lib/pacing.js';
import { slugify } from './lib/util.js';

// ---------------------------------------------------------------- arg parsing
function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    const v = (a[i + 1] && !a[i + 1].startsWith('--')) ? a[++i] : 'true';
    o[k] = v;
  }
  return o;
}
const A = args();
const SLOW = A.slow === 'true';
const M = SLOW ? 2 : 1; // pacing multiplier

const CITY = A.city || '';
const QUERIES = (A.queries || 'restaurants').split(',').map(s => s.trim()).filter(Boolean);
const CENTER = A.center ? (([la, ln]) => ({ lat: +la, lng: +ln }))(A.center.split(',')) : null;
const GRID = parseInt(A.grid || '1', 10);
const SPREAD = parseFloat(A.spread || '0.02');
const ZOOM = parseInt(A.zoom || '15', 10);
const MIN_RATING = parseFloat(A['min-rating'] || '0');
const MIN_REVIEWS = parseInt(A['min-reviews'] || '0', 10);
const DEEP = A.deep || 'all';
const MAX_DEEP = parseInt(A['max-deep'] || '500', 10);
const PORT = parseInt(A.port || '9222', 10);
const RESUME = A.resume === 'true';
// Re-run only the deep pass over an existing sweep (implies --resume).
const SKIP_T1 = A['skip-tier1'] === 'true';

const today = new Date().toISOString().slice(0, 10);
const OUT = A.out || join('leads', '_prospects', slugify(`${CITY || 'sweep'}-${today}`));
const F_JSON = join(OUT, 'discovery.json');
const F_CSV = join(OUT, 'leads.csv');
const F_LOG = join(OUT, 'run-log.json');

mkdirSync(OUT, { recursive: true });

const log = [];
function say(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  log.push(line);
}

// ------------------------------------------------------------------ csv utils
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const CSV_COLS = [
  'priority', 'websiteStatus', 'name', 'rating', 'reviewCount', 'phone',
  'category', 'address', 'website', 'websiteHost', 'city', 'query', 'cid', 'mapsUrl',
];
function writeCsv(rows) {
  const order = { hot: 0, warm: 1, cool: 2, low: 3 };
  const sorted = [...rows].sort((a, b) =>
    (order[a.priority] ?? 9) - (order[b.priority] ?? 9) ||
    (b.reviewCount ?? 0) - (a.reviewCount ?? 0));
  const body = sorted.map(r => CSV_COLS.map(c => csvCell(r[c])).join(',')).join('\n');
  writeFileSync(F_CSV, CSV_COLS.join(',') + '\n' + body, 'utf8');
}

function save(records) {
  writeFileSync(F_JSON, JSON.stringify({
    generatedAt: new Date().toISOString(),
    city: CITY, queries: QUERIES,
    tiling: CENTER ? { center: CENTER, grid: GRID, spread: SPREAD, zoom: ZOOM } : null,
    gates: { minRating: MIN_RATING, minReviews: MIN_REVIEWS },
    counts: summarize(records),
    records,
  }, null, 2), 'utf8');
  writeCsv(records);
  writeFileSync(F_LOG, JSON.stringify(log, null, 2), 'utf8');
}

function summarize(rs) {
  const c = { total: rs.length, deepDone: 0, none: 0, social_or_platform: 0, own_domain: 0, hot: 0, warm: 0, cool: 0, low: 0 };
  for (const r of rs) {
    if (r.deepDone) c.deepDone++;
    if (r.websiteStatus && c[r.websiteStatus] != null) c[r.websiteStatus]++;
    if (r.priority && c[r.priority] != null) c[r.priority]++;
  }
  return c;
}

// ===================================================================== the run
let client = null; // Tier 2 tab, opened after the sweep. Tier 1 opens its own per search.
let records = [];
const byCid = new Map();

// Resume: rehydrate prior deep results so we never re-visit a place.
if ((RESUME || SKIP_T1) && existsSync(F_JSON)) {
  try {
    const prev = JSON.parse(readFileSync(F_JSON, 'utf8'));
    for (const r of prev.records || []) byCid.set(r.cid, r);
    say(`RESUME: loaded ${byCid.size} prior records (${[...byCid.values()].filter(r => r.deepDone).length} already deep-visited)`);
  } catch (e) { say(`RESUME failed to read prior file: ${e.message}`); }
}

try {
  // ------------------------------------------------------------- TIER 1 sweep
  if (SKIP_T1) say(`TIER 1 skipped (--skip-tier1) — using ${byCid.size} venues already on disk`);
  const urls = SKIP_T1 ? [] : buildSearchUrls({ queries: QUERIES, city: CITY, center: CENTER, grid: GRID, spread: SPREAD, zoom: ZOOM });
  say(`TIER 1 — ${urls.length} search(es) queued (${QUERIES.length} quer${QUERIES.length === 1 ? 'y' : 'ies'} x ${urls.length / QUERIES.length} tile(s))`);

  for (let i = 0; i < urls.length; i++) {
    const { url, query, at } = urls[i];
    const tag = at ? `@${at.lat},${at.lng}` : 'no-tile';
    say(`  [${i + 1}/${urls.length}] "${query}" ${tag}`);

    // FRESH TAB PER SEARCH. Reusing one tab across many Maps navigations let SPA
    // state accumulate and tiles silently returned 4 results while the first
    // returned 104. A new tab costs nothing and makes each sweep independent.
    let res;
    const tab = await getClient({ port: PORT });
    try {
      res = await sweepFeed(tab, url, {
        minPause: 2500 * M, maxPause: 5000 * M,
        onProgress: ({ round, count, end, warn }) => {
          if (warn) say(`      !! WARN ${warn}`);
          else if (round % 6 === 0 || end) say(`      scroll ${round}: ${count} places${end ? ' [END MARKER]' : ''}`);
        },
      });
    } finally { await closeClient(tab); }

    if (!res.ok) {
      say(`      !! BLOCKED (${res.block.reason}) — stopping Tier 1 immediately, keeping what we have.`);
      break;
    }
    if (res.cards.length < 12 && !res.endMarker) {
      say(`      !! LOW YIELD (${res.cards.length} cards, no end marker) — this tile is suspect, not trusted as complete.`);
    }

    let fresh = 0;
    for (const c of res.cards) {
      if (byCid.has(c.cid)) continue;
      byCid.set(c.cid, { ...c, city: CITY, query, deepDone: false, websiteStatus: null, priority: null });
      fresh++;
    }
    say(`      -> ${res.cards.length} cards (${fresh} new, ${res.droppedSponsored} sponsored dropped) | running total ${byCid.size}`);

    records = [...byCid.values()];
    save(records);

    if (i < urls.length - 1) {
      const rest = jitter(8000 * M, 16000 * M);
      say(`      resting ${(rest / 1000).toFixed(0)}s before next search`);
      await wait(rest);
    }
  }

  records = [...byCid.values()];
  say(`TIER 1 complete — ${records.length} unique venues (deduped by CID)`);

  // -------------------------------------------------------------- TIER 2 deep
  if (DEEP === 'none') {
    say('TIER 2 skipped (--deep none). NOTE: website status is UNKNOWN without it.');
  } else {
    const queue = records.filter(r =>
      !r.deepDone &&
      (r.rating ?? 0) >= MIN_RATING &&
      (r.reviewCount ?? 0) >= MIN_REVIEWS
    ).slice(0, MAX_DEEP);

    say(`TIER 2 — ${queue.length} place pages to visit (gates: rating>=${MIN_RATING}, reviews>=${MIN_REVIEWS}); this is the slow part`);

    client = await getClient({ port: PORT });
    let done = 0, blocked = false;
    for (const rec of queue) {
      if (blocked) break;
      const cidDec = BigInt('0x' + rec.cid).toString(10);
      const url = `https://www.google.com/maps?cid=${cidDec}&hl=en`;

      let r;
      try {
        r = await analyzeListing(client, url);
      } catch (e) {
        say(`  ${rec.name} — ERROR ${e.message}; skipping`);
        continue;
      }

      if (r.block) {
        say(`  !! BLOCKED (${r.block.reason}) after ${done} deep visits — stopping and saving.`);
        blocked = true;
        break;
      }

      const f = r.fields || {};
      const cls = classifyWebsite(f.website);
      Object.assign(rec, {
        name: f.name || rec.name,
        rating: f.rating ?? rec.rating,
        reviewCount: f.reviewCount ?? rec.reviewCount,
        category: f.category || rec.category,
        address: f.address || null,
        phone: f.phone || null,
        website: f.website || null,
        ...cls,
        geo: f.geo || null,
        mapsUrl: url,
        deepDone: true,
      });
      rec.priority = scoreProspect(rec);

      done++;
      say(`  [${done}/${queue.length}] ${rec.name} | ${rec.rating ?? '?'}* ${rec.reviewCount ?? '?'} | ${rec.phone || 'no phone'} | site: ${rec.websiteStatus} | ${rec.priority.toUpperCase()}`);

      save([...byCid.values()]); // save after EVERY record — resumable

      // Pace. analyzeListing already burns ~5-9s internally; add a real gap on
      // top, plus a longer rest every 12 visits so we never look like a crawler.
      await wait(jitter(6000 * M, 12000 * M));
      if (done % 12 === 0 && done < queue.length) {
        const rest = jitter(45000 * M, 90000 * M);
        say(`      -- long rest ${(rest / 1000).toFixed(0)}s after ${done} visits, recycling tab --`);
        await wait(rest);
        // Recycle the tab too — same reason as Tier 1: don't let SPA state pile up.
        try { await closeClient(client); } catch { /* already gone */ }
        client = await getClient({ port: PORT });
      }
    }
  }

  records = [...byCid.values()];
  save(records);

  const s = summarize(records);
  say('');
  say('================ SWEEP COMPLETE ================');
  say(`venues found      : ${s.total}`);
  say(`deep-visited      : ${s.deepDone}`);
  say(`NO website        : ${s.none}      <- prime prospects`);
  say(`social/platform   : ${s.social_or_platform}      <- also prospects (stopgap web presence)`);
  say(`own domain        : ${s.own_domain}      <- deprioritise`);
  say(`priority hot/warm : ${s.hot} / ${s.warm}`);
  say(`JSON -> ${F_JSON}`);
  say(`CSV  -> ${F_CSV}`);
  save(records);
} finally {
  if (client) await closeClient(client);
}
