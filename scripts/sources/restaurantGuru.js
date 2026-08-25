// =============================================================================
// sources/restaurantGuru.js — the ANCHOR source.
//
// Restaurant Guru exposes a rich `Restaurant` JSON-LD block (name, address, geo,
// rating, hours, price, cuisine, phone) AND — crucially — the lead's OWN website
// URL (the spike's key finding). We parse that JSON-LD for listing data, then
// harvest the page's images at full resolution via the per-source rewrite rule.
//
// Method: real Chrome via CDP (lib/cdp). Block-aware via the back-off ladder.
// Read-only; serial; human pacing applied by the orchestrator between sources.
// =============================================================================

import { navigate, getOuterHTML } from '../lib/cdp.js';
import { naturalScroll, humanPause, assessResponse } from '../lib/pacing.js';
import { extractJsonLd, findJsonLdType } from '../lib/util.js';
import { rewriteRestaurantGuru } from '../lib/download.js';

// Real search endpoint (PROVEN 2026-06-25): the public `/search?query=` page
// IGNORES the query and returns a generic "best restaurants" list — that bug
// resolved every lead to a fixed Australian restaurant. The actual typeahead is
// the `search.` subdomain `term` JSON endpoint, which DOES honour `q` and whose
// first detail href is the correct listing (verified against a real venue
// query resolving to its canonical detail page). We hit it Node-side (JSON
// API, CORS-open with the RG referer) to avoid an extra heavy page load.
const TERM_ENDPOINT = 'https://search.restaurantguru.com/term';

