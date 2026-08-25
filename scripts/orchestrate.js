#!/usr/bin/env node
// =============================================================================
// orchestrate.js — Phase 2a vertical slice driver.
//
// Accepts ONE lead (natural-language instruction OR a single CSV row), resolves
// it on Restaurant Guru + Google Maps, harvests RG images at full res, runs the
// in-scope intake guard, writes the per-lead output tree (profile.json,
// source-manifest.json, images/ per the spec's section structure), and invokes
// Stage A local image filter.
//
// Anti-block: real Chrome via CDP only; serial; human pacing between sources;
// back-off ladder stops a source and flags it incomplete rather than faking.
//
// Usage:
//   node scripts/orchestrate.js --name "Venue Name" --city "City" [--category restaurant]
//        [--rg-url <url>] [--maps-url <url>] [--ta-url <url>] [--port 9222] [--no-stagea]
//   node scripts/orchestrate.js "Venue Name restaurant City"           (NL form)
//   node scripts/orchestrate.js --csv-row "Venue Name,City,restaurant"  (CSV row)
// =============================================================================

import { execSync } from 'child_process';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { getClient, closeClient, probePort, DEFAULT_PORT } from './lib/cdp.js';
import { humanPause } from './lib/pacing.js';
import { downloadImage } from './lib/download.js';
import { slugify, findPython } from './lib/util.js';
import { classifyLead } from './lib/intake.js';
import { buildLeadTree } from './lib/outputTree.js';
import * as RG from './sources/restaurantGuru.js';
import * as Maps from './sources/googleMaps.js';
import * as TA from './sources/tripAdvisor.js';
import { navigate, getOuterHTML } from './lib/cdp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEADS_ROOT = join(__dirname, '..', 'leads');

// ---- tiny arg parser --------------------------------------------------------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const val = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      a[key] = val;
    } else a._.push(t);
  }
  return a;
}

function resolveLeadInput(args) {
  // CSV row: "name,city,category"
  if (args['csv-row']) {
    const [name, city, category] = String(args['csv-row']).split(',').map(s => s.trim());
    return { name, city, category };
  }
  // explicit flags
  if (args.name) {
    return { name: args.name, city: args.city || '', category: args.category || null,
             rgUrl: args['rg-url'] || null, mapsUrl: args['maps-url'] || null,
             taUrl: args['ta-url'] || null };
  }
  // natural-language: "Venue Name restaurant City" — last token group = city guess
  if (args._.length) {
    const nl = args._.join(' ');
    // naive split: assume final word is city if it's a known-ish place, else whole string is name
    const cities = ['marrakech', 'marrakesh', 'casablanca', 'rabat', 'fes', 'fez', 'essaouira', 'agadir', 'tangier', 'chefchaouen'];
    const words = nl.split(/\s+/);
    let city = '';
    if (cities.includes(words[words.length - 1].toLowerCase())) city = words.pop();
    return { name: words.join(' '), city, category: null, _nl: nl };
  }
  return null;
}

