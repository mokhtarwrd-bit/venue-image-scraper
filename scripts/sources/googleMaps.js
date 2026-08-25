// =============================================================================
// sources/googleMaps.js — listing ANALYSIS ONLY. No image harvest from Maps.
//
// Per the locked source map: Maps is the BRITTLE source. We extract only what's
// reliably gettable (name, category, rating, review count, hours, geo/CID) via
// real Chrome over CDP, and we FLAG any field we can't get rather than guessing.
// We degrade gracefully and mark the source "incomplete" on a block/empty body.
//
// Note: no paid Places API key is held (spike). This is the DOM/CDP read of the
// public place page — best-effort, honest about gaps. Never fabricates.
// =============================================================================

import { navigate, getOuterHTML } from '../lib/cdp.js';
import { humanPause, assessResponse } from '../lib/pacing.js';

// Resolve a Maps place URL by searching the query. Google Maps is a heavy SPA;
// we navigate to the search URL and let it redirect/settle to a place.
// Force English UI. Maps localises its labels to the request locale, and our
// field extraction strips ENGLISH prefixes only (/^Phone:?/i, /^Address:?/i).
// A French render returns "Numéro de téléphone: ..." / "Adresse: ...", which
// silently degrades those fields — a real lead once shipped with
// phone:null for exactly this reason, and phone is a primary CTA. hl=en makes
// the labels deterministic. (Verified 2026-07-31.)
function withEnglish(url) {
  return url.includes('hl=') ? url : url + (url.includes('?') ? '&' : '?') + 'hl=en';
}

export async function resolveListing(client, { name, city, directUrl }) {
  if (directUrl && /google\.[a-z.]+\/maps/i.test(directUrl)) {
    // CID auto-rewrite: a /place/.../data=...!1s0x<hex>:0x<cid-hex>... share link
    // is a heavy SPA URL that often re-searches. If a CID hex is present, rewrite
    // to the canonical ?cid=<decimal> form, which lands directly on the place.
    const cidm = directUrl.match(/0x[0-9a-f]+:0x([0-9a-f]+)/i);
    if (cidm) {
      const cidDec = BigInt('0x' + cidm[1]).toString(10);
      return { url: withEnglish(`https://www.google.com/maps?cid=${cidDec}`), resolvedVia: 'direct_url_cid_rewrite' };
    }
    return { url: withEnglish(directUrl), resolvedVia: 'direct_url' };
  }
  const q = encodeURIComponent(`${name} ${city || ''}`.trim());
  const searchUrl = withEnglish(`https://www.google.com/maps/search/${q}`);
  return { url: searchUrl, resolvedVia: 'search' };
}

// Extract reliably-gettable fields from a Maps place page. Returns
// { found, fields, missing[], block? }. Each unobtained field is named in
// `missing` so the merge step can show the gap honestly.
export async function analyzeListing(client, url) {
  await navigate(client, url, { timeoutMs: 35000 });
  await humanPause(5000, 9000); // Maps SPA needs time to hydrate the place panel

  const html = await getOuterHTML(client);
  const gate = assessResponse({ bodyLength: html.length, challengeText: html.slice(0, 6000) });
  if (!gate.ok) {
    return { found: false, fields: {}, missing: ['all'], block: gate };
  }

  // Pull what we can directly from the DOM via the live runtime (more reliable
  // than regex over the giant SPA HTML for the visible panel).
  const r = await client.Runtime.evaluate({
    expression: `(() => {
      const out = {};
      // Name: the H1 of the place panel.
      const h1 = document.querySelector('h1');
      out.name = h1 ? h1.textContent.trim() : null;

      // Rating + review count: aria-labels and the rating block carry these.
      // Rating is a number like "4.6"; reviews like "(1,234)".
      const ratingEl = document.querySelector('[role="img"][aria-label*="star" i], span[aria-hidden="true"]');
      const bodyText = document.body ? document.body.innerText : '';
      const rm = bodyText.match(/\\b([0-5](?:[.,]\\d))\\s*\\n?\\s*\\(?([\\d.,]+)\\)?\\s*(?:reviews?|avis)/i);
      if (rm) { out.rating = parseFloat(rm[1].replace(',', '.')); out.reviewCount = parseInt(rm[2].replace(/[.,\\s]/g,''),10); }

      // Category: Maps shows it as a button right under the name.
      const catBtn = document.querySelector('button[jsaction*="category"], button[jsaction*="pane.rating.category"]');
      out.category = catBtn ? catBtn.textContent.trim() : null;
      if (!out.category) {
        // fallback: first short capitalized line after the name
        const m = bodyText.match(/\\n([A-Z][A-Za-z ]{2,40})\\n/);
        out.category = m ? m[1].trim() : null;
      }

      // Address: button with data-item-id="address" carries the formatted addr.
      const addrEl = document.querySelector('button[data-item-id="address"], [data-tooltip="Copy address"]');
      out.address = addrEl ? addrEl.getAttribute('aria-label') ? addrEl.getAttribute('aria-label').replace(/^Address:?\\s*/i,'') : addrEl.textContent.trim() : null;

      // Phone
      const phoneEl = document.querySelector('button[data-item-id^="phone"], [data-tooltip="Copy phone number"]');
      out.phone = phoneEl ? (phoneEl.getAttribute('aria-label')||'').replace(/^Phone:?\\s*/i,'').trim() || phoneEl.textContent.trim() : null;

      // Website (Maps surfaces the place's own site)
      const siteEl = document.querySelector('a[data-item-id="authority"], a[aria-label^="Website"]');
      out.website = siteEl ? siteEl.getAttribute('href') : null;

      return out;
    })()`,
    returnByValue: true
  });

  const dom = r.result.value || {};

  // Geo + CID from the URL once Maps redirects to a place (…/@lat,lng,zoom… and …!1s0x…:0x<cid>…)
  let geo = null, cid = null, placeUrl = url;
  try {
    const cur = await client.Runtime.evaluate({ expression: 'window.location.href', returnByValue: true });
    placeUrl = cur.result.value || url;
    const at = placeUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (at) geo = { lat: Number(at[1]), lng: Number(at[2]) };
    const cidm = placeUrl.match(/0x[0-9a-f]+:0x([0-9a-f]+)/i);
    if (cidm) cid = cidm[1];
  } catch { /* leave null */ }

  const fields = {
    name: dom.name || null,
    category: dom.category || null,
    rating: dom.rating ?? null,
    reviewCount: dom.reviewCount ?? null,
    address: dom.address || null,
    phone: dom.phone || null,
    website: dom.website && !/google\./i.test(dom.website) ? dom.website : null,
    geo,
    cid,
    placeUrl,
  };

  const missing = Object.entries(fields)
    .filter(([k, v]) => v == null || (typeof v === 'object' && k === 'geo' && !v))
    .map(([k]) => k);

  return { found: !!fields.name, fields, missing };
}
