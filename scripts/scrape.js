#!/usr/bin/env node
// =============================================================================
// Instagram Research — Single-pass scraper
// For each post: navigate → engagement + caption → screenshots → audio → next
// One visit per post. No second pass.
// Usage: node scripts/scrape.js <project-name>
// =============================================================================

import CDP from 'chrome-remote-interface';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { homedir } from 'os';

const projectName = process.argv[2];
if (!projectName) {
  console.error('Usage: node scripts/scrape.js <project-name>');
  process.exit(1);
}

const projectDir = join(import.meta.dirname, '..', 'projects', projectName);
const configFile = join(projectDir, 'config.json');
if (!existsSync(configFile)) {
  console.error(`Project not found: ${projectDir}\nCreate a config.json first.`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(configFile, 'utf8'));
const outputFile = join(projectDir, 'raw-posts.json');
const transcriptsDir = join(projectDir, 'transcripts');
const hooksDir = join(projectDir, 'hook-screenshots');
const imagesDir = join(projectDir, 'images'); // [v2] full-res original images for image posts

[transcriptsDir, hooksDir, imagesDir].forEach(d => {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
});

const wait = ms => new Promise(r => setTimeout(r, ms));

// -----------------------------------------------------------------------------
// [v2] Download a remote image to disk using Node's server-side fetch.
// IMPORTANT: in-page fetch() from the instagram.com context is CORS/CORP-blocked
// by the scontent CDN (probe: "Failed to fetch"), so we download Node-side here.
// The og:image URL is short-lived (signed oh=/oe= tokens), so this must run
// while the scrape session is live — which it is. Returns true on a real,
// non-trivial file (>1KB), false otherwise. Never throws.
// -----------------------------------------------------------------------------
async function downloadImage(url, destFile) {
  if (!url) return false;
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.instagram.com/'
      }
    });
    if (!resp.ok) return false;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 1024) return false; // guard against error/placeholder bodies
    writeFileSync(destFile, buf);
    return true;
  } catch {
    return false;
  }
}

// Find a usable Python command (Windows-friendly: python, py, python3,
// then scan the standard per-user install dir as a last resort).
function findPython() {
  const candidates = ['python', 'py', 'python3'];
  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: 'pipe' });
      return cmd;
    } catch { /* try next */ }
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
const PYTHON = findPython();

function getPort() {
  const portNum = config.browserPort || 9222;
  // Try the port file first, fall back to direct connection
  const portFile = join(homedir(), '.browser-tools', 'port');
  if (existsSync(portFile)) {
    return parseInt(readFileSync(portFile, 'utf8'));
  }
  return portNum;
}

async function getClient() {
  const port = getPort();
  let targets;
  try {
    targets = await CDP.List({ port });
  } catch (e) {
    console.error(`\nCannot connect to Chrome on port ${port}.`);
    console.error('Make sure Chrome is running with: --remote-debugging-port=9222');
    console.error('Close Chrome completely, then relaunch it with that flag.\n');
    process.exit(1);
  }
  let target = targets.find(t => t.type === 'page' && t.url.includes('instagram.com'));
  if (!target) {
    target = await CDP.New({ port, url: 'https://www.instagram.com/' });
    await wait(5000);
  }
  const client = await CDP({ port, target: target.id });
  await client.Page.enable();
  await client.Runtime.enable();
  await client.DOM.enable();
  return client;
}

