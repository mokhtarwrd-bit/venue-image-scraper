// =============================================================================
// sources/mapsDiscovery.js — Google Maps LEAD DISCOVERY (Tier 1).
//
// This is PROSPECTING, not per-lead enrichment. It answers "who are the
// restaurants in Marrakech?" — it does NOT build a client profile. The per-lead
// extractor (sources/googleMaps.js analyzeListing) is Tier 2 and stays untouched.
//
// MEASURED FACTS this module is built on (probed live 2026-07-31):
//   - Results rail is `div[role="feed"]`, cards are `.Nv2PK`.
//   - The feed LAZY-LOADS: 5 links at first paint, ~54 after ~15 scrolls.
//   - The CID lives in the card href (0x<hex>:0x<cid-hex>) -> our dedupe key.
//   - ~4/54 cards are "Sponsored" ads and must be dropped.
//   - !! Card-level website detection is a FALSE-NEGATIVE MACHINE. The card said
//     "no website" for 50/54; spot-checking 3 disproved 2 immediately (two of them
//     did in fact have sites). We therefore NEVER report a
//     website verdict from Tier 1 — websiteKnown stays false until Tier 2.
//
// Owner's stated priority: slow is fine, DO NOT get blocked. All pacing here is
// deliberately conservative and jittered, and we stop rather than hammer.
// =============================================================================

import { navigate, getOuterHTML } from '../lib/cdp.js';
import { wait, jitter, assessResponse } from '../lib/pacing.js';

// Force English UI so our label/regex parsing is deterministic (see the hl=en
// note in sources/googleMaps.js — a French render silently nulls fields).
function withEnglish(url) {
  return url.includes('hl=') ? url : url + (url.includes('?') ? '&' : '?') + 'hl=en';
}

// -----------------------------------------------------------------------------
// Search URL construction.
//
// A single Maps query caps out around 50-60 results (measured: 54, and it never
// printed the "end of the list" marker — it just stopped feeding). Volume comes
// from two free multipliers, which is exactly what the paid actors do:
//   1. CATEGORY SPLITTING — several queries ("seafood restaurant", "rooftop...")
//   2. GEOGRAPHIC TILING  — /maps/search/<q>/@<lat>,<lng>,<zoom>z over a grid
// Cross-product them and dedupe by CID.
// -----------------------------------------------------------------------------
export function buildSearchUrls({ queries = [], city = '', center = null, grid = 1, spread = 0.02, zoom = 15 }) {
  const urls = [];
  const points = [];

  if (center && grid > 1) {
    const half = (grid - 1) / 2;
    for (let i = 0; i < grid; i++) {
      for (let j = 0; j < grid; j++) {
        points.push({
          lat: +(center.lat + (i - half) * spread).toFixed(6),
          lng: +(center.lng + (j - half) * spread).toFixed(6),
        });
      }
    }
  } else if (center) {
    points.push({ lat: center.lat, lng: center.lng });
  } else {
    points.push(null); // no geo anchor; let Maps resolve from the query text
  }

  for (const q of queries) {
    const term = city && !q.toLowerCase().includes(city.toLowerCase()) ? `${q} in ${city}` : q;
    for (const p of points) {
      const base = `https://www.google.com/maps/search/${encodeURIComponent(term)}`;
      const url = p ? `${base}/@${p.lat},${p.lng},${zoom}z` : base;
      urls.push({ url: withEnglish(url), query: term, at: p });
    }
  }
  return urls;
}

