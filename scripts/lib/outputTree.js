// =============================================================================
// lib/outputTree.js — build the per-lead output folder tree per the SPEC's
// expanded structure (replaces the spike's flat 4-bucket).
//
// leads/<slug>/
//   profile.json
//   source-manifest.json
//   brand-dna.json            (Phase 2b — not written by this slice)
//   images/
//     <section_key>/          (per category, from SECTION_KEYS)
//     unsorted/               (survived Stage A, no confident section — 2b)
//     rejected/<reason-code>/ (Stage A + Stage B rejects)
//     _incoming/              (raw downloads before Stage A sorts them)
// =============================================================================

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { SECTION_KEYS } from './util.js';

export function buildLeadTree(leadsRoot, slug, category) {
  const leadDir = join(leadsRoot, slug);
  const imagesDir = join(leadDir, 'images');
  const incomingDir = join(imagesDir, '_incoming');
  const unsortedDir = join(imagesDir, 'unsorted');
  const rejectedDir = join(imagesDir, 'rejected');

  const sections = SECTION_KEYS[category] || SECTION_KEYS.restaurant;

  const dirs = [leadDir, imagesDir, incomingDir, unsortedDir, rejectedDir];
  for (const s of sections) dirs.push(join(imagesDir, s));
  for (const d of dirs) if (!existsSync(d)) mkdirSync(d, { recursive: true });

  return {
    leadDir,
    imagesDir,
    incomingDir,
    unsortedDir,
    rejectedDir,
    sectionDirs: Object.fromEntries(sections.map(s => [s, join(imagesDir, s)])),
    profileFile: join(leadDir, 'profile.json'),
    manifestFile: join(leadDir, 'source-manifest.json'),
    brandDnaFile: join(leadDir, 'brand-dna.json'), // reserved for 2b
  };
}
