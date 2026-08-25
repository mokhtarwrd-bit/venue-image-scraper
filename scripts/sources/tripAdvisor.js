// =============================================================================
// sources/tripAdvisor.js — IMAGE source for venues RG/Maps can't cover.
//
// Why this exists: a dry run proved a real coverage gap —
// Restaurant Guru had NO listing for the venue, so the anchor source returned 0
// images and the run was blocked. The venue's photos DO live on TripAdvisor.
// This module harvests those, at full resolution, into images/_incoming/.
//
// Method (mirrors restaurantGuru.js): real Chrome via CDP (lib/cdp). TripAdvisor
// is a heavy SPA behind a JS challenge — navigate() fires on the load event
// BEFORE the venue hydrates, so we SETTLE until the <h1> appears (proven: a read
// at +4s returned an 1555-byte interstitial; a read at +18s returned the real
// 800KB page with 55 venue photos). Then we natural-scroll to lazy-load the
// inline photo strip and read the dynamic-media-cdn image URLs.
//
// Resolution: the CDN's `?w=&h=&s=` query is the downscaler (900x500 = 55KB),
// not the `/photo-<x>/` tier alone. rewriteTripAdvisor() strips the query to get
// the original master (2048x1536+ proven). See lib/download.js for the rule.
//
// Anti-block: serial, human pacing, block-aware via assessResponse(). On a
// 403/429/challenge/near-empty body we STOP and flag incomplete — never retry
// into a block, never fabricate images or counts. Capped to MAX_IMAGES to
// respect ToS/volume.
//
// Rights: every harvested image is recorded source="tripadvisor" + its original
// CDN URL. These are SWAPPABLE placeholders (third-party rights) — the client's
// own photography replaces them before publish. We never claim ownership.
// =============================================================================

import { navigate, getOuterHTML } from '../lib/cdp.js';
import { humanPause, naturalScroll, assessResponse, wait } from '../lib/pacing.js';
import { rewriteTripAdvisor } from '../lib/download.js';

// Cap to a sane number to respect ToS/volume (a restaurant site needs ~15-25
// usable images; we cap candidates above that so Stage A has headroom to reject).
const MAX_IMAGES = 36;

// The venue photo CDN host. Anything else (static.tacdn badges, svg icons,
// user avatars) is NOT a venue photo and is excluded.
const VENUE_PHOTO_RE = /dynamic-media-cdn\.tripadvisor\.com\/media\/photo/i;

// Validate / accept a TripAdvisor restaurant-review URL. We do NOT resolve from
// name+city here (TA's search is its own brittle surface and the orchestrator is
// given the exact lead URL) — a direct review URL is required. Honest about it.
export function resolveListing({ directUrl }) {
  if (directUrl && /tripadvisor\.[a-z.]+\/Restaurant_Review/i.test(directUrl)) {
    return { url: directUrl, resolvedVia: 'direct_url' };
  }
  if (directUrl && /tripadvisor\.[a-z.]+\//i.test(directUrl)) {
    // A TA URL but not a Restaurant_Review page — accept but note it.
    return { url: directUrl, resolvedVia: 'direct_url_nonreview' };
  }
  return { url: null, resolvedVia: 'requires_direct_url' };
}

// Navigate + SETTLE until the venue hydrates (h1 present) or a ceiling. Returns
// { ok, html, h1, block? }. Block is set (with a real reason) when the page is a
// challenge / near-empty / never hydrates — caller flags incomplete, no fakery.
async function loadVenue(client, url) {
  await navigate(client, url, { timeoutMs: 40000 });
  // First settle — TA serves a JS challenge that resolves into the real page.
  await humanPause(6000, 9000);

  // Poll for hydration: the venue <h1> appears only once the SPA has rendered.
  let h1 = null;
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const r = await client.Runtime.evaluate({
      expression: 'document.querySelector("h1") ? document.querySelector("h1").textContent.trim() : null',
      returnByValue: true,
    });
    h1 = r.result.value;
    if (h1) break;
    await wait(2000);
  }

  const html = await getOuterHTML(client);

  // Block-aware gate (same ladder RG/Maps use). A still-tiny body or challenge
  // text after the settle window means we were blocked — STOP and flag.
  const gate = assessResponse({ bodyLength: html.length, challengeText: html.slice(0, 6000) });
  if (!gate.ok || !h1) {
    return {
      ok: false,
      html,
      h1,
      block: gate.ok
        ? { ok: false, verdict: 'STOP', reason: 'no_hydration', flag: 'source_incomplete' }
        : gate,
    };
  }
  return { ok: true, html, h1 };
}

// Scroll the review page to lazy-load the inline photo strip, then read every
// venue-photo CDN URL from the live DOM, rewrite to full res, dedupe by photo
// path, and cap. Returns the URL array (never throws; empty array is honest).
async function collectImageUrls(client, { max = MAX_IMAGES } = {}) {
  // Natural scroll triggers the lazy-loaded photo carousel + review thumbnails.
  await naturalScroll(client, { steps: 12 });
  await humanPause(2000, 4000);

  const r = await client.Runtime.evaluate({
    expression: `(() => {
      const out = [];
      const push = u => { if (u) out.push(u.split(' ')[0]); };
      for (const img of document.querySelectorAll('img')) {
        push(img.getAttribute('data-src') || img.getAttribute('src'));
        const ss = img.getAttribute('srcset');
        if (ss) ss.split(',').forEach(s => push(s.trim()));
      }
      // some TA galleries paint photos as CSS background-image
      for (const el of document.querySelectorAll('[style*="background-image"]')) {
        const m = (el.getAttribute('style')||'').match(/url\\((['"]?)(.*?)\\1\\)/);
        if (m) push(m[2]);
      }
      return out;
    })()`,
    returnByValue: true,
  });

  const byPath = new Map();
  for (let raw of (r.result.value || [])) {
    if (!raw) continue;
    if (raw.startsWith('//')) raw = 'https:' + raw;
    if (!/^https?:/.test(raw)) continue;
    if (!VENUE_PHOTO_RE.test(raw)) continue;        // venue photos only
    if (/\.(svg|gif)(\?|$)/i.test(raw)) continue;   // icons/spinners
    const full = rewriteTripAdvisor(raw);
    const key = full.split('?')[0];                 // dedupe by photo id/path
    if (!byPath.has(key)) byPath.set(key, full);
  }
  return [...byPath.values()].slice(0, max);
}

// Public entrypoint mirroring the orchestrator's expectations. Given a connected
// CDP client and a TA review URL, returns:
//   { ok, h1, urls: string[], block? }
// urls are full-res, deduped, capped. ok=false + block on a real block/no-render.
export async function harvest(client, url) {
  const loaded = await loadVenue(client, url);
  if (!loaded.ok) {
    return { ok: false, h1: loaded.h1 || null, urls: [], block: loaded.block };
  }
  const urls = await collectImageUrls(client);
  return { ok: true, h1: loaded.h1, urls };
}

export { MAX_IMAGES };