// -----------------------------------------------------------------------------
// The in-page card reader. Defined as a real function and stringified into the
// page so we never fight backslash escaping in a template literal.
// -----------------------------------------------------------------------------
function __readCards() {
  const cards = [];
  const anchors = document.querySelectorAll('a[href*="/maps/place/"]');
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    const card = a.closest('.Nv2PK') || a.parentElement;
    const text = card ? (card.innerText || '') : '';

    // CID: the stable identity key, straight out of the href.
    const cidM = href.match(/0x[0-9a-f]+:0x([0-9a-f]+)/i);

    // Rating + review count render together as "4.8(8,098)".
    const rM = text.match(/([0-5][.,]\d)\s*\(([\d.,\s]+)\)/);

    // The category line is the "·"-separated line that is NOT the price line.
    // Price lines look like "MAD 50-100" / "$$" — exclude those explicitly.
    let category = null, addressHint = null;
    for (const line of text.split('\n')) {
      if (!line.includes('·')) continue;
      if (/^\s*[0-5][.,]\d\s*\(/.test(line)) continue;      // rating line
      if (/MAD|\$|€|\d+\s*[-–]\s*\d+/.test(line)) continue;  // price line
      const parts = line.split('·').map(s => s.trim()).filter(Boolean);
      if (parts.length) {
        category = parts[0] || null;
        addressHint = parts.slice(1).join(' · ') || null;
        break;
      }
    }

    cards.push({
      name: a.getAttribute('aria-label') || null,
      rating: rM ? parseFloat(rM[1].replace(',', '.')) : null,
      reviewCount: rM ? parseInt(rM[2].replace(/[.,\s]/g, ''), 10) : null,
      category,
      addressHint,
      cid: cidM ? cidM[1] : null,
      placeUrl: href.split('?')[0],
      sponsored: /(^|\n)\s*Sponsored\s*(\n|$)/i.test(text),
    });
  }
  return cards;
}

// -----------------------------------------------------------------------------
// Tier 1: sweep one search URL. Scrolls the feed slowly until it stops growing.
// Returns { ok, cards, rounds, endMarker, block }.
// -----------------------------------------------------------------------------
export async function sweepFeed(client, url, {
  maxRounds = 80,
  stagnantLimit = 6,
  minPause = 2500,
  maxPause = 5000,
  // A sweep that stalls at a tiny count almost certainly hasn't finished
  // hydrating — Maps does not genuinely return 4 restaurants for a major city.
  // Below this count we refuse to accept stagnation until we've been patient.
  implausibleBelow = 12,
  patienceRounds = 3,
  onProgress = () => {},
} = {}) {
  await navigate(client, url, { timeoutMs: 45000 });
  await wait(jitter(5000, 8000)); // let the SPA hydrate

  // DO NOT enlarge the viewport here. Tried it (1280x1600) and it HALVED the
  // yield: 8 results instead of 54. A tall viewport removes the feed's overflow,
  // so `scrollTop = scrollHeight` becomes a no-op and lazy-loading never fires.
  // The feed must actually be scrollable for Maps to paginate. Measured 2026-07-31.

  const html = await getOuterHTML(client);
  const gate = assessResponse({ bodyLength: html.length, challengeText: html.slice(0, 6000) });
  if (!gate.ok) return { ok: false, cards: [], rounds: 0, endMarker: false, block: gate };

  let last = 0, stagnant = 0, rounds = 0, endMarker = false, patienceUsed = 0;
  for (; rounds < maxRounds; rounds++) {
    const r = await client.Runtime.evaluate({
      expression: `(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (!feed) return { n: 0, end: false, noFeed: true };
        // Belt and braces: set scrollTop AND dispatch a real wheel event. Some
        // Maps builds only paginate on the wheel event.
        feed.scrollTop = feed.scrollHeight;
        feed.dispatchEvent(new WheelEvent('wheel', { deltaY: 1200, bubbles: true }));
        return {
          n: feed.querySelectorAll('a[href*="/maps/place/"]').length,
          end: /reached the end of the list/i.test(feed.innerText || ''),
          noFeed: false,
          // Diagnostics: if scrollH <= clientH the feed cannot scroll, so it will
          // never paginate. That silently caps the sweep — surface it loudly.
          scrollable: feed.scrollHeight > feed.clientHeight + 10,
          scrollH: feed.scrollHeight, clientH: feed.clientHeight,
        };
      })()`,
      returnByValue: true,
    });
    const { n, end, noFeed, scrollable, scrollH, clientH } = r.result.value || {};
    if (noFeed) break;
    if (rounds === 0 && !scrollable) {
      onProgress({ round: 0, count: n, end: false, stagnant: 0,
        warn: `feed not scrollable (scrollH=${scrollH} clientH=${clientH}) — pagination will not fire` });
    }

    endMarker = !!end;
    stagnant = (n === last) ? stagnant + 1 : 0;
    last = n;
    onProgress({ round: rounds, count: n, end: endMarker, stagnant });

    if (endMarker) break;

    if (stagnant >= stagnantLimit) {
      // Implausibly low + no end marker => treat as "not hydrated yet", not
      // "finished". Burn a patience round: wait long, then keep trying. This is
      // what fixed tiles silently returning 4 results while tile 1 returned 104.
      if (n < implausibleBelow && patienceUsed < patienceRounds) {
        patienceUsed++;
        onProgress({ round: rounds, count: n, end: false, stagnant,
          warn: `only ${n} results and no end marker — patience ${patienceUsed}/${patienceRounds}, waiting 15s` });
        await wait(jitter(14000, 18000));
        stagnant = 0;
        continue;
      }
      break;
    }
    await wait(jitter(minPause, maxPause));
  }

  const ex = await client.Runtime.evaluate({
    expression: `(${__readCards.toString()})()`,
    returnByValue: true,
  });

  const all = ex.result.value || [];
  return {
    ok: true,
    cards: all.filter(c => c.cid && c.name && !c.sponsored),
    droppedSponsored: all.filter(c => c.sponsored).length,
    rounds, endMarker, block: null,
  };
}