// Collect post links from a hashtag search page
// Grabs Instagram's "Top posts" first (the ~9-post grid at the top),
// then scrolls for additional "Most recent" posts below.
async function collectSearchPosts(client, searchTerm, maxPosts) {
  const searchUrl = `https://www.instagram.com/explore/tags/${searchTerm.replace(/\s+/g, '').replace(/^#/, '')}/`;
  console.log(`  Navigating to: ${searchUrl}`);
  await client.Page.navigate({ url: searchUrl });
  await wait(5000);

  // Phase 1: Grab "Top posts" before scrolling (Instagram shows ~9 top posts)
  const topResult = await client.Runtime.evaluate({
    expression: `
      (() => {
        const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
        const hrefs = [];
        const seen = new Set();
        for (const l of links) {
          const h = l.getAttribute('href');
          if (!seen.has(h)) { seen.add(h); hrefs.push(h); }
        }
        return hrefs;
      })()
    `,
    returnByValue: true
  });
  const topLinks = (topResult.result.value || []).slice(0, 9);
  console.log(`  Top posts: ${topLinks.length}`);

  // Phase 2: Scroll to load "Most recent" posts
  const remainingNeeded = maxPosts - topLinks.length;
  if (remainingNeeded > 0) {
    const scrollRounds = Math.ceil(remainingNeeded / 12);
    for (let i = 0; i < scrollRounds; i++) {
      await client.Runtime.evaluate({ expression: 'window.scrollBy(0, 1500)' });
      await wait(2000);
    }
  }

  // Collect all links, but tag which are top vs recent
  const allResult = await client.Runtime.evaluate({
    expression: `
      (() => {
        const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
        const hrefs = [];
        const seen = new Set();
        for (const l of links) {
          const h = l.getAttribute('href');
          if (!seen.has(h)) { seen.add(h); hrefs.push(h); }
          if (hrefs.length >= ${maxPosts}) break;
        }
        return hrefs;
      })()
    `,
    returnByValue: true
  });
  const allLinks = allResult.result.value || [];

  // Tag top vs recent
  const topSet = new Set(topLinks);
  return allLinks.map(href => ({
    href,
    section: topSet.has(href) ? 'top' : 'recent'
  }));
}

// Collect post links from a profile page
async function collectProfilePosts(client, profileUrl, maxPosts) {
  console.log(`  Navigating to: ${profileUrl}`);
  await client.Page.navigate({ url: profileUrl });
  await wait(8000); // longer initial wait for profile to fully load

  // Multiple scroll rounds to trigger lazy loading of post grid
  for (let round = 0; round < 4; round++) {
    await client.Runtime.evaluate({ expression: 'window.scrollBy(0, 1000)' });
    await wait(2000);
  }
  // Extra wait after scrolling for post links to render
  await wait(3000);

  const collectLinks = async () => {
    const postLinks = await client.Runtime.evaluate({
      expression: `
        (() => {
          // Prefer links scoped to main content area to avoid nav/footer
          let links = document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]');
          if (links.length === 0) {
            // Fallback to page-wide search
            links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
          }
          const hrefs = [];
          const seen = new Set();
          for (const l of links) {
            const h = l.getAttribute('href');
            if (!seen.has(h)) { seen.add(h); hrefs.push(h); }
            if (hrefs.length >= ${maxPosts}) break;
          }
          console.log('[scraper] profile links found: ' + hrefs.length + ' (main-scoped: ' + document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]').length + ', page-wide: ' + document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').length + ')');
          return hrefs;
        })()
      `,
      returnByValue: true
    });
    return postLinks.result.value || [];
  };

  let links = await collectLinks();

  // Retry: if zero links found, scroll more aggressively and try again
  if (links.length === 0) {
    console.log('  No links found on first attempt, retrying with more scrolling...');
    for (let round = 0; round < 4; round++) {
      await client.Runtime.evaluate({ expression: 'window.scrollBy(0, 1500)' });
      await wait(2500);
    }
    await wait(3000);
    links = await collectLinks();
  }

  console.log(`  Profile link collection: ${links.length} links found`);
  return links;
}

