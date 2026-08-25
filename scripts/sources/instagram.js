// =============================================================================
// sources/instagram.js — CAROUSEL-AWARE public Instagram harvest.
//
// WHY THIS EXISTS
// The old grid harvest scrolled the profile grid and read
// <img> tags. The grid only ever renders each post's COVER (slide 1), so every
// slide 2..N of a carousel was silently lost. Probed 2026-07-31 on
// a test account: one post is a 3-slide carousel, but only slides 1-2
// were ever in the DOM — slide 3 existed ONLY in the embedded JSON.
//
// HOW IT WORKS
// Instagram ships the full media graph in <script type="application/json">
// blobs. We deep-walk those to the media node whose `code` matches the post we
// are on, then read `carousel_media[].image_versions2.candidates` — every slide,
// full resolution, WITHOUT clicking arrows (ArrowRight was tested and does not
// advance a logged-out carousel).
//
// RIGHTS: every image is third-party until the client hands over their own.
// Each entry records postCode + slideIndex + source url so it stays swappable.
// =============================================================================

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function ev(client, expression) {
  const { result } = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  return result.value;
}

// IG filenames look like <photoId>_<mediaId>_<ownerId>_n.jpg — photoId dedupes
// the same picture served at different sizes/CDN hosts.
export function photoId(u) {
  const m = u.match(/\/([0-9]{6,})_[0-9]+_[0-9]+_n\.(?:jpg|webp|heic)/) || u.match(/\/([0-9]{6,})_[0-9]+_n\./);
  return m ? m[1] : u.split('?')[0].split('/').pop();
}

// ---------------------------------------------------------------------------
// Collect post permalinks from a profile grid.
// SCOPED TO THE HANDLE ON PURPOSE: the grid also links out to tagged/suggested
// accounts (a profile scrape can surface /another_account/p/... ). Mixing
// another venue's photos into this venue's set is exactly the pollution failure
// we already hit with TripAdvisor — so foreign permalinks are dropped here.
// ---------------------------------------------------------------------------
export async function collectPermalinks(client, handle, { scrolls = 6, includeReels = false } = {}) {
  await client.Page.navigate({ url: `https://www.instagram.com/${handle}/` });
  await wait(7000);

  const loginWall = await ev(client, `!!document.querySelector('input[name="username"]')`);
  if (loginWall) return { loginWall: true, permalinks: [] };

  for (let i = 0; i < scrolls; i++) {
    await ev(client, 'window.scrollBy(0,1600)');
    await wait(1400);
  }

  const sel = includeReels ? 'a[href*="/p/"],a[href*="/reel/"]' : 'a[href*="/p/"]';
  const raw = JSON.parse(await ev(client, `JSON.stringify([...new Set([...document.querySelectorAll('${sel}')].map(a=>a.getAttribute('href')))])`));

  const h = handle.toLowerCase();
  const mine = raw.filter((href) => {
    const seg = href.split('/').filter(Boolean)[0] || '';
    return seg.toLowerCase() === h;
  });
  return { loginWall: false, permalinks: mine, rejectedForeign: raw.length - mine.length };
}

// ---------------------------------------------------------------------------
// Extract EVERY slide of one post from the embedded JSON.
// Returns { code, type, slides:[{url,slideIndex,width,height}] }.
// ---------------------------------------------------------------------------
export async function extractPostMedia(client, permalink) {
  const url = permalink.startsWith('http') ? permalink : `https://www.instagram.com${permalink}`;
  await client.Page.navigate({ url });
  await wait(6500);

  const out = await ev(client, `(() => {
    const path = location.pathname;
    const code = (path.split('/p/')[1] || path.split('/reel/')[1] || '').replace(/\\//g,'');
    let hit = null;

    const bestOf = (node) => {
      const c = node && node.image_versions2 && node.image_versions2.candidates;
      if (!c || !c.length) return null;
      // IG orders candidates largest-first; still sort defensively when sizes exist.
      const s = c.slice().sort((a,b)=>((b.width||0)*(b.height||0))-((a.width||0)*(a.height||0)));
      const p = s[0] || c[0];
      return p && p.url ? { url: p.url, width: p.width || null, height: p.height || null } : null;
    };

    function walk(n, d){
      if (!n || typeof n !== 'object' || d > 45 || hit) return;
      if (Array.isArray(n)) { for (const v of n) walk(v, d+1); return; }
      if ((n.code === code || n.shortcode === code)) {
        if (Array.isArray(n.carousel_media) && n.carousel_media.length) {
          const slides = n.carousel_media.map(bestOf).filter(Boolean);
          if (slides.length) { hit = { code, type:'carousel', slides }; return; }
        }
        const one = bestOf(n);
        if (one) { hit = { code, type: n.video_versions ? 'video' : 'image', slides:[one] }; return; }
      }
      for (const k in n) walk(n[k], d+1);
    }

    for (const s of document.querySelectorAll('script[type="application/json"]')){
      const t = s.textContent || '';
      if (!t.includes('image_versions2')) continue;
      try { walk(JSON.parse(t), 0); } catch(e) {}
      if (hit) break;
    }

    // Fallback: if the JSON graph shape ever changes, take the biggest rendered
    // image so we degrade to old behaviour instead of returning nothing.
    if (!hit) {
      const imgs = [...document.querySelectorAll('img')]
        .map(i=>({url:i.currentSrc||i.src||'', width:i.naturalWidth, height:i.naturalHeight}))
        .filter(o=>/t51\\./.test(o.url) && o.width > 400)
        .sort((a,b)=>(b.width*b.height)-(a.width*a.height));
      if (imgs[0]) hit = { code, type:'dom_fallback', slides:[imgs[0]] };
    }
    return JSON.stringify(hit);
  })()`);

  const parsed = out ? JSON.parse(out) : null;
  if (!parsed) return { code: null, type: 'none', slides: [] };
  parsed.slides = parsed.slides.map((s, i) => ({ ...s, slideIndex: i + 1 }));
  return parsed;
}

// ---------------------------------------------------------------------------
// Full profile harvest: permalinks -> every slide of every post, deduped.
// ---------------------------------------------------------------------------
export async function harvestProfile(client, handle, { maxPosts = 30, scrolls = 6, onProgress = () => {} } = {}) {
  const { loginWall, permalinks, rejectedForeign } = await collectPermalinks(client, handle, { scrolls });
  if (loginWall) return { loginWall: true, handle, media: [], stats: {} };

  const media = new Map(); // photoId -> entry
  const stats = { posts: 0, carousels: 0, singles: 0, videos: 0, slidesFromCarousels: 0, rejectedForeign };

  for (const href of permalinks.slice(0, maxPosts)) {
    let post;
    try { post = await extractPostMedia(client, href); } catch { continue; }
    if (!post.slides.length) continue;
    stats.posts++;
    if (post.type === 'carousel') { stats.carousels++; stats.slidesFromCarousels += post.slides.length; }
    else if (post.type === 'video') stats.videos++;
    else stats.singles++;

    for (const s of post.slides) {
      const id = photoId(s.url);
      const area = (s.width || 0) * (s.height || 0);
      const prev = media.get(id);
      if (!prev || area > (prev.width || 0) * (prev.height || 0)) {
        media.set(id, { ...s, postCode: post.code, postType: post.type, photoId: id });
      }
    }
    onProgress({ href, type: post.type, slides: post.slides.length, total: media.size });
  }

  return { loginWall: false, handle, media: [...media.values()], stats };
}