// -----------------------------------------------------------------------------
// Website classification — the field the owner cares about most.
//
// A boolean "has a website" is too blunt for prospecting. A venue whose only web
// presence is a Facebook page, a Linktree, or a menu-app microsite is STILL a
// prime lead — arguably a warmer one, since they've shown they want to be online
// and settled for a stopgap. A venue whose only "website" is a menu-app URL is
// exactly this case.
// -----------------------------------------------------------------------------
const PLATFORM_HOSTS = [
  'facebook.com', 'fb.me', 'instagram.com', 'linktr.ee', 'linktree.com',
  'business.site', 'sites.google.com', 'wixsite.com', 'weebly.com',
  'blogspot.com', 'wordpress.com', 'tumblr.com', 'godaddysites.com',
  'getscopeapp.pro', 'menu.app', 'thefork.com', 'tripadvisor.', 'zomato.com',
  'ubereats.com', 'glovoapp.com', 'deliveroo.', 'opentable.', 'booking.com',
  'airbnb.', 'wa.me', 'whatsapp.com', 'linkedin.com', 'youtube.com', 'tiktok.com',
];

export function classifyWebsite(url) {
  if (!url) return { websiteStatus: 'none', websiteHost: null };
  let host;
  try { host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); }
  catch { return { websiteStatus: 'unknown', websiteHost: null }; }

  if (/^(www\.)?google\./i.test(host)) return { websiteStatus: 'none', websiteHost: null };
  if (PLATFORM_HOSTS.some(h => host.includes(h))) {
    return { websiteStatus: 'social_or_platform', websiteHost: host };
  }
  return { websiteStatus: 'own_domain', websiteHost: host };
}

// Prospect priority: who should you contact first?
export function scoreProspect({ websiteStatus, rating, reviewCount }) {
  if (websiteStatus === 'own_domain') return 'low';
  const r = rating ?? 0, n = reviewCount ?? 0;
  // No real site + proven demand = the sweet spot.
  if (n >= 200 && r >= 4.3) return 'hot';
  if (n >= 50 && r >= 4.0) return 'warm';
  return 'cool';
}

export { withEnglish };
