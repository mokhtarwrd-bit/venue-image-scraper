// =============================================================================
// lib/util.js — small shared helpers: slugify, python resolver, JSON-LD picker,
// and the spec's per-category section key sets (used to build the output tree).
// =============================================================================

import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export function slugify(s = '') {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'lead';
}

// Windows-friendly python resolver (mirrors scrape.js findPython).
export function findPython() {
  for (const cmd of ['python', 'py', 'python3']) {
    try { execSync(`${cmd} --version`, { stdio: 'pipe' }); return cmd; } catch { /* next */ }
  }
  const base = join(homedir(), 'AppData', 'Local', 'Programs', 'Python');
  if (existsSync(base)) {
    for (const dir of readdirSync(base)) {
      const exe = join(base, dir, 'python.exe');
      if (existsSync(exe)) return `"${exe}"`;
    }
  }
  return 'python';
}

// Extract all JSON-LD blocks from a rendered HTML string. Returns an array of
// parsed objects (flattens @graph). Never throws — bad blocks are skipped.
export function extractJsonLd(html = '') {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let raw = m[1].trim();
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : (parsed['@graph'] ? parsed['@graph'] : [parsed]);
      for (const it of items) out.push(it);
    } catch { /* skip malformed block */ }
  }
  return out;
}

// Find the first JSON-LD object whose @type matches (case-insensitive, allows
// @type to be an array or a string).
export function findJsonLdType(blocks, typeName) {
  const want = String(typeName).toLowerCase();
  for (const b of blocks) {
    const t = b && b['@type'];
    if (!t) continue;
    const types = Array.isArray(t) ? t : [t];
    if (types.some(x => String(x).toLowerCase() === want)) return b;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Per-category section keys — straight from the creative-director spec
// (Part 2.2–2.4). These drive the per-lead images/<section_key>/ tree, plus the
// universal unsorted/ and rejected/ folders. Adopting this REPLACES the spike's
// flat {hero,menu,gallery,rejected}.
// -----------------------------------------------------------------------------
export const SECTION_KEYS = {
  restaurant: ['hero', 'food', 'interior_ambiance', 'exterior', 'gallery', 'about'],
  riad: ['hero', 'rooms', 'courtyard_pool', 'terrace_views', 'interior_detail', 'dining_breakfast', 'gallery', 'about'],
  transport_agency: ['hero', 'vehicles', 'destinations', 'experiences', 'team_guides', 'gallery', 'about'],
};

// Reject reason codes (spec §2.0) — used to name rejected/<code>/ subfolders.
export const REJECT_CODES = [
  'too_dark', 'too_blurry', 'low_res_upscaled', 'heavy_text_overlay', 'cluttered',
  'people_dominant_unusable', 'off_subject', 'duplicate', 'wrong_venue', 'distorted',
  // Stage A local-filter codes (resolution/quality, decidable without vision):
  'below_min_resolution', 'low_res',
];