// =============================================================================
// SINGLE-PASS: scrape + screenshot + audio for ONE post
// =============================================================================
async function processPost(client, href, source) {
  const postId = href.match(/\/(p|reel)\/([\w-]+)/)?.[2] || '';
  const postUrl = href.startsWith('http') ? href : 'https://www.instagram.com' + href;
  const audioFile = join(transcriptsDir, `${postId}.m4a`);
  const ssFile0 = join(hooksDir, `${postId}_0s.jpg`);

  // Skip if fully processed already
  if (existsSync(audioFile) && existsSync(ssFile0)) {
    return { postId, skipped: true };
  }

  // 1. Navigate to post — pause video ASAP to capture true first frames
  await client.Page.navigate({ url: postUrl });
  // Poll rapidly to pause the video the instant it appears
  for (let attempt = 0; attempt < 30; attempt++) {
    const paused = await client.Runtime.evaluate({
      expression: `(() => { const v = document.querySelector('video'); if(v) { v.pause(); v.muted = true; return true; } return false; })()`,
      returnByValue: true
    });
    if (paused.result.value) break;
    await wait(200);
  }
  await wait(3000);

  // 2. Extract engagement + caption + author
  const data = await client.Runtime.evaluate({
    expression: `
      (() => {
        const result = { url: window.location.href };

        // -------------------------------------------------------------------
        // PRIMARY SOURCE for likes + author: og:description meta tag.
        // Instagram embeds a stable string here, e.g.
        //   "328 likes, 19 comments - ikram.fahmi.data le January 8, 2026: ..."
        // The numeric count is the REAL like count; the handle after " - "
        // (up to " le "/" on "/":") is the post AUTHOR. Far more reliable than
        // stray spans, which on these layouts gave garbage (the '1' bug).
        // -------------------------------------------------------------------
        const ogDescEl = document.querySelector('meta[property="og:description"]');
        const ogDesc = ogDescEl ? (ogDescEl.getAttribute('content') || '') : '';
        if (ogDesc) {
          const likeMatch = ogDesc.match(/^\\s*([\\d.,]+\\s*[KkMm]?)\\s*likes?/i);
          if (likeMatch) result.likes = likeMatch[1].trim();
          const commMatch = ogDesc.match(/likes?,\\s*([\\d.,]+\\s*[KkMm]?)\\s*comments?/i);
          if (commMatch) result.commentsCount = commMatch[1].trim();
          // Author handle sits between " - " and the date separator (" le "
          // FR, " on " EN) or the caption colon — whichever comes first.
          const authorMatch = ogDesc.match(/-\\s*([A-Za-z0-9._]+)\\s+(?:le|on)\\s/i)
                            || ogDesc.match(/-\\s*([A-Za-z0-9._]+)\\s*:/);
          if (authorMatch) result.authorFromOg = authorMatch[1].trim();
          result.ogDesc = ogDesc.substring(0, 300);
        }

        // -------------------------------------------------------------------
        // [v2] PRIMARY SOURCE for the original post image: og:image meta tag.
        // Same proven meta-tag pattern as og:description above. On these
        // logged-in layouts Instagram embeds a full CDN URL here for both
        // single-image posts and carousels (carousel => the "best"/primary
        // image). display_url is NOT reliably present in inline HTML on these
        // layouts (probe returned none), so og:image is the source of truth.
        // The URL is signed (oh=/oe= tokens) and must be fetched during the
        // scrape session — which is exactly when the Node downloader runs.
        // -------------------------------------------------------------------
        const ogImageEl = document.querySelector('meta[property="og:image"]');
        result.ogImage = ogImageEl ? (ogImageEl.getAttribute('content') || '') : '';

        // Engagement — raw numbers from spans
        const allSpans = document.querySelectorAll('span');
        const rawNumbers = [];
        for (const el of allSpans) {
          const t = el.textContent.trim();
          if (t.match(/^[\\d,.\\s ]+[KkMm]?$/) && t.length < 15 && t !== '0') {
            rawNumbers.push(t);
          }
          if (t.match(/^[\\d,.\\s ]+\\s*[KkMm]?\\s*(likes?|J'aime)/i) && !result.likes) result.likes = t;
          if (t.match(/^Liked by|^Aimé par/i) && !result.likesContext) result.likesContext = t.substring(0, 150);
          if (t.match(/^[\\d,.\\s ]+\\s*[KkMm]?\\s*(views?|vues?)/i) && !result.views) result.views = t;
          if (t.match(/(?:View all|Afficher|Voir)\\s+([\\d\\s,.]+)\\s*[KkMm]?\\s*comment/i) && !result.comments) result.comments = t;
        }

        const uniqueNums = [...new Set(rawNumbers)];
        result.rawNumbers = uniqueNums.slice(0, 10);
        // REMOVED: "result.likes = uniqueNums[0]" — it assigned the first stray
        // number on the page (always '1'), fabricating a false like count on
        // every post. If og:description and the labelled span both fail, likes
        // is left empty rather than invented. Do not re-add this fallback.
        if (uniqueNums.length >= 2 && !result.commentsCount && !result.comments) result.commentsCount = uniqueNums[1];

        // Caption — blacklist known French/English UI strings that appear in h1/spans
        const uiBlacklist = /Autres applications|More apps|Meta\s*(©|Business|Platforms)|À propos|About|Inscription|Sign up/i;
        function isUIText(text) { return uiBlacklist.test(text); }

        // Prefer h1 inside the post content area (article/section/main), skip footer/header UI
        let captionH1 = document.querySelector('article h1, section h1, main h1');
        if (!captionH1 || isUIText(captionH1.textContent)) {
          // Fall back to any h1 that isn't UI text
          const allH1s = document.querySelectorAll('h1');
          captionH1 = null;
          for (const h of allH1s) {
            if (!isUIText(h.textContent) && h.textContent.trim().length > 0) {
              captionH1 = h;
              break;
            }
          }
        }
        result.caption = captionH1 ? captionH1.textContent.substring(0, 500) : '';
        if (!result.caption) {
          const spans = document.querySelectorAll('span[dir="auto"]');
          for (const s of spans) {
            if (s.textContent.length > 20 && s.textContent.length < 5000 && !isUIText(s.textContent)) {
              result.caption = s.textContent.substring(0, 500);
              break;
            }
          }
        }
        result.fullCaption = captionH1 ? captionH1.textContent : '';
        if (!result.fullCaption) {
          const spans = document.querySelectorAll('span[dir="auto"]');
          for (const s of spans) {
            if (s.textContent.length > 20 && !isUIText(s.textContent)) { result.fullCaption = s.textContent; break; }
          }
        }

        // Type, date, author
        result.type = document.querySelector('video') ? 'reel' : 'image';
        const timeEl = document.querySelector('time[datetime]');
        result.date = timeEl ? timeEl.getAttribute('datetime') : '';
        result.dateText = timeEl ? timeEl.textContent : '';
        // Author: prefer the handle parsed from og:description (reliable);
        // fall back to the brittle class-based selector only if that failed.
        const authorEl = document.querySelector('a[class*="x1i10hfl"][role="link"] span');
        result.author = result.authorFromOg
          || (authorEl ? authorEl.textContent.trim() : '');

        return result;
      })()
    `,
    returnByValue: true
  });

  const post = data.result.value;
  post.href = href;
  post.source = source;
  post.postId = postId;

  // 3. Screenshots (only for reels)
  if (post.type === 'reel' && !existsSync(ssFile0)) {
    try {
      // Video is already paused from page load — just seek and screenshot
      for (const sec of [0, 1, 2]) {
        const ssFile = join(hooksDir, `${postId}_${sec}s.jpg`);
        await client.Runtime.evaluate({
          expression: `(() => { const v = document.querySelector('video'); if(v) { v.currentTime = ${sec}; } })()`,
        });
        await wait(800);
        const ss = await client.Page.captureScreenshot({ format: 'jpeg', quality: 70 });
        writeFileSync(ssFile, Buffer.from(ss.data, 'base64'));
      }
      post.hasScreenshots = true;
    } catch (e) {
      post.hasScreenshots = false;
    }
  }

  // 4. Audio download (only for reels)
  if (post.type === 'reel' && !existsSync(audioFile)) {
    try {
      execSync(
        `${PYTHON} -m yt_dlp --format worstaudio --no-warnings --quiet -o "${audioFile}" "${postUrl}"`,
        { timeout: 45000, stdio: 'pipe' }
      );
      post.hasAudio = existsSync(audioFile);
    } catch (e) {
      post.hasAudio = false;
    }
  }

  // 5. [v2] Image download (only for image posts — reels are untouched above).
  //    Source of truth = og:image (captured in the extraction step). For
  //    carousels we additionally try to walk slides by clicking the "Next"
  //    arrow and reading each slide's largest <img> src. If enumeration is
  //    not possible we keep the primary og:image and flag the limitation —
  //    we never fake completeness.
  if (post.type === 'image') {
    post.imageFiles = [];
    post.isCarousel = false;
    post.carouselComplete = null; // true=all slides captured, false=primary only

    // 5a. Primary image from og:image (proven reliable on these layouts)
    const primaryFile = join(imagesDir, `${postId}.jpg`);
    let primaryOk = existsSync(primaryFile);
    if (!primaryOk && post.ogImage) {
      primaryOk = await downloadImage(post.ogImage, primaryFile);
    }
    if (primaryOk) post.imageFiles.push(`${postId}.jpg`);

    // 5b. Carousel detection + best-effort slide enumeration.
    //     A carousel exposes a "Next" arrow button; single images do not.
    try {
      const isCarousel = await client.Runtime.evaluate({
        expression: `(() => !!document.querySelector('button[aria-label="Next"], button[aria-label="Suivant"], [aria-label="Next"][role="button"], [aria-label="Suivant"][role="button"]'))()`,
        returnByValue: true
      });
      if (isCarousel.result.value) {
        post.isCarousel = true;
        const seenUrls = new Set();
        if (post.ogImage) seenUrls.add(post.ogImage.split('?')[0]); // dedupe by path
        let slideIndex = 1; // primary already saved as <postId>.jpg

        for (let step = 0; step < 12; step++) { // cap at 12 slides (IG max is 10)
          // Read the largest currently-visible content image (skip tiny avatars)
          const slideUrl = await client.Runtime.evaluate({
            expression: `(() => {
              const imgs = [...document.querySelectorAll('article img, main img, ul img')]
                .filter(i => i.src && !i.src.startsWith('data:'))
                .map(i => ({ src: i.src, area: (i.naturalWidth||i.width||0) * (i.naturalHeight||i.height||0), w: i.naturalWidth||i.width||0 }))
                .filter(o => o.w >= 320) // drop avatars/thumbnails
                .sort((a, b) => b.area - a.area);
              return imgs.length ? imgs[0].src : null;
            })()`,
            returnByValue: true
          });
          const url = slideUrl.result.value;
          const key = url ? url.split('?')[0] : null;
          if (url && key && !seenUrls.has(key)) {
            seenUrls.add(key);
            slideIndex++;
            const slideFile = join(imagesDir, `${postId}_${slideIndex}.jpg`);
            if (existsSync(slideFile) || await downloadImage(url, slideFile)) {
              post.imageFiles.push(`${postId}_${slideIndex}.jpg`);
            }
          }

          // Click Next; stop if the arrow is gone (reached last slide)
          const advanced = await client.Runtime.evaluate({
            expression: `(() => {
              const btn = document.querySelector('button[aria-label="Next"], button[aria-label="Suivant"], [aria-label="Next"][role="button"], [aria-label="Suivant"][role="button"]');
              if (btn) { btn.click(); return true; } return false;
            })()`,
            returnByValue: true
          });
          if (!advanced.result.value) break;
          await wait(900); // let next slide's <img> swap in
        }
        // Carousel is "complete" if we captured more than just the primary,
        // OR there was genuinely only one extra. We can't know IG's declared
        // count without GraphQL, so this is best-effort and flagged as such.
        post.carouselComplete = post.imageFiles.length > 1 ? true : false;
      }
    } catch (e) {
      post.carouselError = String(e.message || e);
    }

    post.hasImages = post.imageFiles.length > 0;
  }

  return post;
}