const log = (...m) => console.log(...m);

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port || DEFAULT_PORT);
  const lead = resolveLeadInput(args);

  if (!lead || !lead.name) {
    console.error('Provide a lead. e.g.\n  node scripts/orchestrate.js --name "Venue Name" --city "City"\n  node scripts/orchestrate.js "Venue Name restaurant City"');
    process.exit(2);
  }

  // ---- 1. probe Chrome (fail honestly if down) -----------------------------
  const probe = await probePort({ port });
  if (!probe.up) {
    console.error(`\n[BLOCKED] Chrome debug port ${port} is not up: ${probe.error}`);
    console.error('Launch an ISOLATED debug Chrome (NOT the IG profile, NOT your normal Chrome):');
    console.error(`  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=${port} --user-data-dir="%USERPROFILE%\\lead-asset-scraper-chrome" about:blank`);
    console.error('Then re-run. (We do not fake a run.)\n');
    process.exit(3);
  }
  log(`[chrome] connected: ${probe.browser}`);

  // ---- 2. intake guard (in-scope check) ------------------------------------
  const cls = classifyLead({ name: lead.name, city: lead.city, listingCategory: lead.category || '' });
  const category = lead.category || cls.category || 'restaurant';
  log(`[intake] inScope=${cls.inScope} category=${category} confidence=${cls.confidence} — ${cls.why}`);
  if (!cls.inScope) {
    log('[intake] FLAG: lead does not clearly read as restaurant/riad/transport in Morocco. Proceeding is your call; flagging and continuing in soft mode.');
  }

  const slug = slugify(`${lead.name}-${lead.city || ''}`);
  const tree = buildLeadTree(LEADS_ROOT, slug, category);
  log(`[lead] slug=${slug} -> ${tree.leadDir}`);

  const profile = {
    lead_slug: slug,
    input: { name: lead.name, city: lead.city || null, category_requested: lead.category || null, nl: lead._nl || null },
    intake: cls,
    category,
    generated_at: new Date().toISOString(),
    sources: {},
    fields: {},            // merged value -> { value, source }
    flags: [],
  };
  const manifest = { lead_slug: slug, generated_at: new Date().toISOString(), images: [] };

  // helper: record a merged field with its winning source (first non-null wins,
  // RG is anchor so it's tried first)
  function setField(key, value, source) {
    if (value == null) return;
    if (profile.fields[key] && profile.fields[key].value != null) return; // keep anchor
    profile.fields[key] = { value, source };
  }

  // ---- 3. Restaurant Guru (anchor): listing + images -----------------------
  let client;
  try {
    client = await getClient({ port });
    log('\n[restaurantGuru] resolving listing...');
    const resolved = await RG.resolveListing(client, { name: lead.name, city: lead.city, directUrl: lead.rgUrl });
    profile.sources.restaurantGuru = { resolvedUrl: resolved.url, resolvedVia: resolved.resolvedVia };

    if (!resolved.url) {
      profile.sources.restaurantGuru.status = 'not_found';
      profile.flags.push('restaurantGuru: listing not resolved');
      log('[restaurantGuru] FLAG: listing not resolved');
    } else {
      log(`[restaurantGuru] listing: ${resolved.url}`);
      await humanPause(3000, 6000);
      await navigate(client, resolved.url);
      await humanPause(3000, 6000);
      const html = await getOuterHTML(client);
      const parsed = RG.parseListing(html);
      profile.sources.restaurantGuru.jsonLdFound = parsed.found;
      profile.sources.restaurantGuru.jsonLdTypesSeen = parsed.jsonLdTypesSeen;

      if (parsed.found) {
        const f = parsed.fields;
        setField('name', f.name, 'restaurantGuru');
        setField('description', f.description, 'restaurantGuru');
        setField('cuisine', f.cuisine, 'restaurantGuru');
        setField('priceRange', f.priceRange, 'restaurantGuru');
        setField('telephone', f.telephone, 'restaurantGuru');
        setField('website', f.website, 'restaurantGuru'); // the lead's OWN site
        setField('address', f.address, 'restaurantGuru');
        setField('geo', f.geo, 'restaurantGuru');
        setField('rating', f.rating, 'restaurantGuru');
        setField('reviewCount', f.reviewCount, 'restaurantGuru');
        setField('hours', f.hours, 'restaurantGuru');
        log(`[restaurantGuru] parsed: name=${f.name} rating=${f.rating} reviews=${f.reviewCount} website=${f.website || 'none'}`);
      } else {
        profile.flags.push('restaurantGuru: Restaurant JSON-LD not found');
        log('[restaurantGuru] FLAG: Restaurant JSON-LD not found; types seen: ' + JSON.stringify(parsed.jsonLdTypesSeen));
      }

      // images
      log('[restaurantGuru] collecting image URLs...');
      const urls = await RG.collectImageUrls(client, html, { max: 40 });
      log(`[restaurantGuru] ${urls.length} candidate image URLs`);
      let saved = 0;
      for (let i = 0; i < urls.length; i++) {
        const destNoExt = join(tree.incomingDir, `rg_${String(i + 1).padStart(3, '0')}`);
        const res = await downloadImage(urls[i], destNoExt, { referer: 'https://restaurantguru.com/' });
        if (res.ok) {
          saved++;
          manifest.images.push({
            source: 'restaurantGuru',
            sourceUrl: resolved.url,
            originalCdnUrl: urls[i],
            file: res.destFile.split(/[/\\]/).pop(),
            resPx: null,           // filled by Stage A (it reads true dimensions)
            fileBytes: res.bytes,
            contentType: res.contentType || null,
          });
        }
        await humanPause(800, 2200); // gentle pacing between image fetches
      }
      profile.sources.restaurantGuru.imagesSaved = saved;
      log(`[restaurantGuru] saved ${saved} images to _incoming/`);
    }
  } catch (e) {
    profile.flags.push(`restaurantGuru: error ${e.message}`);
    log('[restaurantGuru] ERROR: ' + e.message);
  } finally {
    await closeClient(client);
  }

  // pacing between sources
  await humanPause(5000, 10000);

  // ---- 4. Google Maps (analysis only, no images) ---------------------------
  let mclient;
  try {
    mclient = await getClient({ port });
    log('\n[googleMaps] analysing listing (no images)...');
    const mres = await Maps.resolveListing(mclient, { name: lead.name, city: lead.city, directUrl: lead.mapsUrl });
    const analysis = await Maps.analyzeListing(mclient, mres.url);
    profile.sources.googleMaps = {
      resolvedVia: mres.resolvedVia,
      placeUrl: analysis.fields?.placeUrl || mres.url,
      found: analysis.found,
      missing: analysis.missing || [],
    };
    if (analysis.block) {
      profile.sources.googleMaps.status = 'incomplete';
      profile.sources.googleMaps.block = analysis.block;
      profile.flags.push(`googleMaps: ${analysis.block.reason} -> incomplete`);
      log('[googleMaps] FLAG incomplete: ' + analysis.block.reason);
    } else if (analysis.found) {
      const f = analysis.fields;
      // Maps fills gaps RG left, recorded with its own source.
      setField('name', f.name, 'googleMaps');
      setField('category', f.category, 'googleMaps');
      setField('rating', f.rating, 'googleMaps');
      setField('reviewCount', f.reviewCount, 'googleMaps');
      setField('address', f.address, 'googleMaps');
      setField('telephone', f.phone, 'googleMaps');
      setField('website', f.website, 'googleMaps');
      setField('geo', f.geo, 'googleMaps');
      if (f.cid) setField('googleCid', f.cid, 'googleMaps');
      if (analysis.missing?.length) {
        profile.flags.push(`googleMaps: could not get [${analysis.missing.join(', ')}]`);
        log('[googleMaps] could not get: ' + analysis.missing.join(', '));
      }
      log(`[googleMaps] name=${f.name} category=${f.category} rating=${f.rating} cid=${f.cid || 'none'}`);
    } else {
      profile.sources.googleMaps.status = 'incomplete';
      profile.flags.push('googleMaps: place not resolved');
      log('[googleMaps] FLAG: place not resolved (degraded gracefully, not faked)');
    }
  } catch (e) {
    profile.flags.push(`googleMaps: error ${e.message}`);
    log('[googleMaps] ERROR: ' + e.message);
  } finally {
    await closeClient(mclient);
  }

  // pacing between sources
  await humanPause(5000, 10000);

  // ---- 4b. TripAdvisor (IMAGE source; runs only when --ta-url supplied) -----
  // This is the coverage-gap fallback: when RG has no listing for a venue, the
  // anchor returns 0 images. TA carries the venue's photos. Image-only here;
  // listing fields stay RG/Maps-owned. Honest block-flagging, no fakery.
  const taUrl = lead.taUrl || args['ta-url'] || null;
  if (taUrl) {
    let tclient;
    try {
      tclient = await getClient({ port });
      log('\n[tripAdvisor] resolving listing...');
      const tres = TA.resolveListing({ directUrl: taUrl });
      profile.sources.tripAdvisor = { resolvedUrl: tres.url, resolvedVia: tres.resolvedVia };

      if (!tres.url) {
        profile.sources.tripAdvisor.status = 'not_found';
        profile.flags.push('tripAdvisor: a direct Restaurant_Review URL is required (--ta-url)');
        log('[tripAdvisor] FLAG: requires a direct review URL');
      } else {
        log(`[tripAdvisor] venue: ${tres.url}`);
        await humanPause(3000, 6000);
        const harvest = await TA.harvest(tclient, tres.url);
        profile.sources.tripAdvisor.h1 = harvest.h1 || null;

        if (!harvest.ok) {
          profile.sources.tripAdvisor.status = 'incomplete';
          profile.sources.tripAdvisor.block = harvest.block;
          profile.flags.push(`tripAdvisor: ${harvest.block?.reason || 'blocked'} -> incomplete`);
          log('[tripAdvisor] FLAG incomplete: ' + (harvest.block?.reason || 'blocked'));
        } else {
          log(`[tripAdvisor] venue rendered: "${harvest.h1}" — ${harvest.urls.length} candidate image URLs`);
          let saved = 0;
          for (let i = 0; i < harvest.urls.length; i++) {
            const destNoExt = join(tree.incomingDir, `ta_${String(i + 1).padStart(3, '0')}`);
            const res = await downloadImage(harvest.urls[i], destNoExt, { referer: 'https://www.tripadvisor.fr/' });
            if (res.ok) {
              saved++;
              manifest.images.push({
                source: 'tripadvisor',
                sourceUrl: tres.url,
                originalCdnUrl: harvest.urls[i],
                rights: 'swappable',   // third-party rights; client photos replace before publish
                file: res.destFile.split(/[/\\]/).pop(),
                resPx: null,           // filled by Stage A (true dimensions)
                fileBytes: res.bytes,
                contentType: res.contentType || null,
              });
            }
            await humanPause(800, 2200); // gentle pacing between image fetches
          }
          profile.sources.tripAdvisor.imagesSaved = saved;
          log(`[tripAdvisor] saved ${saved} images to _incoming/`);
        }
      }
    } catch (e) {
      profile.flags.push(`tripAdvisor: error ${e.message}`);
      log('[tripAdvisor] ERROR: ' + e.message);
    } finally {
      await closeClient(tclient);
    }
  }

  // ---- 5. write profile + manifest -----------------------------------------
  writeFileSync(tree.profileFile, JSON.stringify(profile, null, 2));
  writeFileSync(tree.manifestFile, JSON.stringify(manifest, null, 2));
  log(`\n[write] ${tree.profileFile}`);
  log(`[write] ${tree.manifestFile}`);

  // ---- 6. Stage A local image filter ---------------------------------------
  if (args['no-stagea'] !== true && manifest.images.length) {
    const py = findPython();
    const script = join(__dirname, 'analyze', 'filterImages.py');
    log('\n[stageA] running local filter...');
    try {
      const out = execSync(`${py} "${script}" "${tree.imagesDir}"`, { stdio: 'pipe' }).toString();
      log(out);
    } catch (e) {
      log('[stageA] FLAG: filter failed: ' + (e.stdout?.toString() || e.message));
      profile.flags.push('stageA: filter failed');
    }
    // backfill resPx into manifest from the Stage A report
    const reportFile = join(tree.imagesDir, 'stage-a-report.json');
    if (existsSync(reportFile)) {
      try {
        const rep = JSON.parse(readFileSync(reportFile, 'utf8'));
        const byFile = Object.fromEntries((rep.results || []).map(r => [r.file, r]));
        for (const img of manifest.images) {
          const r = byFile[img.file];
          if (r && r.width) img.resPx = `${r.width}x${r.height}`;
        }
        writeFileSync(tree.manifestFile, JSON.stringify(manifest, null, 2));
      } catch { /* leave resPx null */ }
    }
  }

  log('\n========================================');
  log('  Slice complete (Phase 2a).');
  log(`  Lead dir: ${tree.leadDir}`);
  log(`  Flags: ${profile.flags.length ? profile.flags.join(' | ') : 'none'}`);
  log('========================================');
})();
