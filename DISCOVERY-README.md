# Google Maps Lead Discovery (prospecting)

Finds venues you **don't have yet**. Free, runs on your own Chrome over CDP — no Apify, no SerpAPI,
no subscription.

> **This is not `orchestrate.js`.** That script enriches ONE venue you already have and downloads its
> imagery. This tool is the opposite end of the funnel: a search query in, a ranked venue list out.

---

## Quick start

```bash
# 1. Launch the isolated debug Chrome (once per session)
node -e "import('./scripts/lib/launchChrome.js').then(m=>console.log(m.launchDebugChrome({port:9222})))"

# 2. Simple sweep
node scripts/discover-maps.js --city "Marrakech" --queries "restaurants" \
     --min-rating 4.0 --min-reviews 30

# 3. High-volume sweep (categories x geographic tiles)
node scripts/discover-maps.js --city "Marrakech" \
     --queries "moroccan restaurant,seafood restaurant,rooftop restaurant,riad" \
     --center 31.6295,-7.9811 --grid 3 --spread 0.025 \
     --min-rating 4.0 --min-reviews 30 --slow
```

## Output

`leads/_prospects/<city>-<date>/`

| file | what |
|---|---|
| `leads.csv` | the deliverable — sorted **hot leads first**, opens in Sheets/Excel |
| `discovery.json` | full records + run config + counts |
| `run-log.json` | timestamped log of the run |

Columns: `priority, websiteStatus, name, rating, reviewCount, phone, category, address, website,
websiteHost, city, query, cid, mapsUrl`

---

## How it works — two tiers

**Tier 1 — sweep the search feed.** Scrolls `div[role="feed"]` slowly, collecting every result card:
name, rating, review count, and the **CID** (the stable Google place id, pulled from the card href).
Sponsored ads are dropped. CID is the dedupe key, so overlapping queries and tiles cost nothing.

**Tier 2 — visit each place page.** Feeds each CID into the existing, battle-tested `analyzeListing()`
to get **phone, full address, and the website** — then classifies it.

### Why two tiers instead of just reading the cards

Because the cards lie about websites. Measured on a real sweep: card text said **50 of 54**
venues had no website. Spot-checking the first three disproved two instantly — two of them had
a real domain. Only one was genuinely website-less.

**The website verdict only ever comes from the place page.** That is the whole reason Tier 2 exists.

---

## Website status — the field that matters

A yes/no on "has a website" is too blunt for prospecting, so leads are classified three ways:

| status | meaning | verdict |
|---|---|---|
| `none` | no website at all | **prime lead** |
| `social_or_platform` | Facebook / Instagram / Linktree / wixsite / `business.site` / menu apps | **prime lead** — they want to be online and settled for a stopgap |
| `own_domain` | a real domain of their own | deprioritise |

Priority score combines that with proven demand:

- **hot** — no real site, ≥200 reviews, ≥4.3★
- **warm** — no real site, ≥50 reviews, ≥4.0★
- **cool** — no real site, thin traction
- **low** — has its own domain

---

## Getting volume

One query caps out around **100 results** (it stops at Google's real "reached the end of the list"
marker). Two free multipliers, which is exactly what the paid scrapers do internally:

- **Category splitting** — `--queries "moroccan restaurant,seafood restaurant,rooftop restaurant"`
- **Geographic tiling** — `--center 31.6295,-7.9811 --grid 3 --spread 0.025` runs the query across a
  3×3 grid of map coordinates (~2.5 km apart), each returning its own set.

3 queries × a 3×3 grid = 27 sweeps. Dedupe by CID handles the overlap.

---

## Anti-block design

Owner's standing rule: **slow is fine, never get banned.** This is not a token gesture —

- Runs on the **isolated `lead-asset-scraper-chrome` profile**, never your personal Chrome and never
  the IG-login profile. No login is involved anywhere.
- Serial, never parallel. Jittered pauses everywhere (2.5–5s between scrolls, 6–12s between place
  visits, a 45–90s rest every 12 visits). `--slow` roughly doubles all of them.
- **Stops dead on a challenge/captcha/empty body** rather than retrying into a block.
- **Saves after every single record**, so a halted run is never lost — restart with `--resume` and it
  skips everything already visited.

### Counter-intuitive but measured: slower scrolling returns *more* results

A fast probe (1.6s pauses) stalled at 54 results. Production pacing (2.5–5s) reached **104 and hit the
real end-of-list marker.** Patience is a yield feature, not just a safety measure.

---

## Three traps (all cost real yield — don't reintroduce them)

1. **Never read website status off a feed card.** See above. False-negative machine.
2. **Never enlarge the viewport before scrolling the feed.** Setting a 1280×1600 viewport as an
   "optimisation" collapsed yield from 54 to 8: a tall viewport removes the feed's overflow, so
   `scrollTop = scrollHeight` becomes a no-op and lazy-loading never fires. The feed has to genuinely
   be scrollable. The sweeper now prints a `!! WARN feed not scrollable` line if this ever recurs.
3. **Never reuse one tab across many searches, and never trust a low result count.** Both bugs hit at
   once on the first tiled run: tile 1 returned 104 while tiles 3–6 returned **4 each**, and the run
   happily reported them as complete. Two fixes, both needed:
   - a **fresh tab per search** (SPA state was accumulating across navigations), and
   - a **patience rule** — if a sweep stalls under 12 results *without* the end-of-list marker, it is
     treated as "not hydrated yet", not "finished", and retried up to 3× with long waits.

   After the fix all four tiles hit 104 + END MARKER → **200 unique venues instead of 103.** The run
   also now prints `!! LOW YIELD` whenever a tile finishes short without the end marker, so a silent
   under-collect can't pass as a real result again.

---

## Flags

| flag | default | purpose |
|---|---|---|
| `--city <name>` | — | city label, also appended to bare queries |
| `--queries "a,b,c"` | `restaurants` | category terms to split across |
| `--center lat,lng` | — | anchor for geographic tiling |
| `--grid <n>` | `1` | n×n tile grid around center |
| `--spread <deg>` | `0.02` | degrees between tiles (~2 km) |
| `--zoom <n>` | `15` | tile zoom level |
| `--min-rating <n>` | `0` | gate before deep-visiting |
| `--min-reviews <n>` | `0` | gate before deep-visiting |
| `--deep all\|none` | `all` | `none` = Tier 1 only (website status stays UNKNOWN) |
| `--max-deep <n>` | `500` | cap on place visits per run |
| `--slow` | off | roughly doubles every pause |
| `--resume` | off | reuse prior deep results in the same out dir |
| `--skip-tier1` | off | skip the sweep, re-run only the deep pass over an existing `discovery.json` (implies `--resume`) — use it to deepen more of a sweep you already have |
| `--out <dir>` | `leads/_prospects/<city>-<date>` | output dir |
| `--port <n>` | `9222` | CDP port |
