// =============================================================================
// lib/pacing.js — Human-like pacing, jitter, natural scroll, and a back-off
// ladder. Owner's #1 priority is anti-block; this is the behavioural half of
// it (the CDP-real-browser half lives in lib/cdp.js).
//
// Principles (from the spike): serial not parallel; jittered 4–12s gaps; a
// natural multi-step scroll rather than one jump; and a back-off ladder that
// STOPS a source and flags it "incomplete" on 403/429/near-empty body — we
// never hammer, and we never fabricate completeness.
// =============================================================================

export const wait = ms => new Promise(r => setTimeout(r, ms));

// Jittered human gap. Default band 4–12s matches the spike's stated pacing.
export function jitter(minMs = 4000, maxMs = 12000) {
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

export async function humanPause(minMs = 4000, maxMs = 12000) {
  const ms = jitter(minMs, maxMs);
  await wait(ms);
  return ms;
}

// Natural scroll: several smaller scrolls with short jittered pauses, instead
// of one big jump — triggers lazy-loading the way a person would and looks less
// like a bot. Returns the final scrollY reached.
export async function naturalScroll(client, { steps = 6, stepPx = 900, minPause = 700, maxPause = 1600 } = {}) {
  let y = 0;
  for (let i = 0; i < steps; i++) {
    const px = stepPx + Math.floor((Math.random() - 0.5) * 300); // jitter the step size too
    await client.Runtime.evaluate({ expression: `window.scrollBy(0, ${px})` });
    await wait(jitter(minPause, maxPause));
    const r = await client.Runtime.evaluate({ expression: 'window.scrollY', returnByValue: true });
    y = r.result?.value ?? y;
  }
  return y;
}

// -----------------------------------------------------------------------------
// Back-off ladder. A source calls assessResponse() with what it observed; this
// returns a verdict. On a hard block signal (403/429) or a near-empty body, the
// verdict is STOP — the caller must stop the source and mark it incomplete.
// We do not retry into a block; we degrade gracefully and stay honest.
// -----------------------------------------------------------------------------
const NEAR_EMPTY_BYTES = 1500; // bodies smaller than this on an HTML page == blocked/challenge

export function assessResponse({ status = 200, bodyLength = Infinity, challengeText = '' } = {}) {
  if (status === 403 || status === 429) {
    return { ok: false, verdict: 'STOP', reason: `http_${status}`, flag: 'source_incomplete' };
  }
  if (status >= 500) {
    return { ok: false, verdict: 'STOP', reason: `http_${status}`, flag: 'source_incomplete' };
  }
  if (bodyLength < NEAR_EMPTY_BYTES) {
    return { ok: false, verdict: 'STOP', reason: 'near_empty_body', flag: 'source_incomplete' };
  }
  if (/captcha|are you a robot|unusual traffic|verify you are human/i.test(challengeText)) {
    return { ok: false, verdict: 'STOP', reason: 'challenge_page', flag: 'source_incomplete' };
  }
  return { ok: true, verdict: 'CONTINUE', reason: 'ok', flag: null };
}

// A per-domain rate cap helper: ensures at least `minGapMs` between requests to
// the same domain across a run. Caller holds the returned state object.
export function makeRateCap(minGapMs = 4000) {
  const last = new Map();
  return async function gate(domain) {
    const now = Date.now();
    const prev = last.get(domain) || 0;
    const since = now - prev;
    if (since < minGapMs) await wait(minGapMs - since + jitter(0, 1500));
    last.set(domain, Date.now());
  };
}
