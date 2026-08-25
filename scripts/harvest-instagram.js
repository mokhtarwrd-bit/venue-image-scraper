#!/usr/bin/env node
// =============================================================================
// harvest-instagram.js — reusable, carousel-aware IG harvest for one lead.
//
//   node scripts/harvest-instagram.js --handle example_venue \
//        --out "output/example-venue/images/_incoming_social" \
//        [--max-posts 30] [--scrolls 6] [--port 9222] [--dry]
//
// Captures EVERY carousel
// slide (not just the cover), verifies real pixel size with sharp, and records
// postCode + slideIndex so every asset stays swappable before launch.
// =============================================================================

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { getClient, closeClient } from './lib/cdp.js';
import { harvestProfile } from './sources/instagram.js';

const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : (i >= 0 ? true : d);
};

const handle = arg('handle');
const out = arg('out');
const maxPosts = Number(arg('max-posts', 30));
const scrolls = Number(arg('scrolls', 6));
const port = Number(arg('port', 9222));
const dry = !!arg('dry', false);

if (!handle || (!out && !dry)) {
  console.error('usage: --handle <ig_handle> --out <dir> [--max-posts N] [--scrolls N] [--port 9222] [--dry]');
  process.exit(1);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36';

const client = await getClient({ port, startUrl: 'about:blank' });
let result;
try {
  result = await harvestProfile(client, handle, {
    maxPosts,
    scrolls,
    onProgress: ({ href, type, slides, total }) =>
      console.log(`  ${type.padEnd(9)} ${String(slides).padStart(2)} slide(s)  ${href}  [unique so far: ${total}]`),
  });
} finally {
  await closeClient(client);
}

if (result.loginWall) {
  console.error('LOGIN WALL hit — Instagram is not serving this profile publicly to that Chrome profile.');
  process.exit(2);
}

const s = result.stats;
console.log(`\nposts=${s.posts} carousels=${s.carousels} singles=${s.singles} videos=${s.videos}`);
console.log(`slides recovered from carousels = ${s.slidesFromCarousels}  (old grid harvest would have taken ${s.carousels})`);
if (s.rejectedForeign) console.log(`rejected ${s.rejectedForeign} permalink(s) belonging to OTHER accounts`);
console.log(`unique images available: ${result.media.length}`);

if (dry) {
  for (const m of result.media.slice(0, 12)) console.log(`   ${m.postType} p.${m.postCode} slide${m.slideIndex} ${m.width}x${m.height}`);
  process.exit(0);
}

fs.mkdirSync(out, { recursive: true });
let n = 0;
const manifest = [];
for (const m of result.media) {
  try {
    const res = await fetch(m.url, { headers: { 'User-Agent': UA, Referer: 'https://www.instagram.com/' } });
    if (!res.ok) { console.log(`  skip http ${res.status} ${m.photoId}`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 6000) { console.log(`  skip tiny ${buf.length}B ${m.photoId}`); continue; }
    let meta = {};
    try { meta = await sharp(buf).metadata(); } catch { /* keep going; record unknown */ }
    const file = `instagram_${String(++n).padStart(3, '0')}.jpg`;
    fs.writeFileSync(path.join(out, file), buf);
    manifest.push({
      file,
      source: 'instagram',
      handle,
      postCode: m.postCode,
      postType: m.postType,
      slideIndex: m.slideIndex,
      width: meta.width || m.width || null,
      height: meta.height || m.height || null,
      bytes: buf.length,
      url: m.url,
      rights: 'third_party_placeholder_swap_before_launch',
    });
  } catch (e) {
    console.log(`  dlerr ${m.photoId}: ${e.message}`);
  }
}
fs.writeFileSync(path.join(out, '_ig_manifest.json'), JSON.stringify(manifest, null, 2));

const big = manifest.filter((x) => (x.width || 0) >= 1080).length;
const fromSlides = manifest.filter((x) => x.slideIndex > 1).length;
console.log(`\nDOWNLOADED ${n} -> ${out}`);
console.log(`  >=1080px wide: ${big}/${n}`);
console.log(`  images that ONLY exist because of carousel-slide capture: ${fromSlides}`);
process.exit(0);