// Parse engagement string to number for sorting
// Handles both English (1,234 / 8.6K) and French (1 234 / 8,6 K) formats
function parseFrenchEnglishNumber(str) {
  if (!str) return 0;
  const match = str.match(/([\d]+(?:[.,\s ]\d+)*)\s*([KkMm])?/);
  if (!match) return 0;
  let numStr = match[1].replace(/[\s ]/g, ''); // strip spaces and non-breaking spaces
  // French decimal: single comma followed by 1-2 digits at end (e.g. "8,6")
  if (/^\d+,\d{1,2}$/.test(numStr)) {
    numStr = numStr.replace(',', '.');
  } else {
    // English thousands: commas followed by 3 digits (e.g. "1,234")
    numStr = numStr.replace(/,/g, '');
  }
  let num = parseFloat(numStr);
  if (isNaN(num)) return 0;
  if (match[2]?.match(/[Kk]/)) num *= 1000;
  if (match[2]?.match(/[Mm]/)) num *= 1000000;
  return num;
}

function parseEngagement(post) {
  const likeStr = post.likes || post.likesFromBtn || '';
  return parseFrenchEnglishNumber(likeStr);
}

// =============================================================================
// Main
// =============================================================================
(async () => {
  try {
    const client = await getClient();
    const allPosts = [];

    // Search terms
    for (const term of config.searchTerms) {
      console.log(`\n========================================`);
      console.log(`  Searching: "${term}"`);
      console.log(`========================================`);

      const links = await collectSearchPosts(client, term, config.maxPostsPerSearch || 50);
      const topCount = links.filter(l => l.section === 'top').length;
      const recentCount = links.filter(l => l.section === 'recent').length;
      console.log(`  Found ${links.length} posts (${topCount} top, ${recentCount} recent)\n`);

      for (let i = 0; i < links.length; i++) {
        const { href, section } = links[i];
        const postId = href.match(/\/(p|reel)\/([\w-]+)/)?.[2] || '';
        const tag = section === 'top' ? '[TOP]' : '[RECENT]';
        process.stdout.write(`  [${i + 1}/${links.length}] ${tag} ${postId} — `);

        const post = await processPost(client, href, `${section}:${term}`);
        if (post.skipped) {
          console.log('skipped (done)');
        } else {
          const eng = post.likes || 'no data';
          const ss = post.hasScreenshots ? 'ss' : '';
          const audio = post.hasAudio ? 'audio' : '';
          const imgs = post.hasImages ? `img:${post.imageFiles.length}${post.isCarousel ? '(carousel)' : ''}` : '';
          console.log(`[${post.type}] ${eng} ${[ss, audio, imgs].filter(Boolean).join(' ')}`);
          allPosts.push(post);
        }
      }
    }

    // Competitor profiles
    for (const profileUrl of (config.competitors || [])) {
      const handle = profileUrl.match(/instagram\.com\/([^/]+)/)?.[1] || profileUrl;
      console.log(`\n========================================`);
      console.log(`  Competitor: @${handle}`);
      console.log(`========================================`);

      const links = await collectProfilePosts(client, profileUrl, config.maxCompetitorPosts || 10);
      console.log(`  Found ${links.length} posts\n`);

      for (let i = 0; i < links.length; i++) {
        const postId = links[i].match(/\/(p|reel)\/([\w-]+)/)?.[2] || '';
        process.stdout.write(`  [${i + 1}/${links.length}] ${postId} — `);

        const post = await processPost(client, links[i], `competitor:@${handle}`);
        if (post.skipped) {
          console.log('skipped (done)');
        } else {
          const eng = post.likes || 'no data';
          const imgs = post.hasImages ? `img:${post.imageFiles.length}${post.isCarousel ? '(carousel)' : ''}` : '';
          console.log(`[${post.type}] ${eng} ${imgs}`.trimEnd());
          allPosts.push(post);
        }
      }
    }

    // Deduplicate
    const seen = new Set();
    const unique = allPosts.filter(p => {
      const key = p.href || p.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    unique.sort((a, b) => parseEngagement(b) - parseEngagement(a));

    const output = {
      project: config.name,
      niche: config.niche,
      scrapedAt: new Date().toISOString(),
      searchTerms: config.searchTerms,
      competitors: config.competitors,
      totalPosts: unique.length,
      reels: unique.filter(p => p.type === 'reel').length,
      images: unique.filter(p => p.type === 'image').length,
      // [v2] how many image posts actually had at least one file saved to images/
      imagePostsWithFiles: unique.filter(p => p.hasImages).length,
      imageFilesSaved: unique.reduce((n, p) => n + ((p.imageFiles && p.imageFiles.length) || 0), 0),
      posts: unique
    };

    writeFileSync(outputFile, JSON.stringify(output, null, 2));

    console.log(`\n========================================`);
    console.log(`  Complete!`);
    console.log(`  Total: ${unique.length} unique posts`);
    console.log(`  Reels: ${output.reels} | Images: ${output.images}`);
    console.log(`  Image files saved: ${output.imageFilesSaved} (across ${output.imagePostsWithFiles} image posts)`);
    console.log(`  Screenshots: ${hooksDir}`);
    console.log(`  Images: ${imagesDir}`);
    console.log(`  Audio: ${transcriptsDir}`);
    console.log(`  Data: ${outputFile}`);
    console.log(`========================================`);

    await client.close();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