// Resolve a Restaurant Guru listing URL from a name+city, OR accept a direct URL.
// Returns { url, resolvedVia, candidates? } or { url:null }.
export async function resolveListing(client, { name, city, directUrl }) {
  if (directUrl && /restaurantguru\.com/i.test(directUrl)) {
    return { url: directUrl, resolvedVia: 'direct_url' };
  }
  const q = `${name} ${city || ''}`.trim();
  const url = `${TERM_ENDPOINT}?q=${encodeURIComponent(q)}&s=1&type=short`;
  let json;
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://restaurantguru.com/',
        'Origin': 'https://restaurantguru.com',
      },
    });
    if (resp.status === 403 || resp.status === 429) {
      return { url: null, resolvedVia: 'term_endpoint', block: { reason: `http_${resp.status}` } };
    }
    json = await resp.json();
  } catch (e) {
    return { url: null, resolvedVia: 'term_endpoint', error: String(e.message || e) };
  }

  const html = (json && json.html) || '';
  if (json && json.has_search_results === false) {
    return { url: null, resolvedVia: 'term_endpoint', candidates: [] };
  }

  // Detail listings live on the main restaurantguru.com domain; the `search.`
  // subdomain links are geo-aliases ("Be nomad-lat...") we do NOT want. Take the
  // first main-domain detail href — that is the top-ranked match for the query.
  const hrefs = [...new Set(
    [...html.matchAll(/href=(?:"|\\")([^"\\>]+)/gi)]
      .map(m => m[1].replace(/\\\//g, '/'))
  )];
  const detail = hrefs.filter(h =>
    /^https?:\/\/restaurantguru\.com\/[^/]+$/.test(h) && !/\/guides\//.test(h)
  );
  if (detail.length) {
    return { url: detail[0], resolvedVia: 'term_endpoint', candidates: detail.slice(0, 5) };
  }
  return { url: null, resolvedVia: 'term_endpoint', candidates: [] };
}

// Map JSON-LD openingHoursSpecification (array or single) into a flat,
// readable hours object. Returns null when absent — we never invent hours.
function parseHours(spec) {
  if (!spec) return null;
  const arr = Array.isArray(spec) ? spec : [spec];
  const out = [];
  for (const h of arr) {
    if (!h) continue;
    const days = h.dayOfWeek
      ? (Array.isArray(h.dayOfWeek) ? h.dayOfWeek : [h.dayOfWeek]).map(d => String(d).split('/').pop())
      : [];
    out.push({ days, opens: h.opens || null, closes: h.closes || null });
  }
  return out.length ? out : null;
}

function asText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.name || v['@id'] || null;
  return String(v);
}

// Pull listing data from the Restaurant JSON-LD. Each field is returned with a
// value or null; the orchestrator records `source` per field. Never fabricates.
export function parseListing(html) {
  const blocks = extractJsonLd(html);
  const r = findJsonLdType(blocks, 'Restaurant')
         || findJsonLdType(blocks, 'FoodEstablishment')
         || findJsonLdType(blocks, 'LocalBusiness');
  if (!r) return { found: false, fields: {}, jsonLdTypesSeen: blocks.map(b => b['@type']).filter(Boolean) };

  const addr = r.address || {};
  const geo = r.geo || {};
  const agg = r.aggregateRating || {};

  const fields = {
    name: asText(r.name),
    description: asText(r.description),
    cuisine: r.servesCuisine
      ? (Array.isArray(r.servesCuisine) ? r.servesCuisine : [r.servesCuisine])
      : null,
    priceRange: r.priceRange || null,
    telephone: r.telephone || null,
    // THE key field from the spike: the lead's OWN website URL.
    website: r.url && !/restaurantguru\.com/i.test(r.url) ? r.url
           : (r.sameAs ? (Array.isArray(r.sameAs) ? r.sameAs.find(u => !/restaurantguru/i.test(u)) : r.sameAs) : null),
    address: {
      street: addr.streetAddress || null,
      locality: addr.addressLocality || null,
      region: addr.addressRegion || null,
      postalCode: addr.postalCode || null,
      country: addr.addressCountry ? asText(addr.addressCountry) : null,
    },
    geo: (geo.latitude != null && geo.longitude != null)
      ? { lat: Number(geo.latitude), lng: Number(geo.longitude) } : null,
    rating: agg.ratingValue != null ? Number(agg.ratingValue) : null,
    reviewCount: agg.reviewCount != null ? Number(agg.reviewCount)
               : (agg.ratingCount != null ? Number(agg.ratingCount) : null),
    hours: parseHours(r.openingHoursSpecification),
    images_from_jsonld: r.image
      ? (Array.isArray(r.image) ? r.image : [r.image]).map(asText).filter(Boolean)
      : [],
  };
  return { found: true, fields, jsonLdTypesSeen: blocks.map(b => b['@type']).filter(Boolean) };
}

// Collect candidate image URLs from the rendered page (gallery + JSON-LD),
// rewritten to full resolution. De-duplicated by path. Caps to `max`.
//
// RG's best photos are the REVIEW/USER images loaded lazily into the #photos
// gallery (full-res masters at /reviews/original/<id>.jpg, proven 1440x960+).
// The on-page card crops (img02 /c<hash>-) are only ~820px, so we scroll the
// gallery to pull the review images in, then prefer those.
export async function collectImageUrls(client, html, { max = 40 } = {}) {
  // Lazy-load the gallery: nudge to the photos view + natural scroll.
  await client.Runtime.evaluate({ expression: 'location.hash = "#photos"' }).catch(() => {});
  await humanPause(1500, 3000);
  await naturalScroll(client, { steps: 8 });
  await humanPause(2000, 4000);
  const html2 = await getOuterHTML(client);

  const urls = new Set();

  // 1) JSON-LD images
  const parsed = parseListing(html2.length > html.length ? html2 : html);
  for (const u of (parsed.fields.images_from_jsonld || [])) urls.add(u);

  // 2) <img> / data-src / srcset on the page, restricted to RG's image CDN.
  const r = await client.Runtime.evaluate({
    expression: `(() => {
      const out = [];
      const push = u => { if (u) out.push(u.split(' ')[0]); };
      for (const img of document.querySelectorAll('img')) {
        push(img.getAttribute('data-src') || img.getAttribute('src'));
        const ss = img.getAttribute('srcset');
        if (ss) ss.split(',').forEach(s => push(s.trim()));
      }
      for (const el of document.querySelectorAll('[style*="background-image"]')) {
        const m = (el.getAttribute('style')||'').match(/url\\((['"]?)(.*?)\\1\\)/);
        if (m) push(m[2]);
      }
      return out;
    })()`,
    returnByValue: true
  });
  for (const u of (r.result.value || [])) urls.add(u);

  // Normalize, filter to RG CDN, rewrite to full res, dedupe by path. Sort so
  // review-original masters (the high-res ones) come first within the cap.
  const byPath = new Map();
  for (let raw of urls) {
    if (!raw) continue;
    if (raw.startsWith('//')) raw = 'https:' + raw;
    if (!/^https?:/.test(raw)) {
      if (/restaurantguru\.com\//.test(raw)) raw = 'https://' + raw; else continue;
    }
    if (!/restaurantguru/i.test(raw)) continue;
    if (/\.(svg|gif)(\?|$)/i.test(raw)) continue;     // icons/spinners
    if (/avatar|icon|logo|sprite|placeholder/i.test(raw)) continue;
    const full = rewriteRestaurantGuru(raw);
    const key = full.split('?')[0];
    if (!byPath.has(key)) byPath.set(key, full);
  }
  const all = [...byPath.values()];
  all.sort((a, b) => (/reviews\/original/.test(b) ? 1 : 0) - (/reviews\/original/.test(a) ? 1 : 0));
  return all.slice(0, max);
}
