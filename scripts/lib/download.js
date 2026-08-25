// =============================================================================
// lib/download.js — Node-side image downloader + per-source resolution-rewrite
// rules.
//
// Reuses the PROVEN v1/v2 approach: download server-side with Node fetch (the
// in-page fetch from a CDN-hosting site is CORS/CORP-blocked), guard against
// tiny error/placeholder bodies (>1KB), never throw. We additionally read
// Content-Type to assign a correct extension and capture fileBytes for the
// manifest.
//
// Resolution rewrites (from the spike, per-source): bump thumbnail CDN URLs up
// to full-res BEFORE downloading, so what lands on disk is website-usable
// (proven 1100–2200px across sources).
// =============================================================================

import { writeFileSync, existsSync } from 'fs';

const MIN_BYTES = 1024; // anything smaller is an error/placeholder body, not an image

// --- per-source URL rewrite rules ------------------------------------------
// Each returns a (possibly) upgraded URL string. Pure string ops; never throws.

// Restaurant Guru image sizing scheme (PROVEN against a real Restaurant Guru venue
// page, 2026-06-25):
//   - REVIEW/USER photos: served under .../reviews/<size>/<id>.jpg where <size>
//     is e.g. `small/w166`, `small`, etc. The display path is a thumbnail HINT;
//     the file behind `.../reviews/original/<id>.jpg` is the full-res master
//     (verified: small/w166 path returned the same 1440x960 bytes as original/).
//     -> rewrite any /reviews/<anything>/<id>.jpg to /reviews/original/<id>.jpg.
//   - CARD crops: img02.restaurantguru.com/c<hash>-Name-N.jpg. These are
//     ~820px card crops with NO larger variant (probed: hash-prefix guesses
//     404). We leave them untouched; Stage A will reject the genuinely-small
//     ones rather than us fabricating a non-existent original.
//   - Legacy /WxH/ and /thumb/ patterns are still handled defensively.
export function rewriteRestaurantGuru(url) {
  if (!url) return url;
  let u = url.startsWith('//') ? 'https:' + url : url;
  // The big win: review images -> original master.
  u = u.replace(/\/reviews\/[^/]+(?:\/[^/]+)?\/(\d+\.(?:jpe?g|png|webp))/i, '/reviews/original/$1');
  // Legacy sized segments -> original (defensive; harmless if absent).
  u = u.replace(/\/(?:\d{2,4}x\d{2,4})\//, '/original/');
  u = u.replace(/\/thumb(?:nail)?\//i, '/original/');
  // Drop downscaling query params some variants append.
  u = u.replace(/([?&])(?:w|width|size|h|height|q|quality)=\d+/gi, '$1');
  u = u.replace(/[?&]+$/, '');
  return u;
}

// TripAdvisor media CDN (PROVEN against a real TripAdvisor review page, 2026-06-26
// via dynamic-media-cdn.tripadvisor.com/media/photo-o/...):
//   - The `/photo-<x>/` path segment is the size TIER; `photo-o` is the
//     original/largest tier. Other tiers (-s/-w/-l/-f) are smaller crops.
//     -> rewrite any /photo-<x>/ to /photo-o/.
//   - The REAL downscaler is the `?w=&h=&s=` query string. The same photo-o URL
//     served WITH `?w=900&h=500` was 55KB / 900x500 (fails Stage A short-edge),
//     and WITHOUT the query was 338KB / 2048x1536 (a full-res master). So we
//     STRIP the sizing query entirely — the CDN then returns the original.
//     (Verified across 3 photos: 2048x1536, 3000x4000, 3024x4032.)
export function rewriteTripAdvisor(url) {
  if (!url) return url;
  let u = url.replace(/\/photo-[a-z]\//i, '/photo-o/');
  // Drop the entire sizing query string — that is what crops/downscales.
  u = u.replace(/\?.*$/, '');
  return u;
}

// Instagram scontent URLs are signed; we do NOT rewrite size (the og:image URL
// already points at the largest variant the page exposed). Identity passthrough
// keeps the existing IG pipeline behaviour intact.
export function rewriteInstagram(url) {
  return url;
}

export const REWRITES = {
  restaurantGuru: rewriteRestaurantGuru,
  tripAdvisor: rewriteTripAdvisor,
  instagram: rewriteInstagram,
};

// Pick an extension from a Content-Type header, falling back to .jpg.
function extFromContentType(ct = '') {
  ct = ct.toLowerCase();
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('avif')) return '.avif';
  return '.jpg';
}

// -----------------------------------------------------------------------------
// Download one image. Returns a result object (never throws):
//   { ok, destFile, bytes, contentType, status, finalUrl, error }
// `destFileNoExt` is the path WITHOUT extension; we append the right one based
// on Content-Type so callers don't have to guess the format.
// -----------------------------------------------------------------------------
export async function downloadImage(url, destFileNoExt, { referer = '' } = {}) {
  if (!url) return { ok: false, error: 'no_url' };
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        ...(referer ? { 'Referer': referer } : {}),
        'Accept': 'image/avif,image/webp,image/png,image/jpeg,*/*'
      }
    });
    if (!resp.ok) return { ok: false, status: resp.status, error: `http_${resp.status}` };
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < MIN_BYTES) {
      return { ok: false, status: resp.status, bytes: buf.length, error: 'too_small' };
    }
    const ct = resp.headers.get('content-type') || '';
    if (ct && !/^image\//i.test(ct)) {
      // Got HTML/JSON instead of an image (block page / error) — do not save.
      return { ok: false, status: resp.status, bytes: buf.length, contentType: ct, error: 'not_image' };
    }
    const ext = extFromContentType(ct);
    const destFile = destFileNoExt + ext;
    if (!existsSync(destFile)) writeFileSync(destFile, buf);
    return { ok: true, destFile, bytes: buf.length, contentType: ct, status: resp.status, finalUrl: url };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export { MIN_BYTES };
