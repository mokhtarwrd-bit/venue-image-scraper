# Venue Image Scraper

A Node.js toolkit that resolves a venue (restaurant, cafe, hotel/riad, tour
operator) on **Google Maps**, **Restaurant Guru**, **TripAdvisor** and
**Instagram**, then downloads its public images at full resolution.

Everything runs through a **real Chrome window over CDP** (Chrome DevTools
Protocol) — no paid APIs, no Apify, no SerpAPI, no subscription. Pacing is
deliberately slow and jittered so a run looks like a human browsing.

---

## What's in the box

| Script | What it does |
|---|---|
| `scripts/orchestrate.js` | **Main entry.** One venue in → profile + manifest + full-res images out. |
| `scripts/discover-maps.js` | Bulk prospecting: a Maps search query in → a ranked CSV of venues out. See [DISCOVERY-README.md](DISCOVERY-README.md). |
| `scripts/harvest-instagram.js` | Carousel-aware Instagram harvest for a single handle (every slide, not just covers). |
| `scripts/scrape.js` | Instagram post/reel research: captions, engagement, hook screenshots, reel audio. |
| `scripts/transcribe.sh` | Whisper transcription of the downloaded reel audio. |
| `scripts/report-html.js` / `report.js` | HTML / Markdown report from a scrape. |
| `scripts/analyze/filterImages.py` | Local quality filter — drops tiny, blurry and duplicate images. |
| `scripts/sources/` | One module per source: `googleMaps`, `restaurantGuru`, `tripAdvisor`, `instagram`, `mapsDiscovery`. |
| `scripts/lib/` | Shared plumbing: CDP client, downloader, pacing/back-off, Chrome launcher, output tree. |

---

## Requirements

- **Node.js 18+** and `npm`
- **Google Chrome** (desktop)
- **Python 3.10+** — only for the image filter and the transcription step
  (`pip install yt-dlp openai-whisper`, plus `ffmpeg` on PATH)

```bash
npm install
```

Built and tested on **Windows**; the Node scripts are cross-platform,
`start-chrome.bat` and `transcribe.sh` are the OS-specific bits.

---

## Quick start

### 1. Launch a debug Chrome

```bash
node -e "import('./scripts/lib/launchChrome.js').then(m=>console.log(m.launchDebugChrome({port:9222})))"
```

This opens Chrome on a **dedicated profile** with `--remote-debugging-port=9222`,
so it never touches your normal browser profile. Leave the window open for the
whole run.

For Instagram work you need a logged-in session instead — double-click
**`start-chrome.bat`** (separate profile) and log into Instagram once; the login
persists across runs.

### 2. Scrape one venue

```bash
node scripts/orchestrate.js --name "Venue Name" --city "City"

# or shorthand
node scripts/orchestrate.js "Venue Name restaurant City"

# or point it straight at listings you already have
node scripts/orchestrate.js --name "Venue Name" --city "City" \
  --maps-url "https://maps.google.com/..." \
  --ta-url   "https://www.tripadvisor.com/..."
```

Output lands in a per-venue tree:

```
leads/<venue-slug>/
├─ profile.json          ← name, phone, address, rating, hours, website
├─ source-manifest.json  ← every image: source url, dimensions, provenance
└─ images/
   ├─ _incoming/         ← raw downloads
   └─ ...                ← filtered, categorised
```

### 3. Find venues you don't have yet

```bash
node scripts/discover-maps.js --city "City" --queries "restaurants" \
     --min-rating 4.0 --min-reviews 30
```

→ `leads/_prospects/<city>-<date>/leads.csv`, sorted best-first, opens in
Sheets/Excel. Full documentation in [DISCOVERY-README.md](DISCOVERY-README.md).

### 4. Instagram images for one handle

```bash
node scripts/harvest-instagram.js --handle some_venue \
     --out "leads/some-venue/images/_incoming_social" --max-posts 30
```

Captures **every carousel slide** at full resolution (the profile grid only ever
shows slide 1), verifies real pixel dimensions with `sharp`, and records
`postCode` + `slideIndex` for each file.

---

## How it works

1. **Intake guard** — sanity-checks the lead before burning any requests.
2. **Resolve** — finds the venue's canonical listing on each source. Search
   endpoints are used carefully: several public search pages silently ignore the
   query and return generic results, so each module uses the endpoint that was
   verified to actually honour it.
3. **Harvest** — reads listing fields and collects image URLs, upgrading each one
   to its full-resolution master (thumbnail paths are only a hint; the original
   is usually one URL rewrite away).
4. **Download** — parallel-limited, retried, dimension-verified with `sharp`.
5. **Filter** — `filterImages.py` drops undersized, low-detail and duplicate
   images.
6. **Manifest** — every kept image keeps its source URL so provenance is never
   lost.

Sources degrade honestly: if one is blocked or has no listing, the run **flags it
incomplete** rather than inventing data, and TripAdvisor acts as the image
fallback when Restaurant Guru has no coverage.

---

## Notes & limits

- Chrome must stay open, and the port must match (`--port`, default `9222`).
- TripAdvisor is a heavy SPA behind a JS challenge — the module waits for real
  hydration (~18s) instead of the load event, so it is slow by design.
- Google Maps is forced to `hl=en`; the field extraction parses English labels.
- Instagram harvesting requires a logged-in profile for anything non-public.

## Legal

Only scrape public data, and only for venues you are authorised to work with.
Respect each site's Terms of Service and `robots.txt`, keep request volume low
(the defaults already do), and remember that scraped photos remain the copyright
of their owners — treat every image as third-party until the venue hands over
its own assets.

## License

MIT — see [LICENSE](LICENSE).
