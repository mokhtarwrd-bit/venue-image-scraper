// =============================================================================
// lib/cdp.js — Shared CDP (Chrome DevTools Protocol) connection helpers.
//
// Anti-block decision (load-bearing, per Phase 0 spike): we drive a REAL,
// already-running Chrome via the remote-debugging port — never headless, never
// raw HTTP. curl=403, CDP=200 was proven on TripAdvisor. This module only
// CONNECTS to a Chrome that the operator launched on port 9222; it never spawns
// the IG-login profile and never touches the operator's normal Chrome.
//
// Reuses the proven getClient() shape from the v1/v2 IG scrape.js.
// =============================================================================

import CDP from 'chrome-remote-interface';

const DEFAULT_PORT = 9222;

// Connect to a fresh tab in the running debug Chrome. We deliberately open a
// NEW target (tab) per run so we never hijack whatever the operator has open,
// and we get a clean navigation context. Caller is responsible for close().
export async function getClient({ port = DEFAULT_PORT, startUrl = 'about:blank' } = {}) {
  let target;
  try {
    target = await CDP.New({ port, url: startUrl });
  } catch (e) {
    const err = new Error(
      `Cannot connect to Chrome on port ${port}. ` +
      `Launch an ISOLATED debug Chrome first (see lib/launchChrome — NOT the IG profile, ` +
      `NOT your normal Chrome). Underlying: ${e.message}`
    );
    err.code = 'NO_CHROME';
    throw err;
  }
  const client = await CDP({ port, target: target.id });
  await client.Page.enable();
  await client.Runtime.enable();
  await client.DOM.enable();
  await client.Network.enable();
  client.__targetId = target.id;
  client.__port = port;
  return client;
}

// Verify the debug endpoint is reachable and report which browser answered.
// Used by orchestrate.js to fail fast & honestly instead of faking a run.
export async function probePort({ port = DEFAULT_PORT } = {}) {
  try {
    const v = await CDP.Version({ port });
    return { up: true, browser: v.Browser, port };
  } catch (e) {
    return { up: false, error: e.message, port };
  }
}

// Close a client AND dispose its tab so we don't leak tabs across runs.
export async function closeClient(client) {
  if (!client) return;
  const { __port: port, __targetId: id } = client;
  try { await client.close(); } catch { /* already gone */ }
  if (port && id) {
    try { await CDP.Close({ port, id }); } catch { /* tab already closed */ }
  }
}

// Navigate and wait for the load event (with a hard ceiling so a stuck page
// can't hang the run). Returns true on load, false on timeout — caller decides.
export async function navigate(client, url, { timeoutMs = 30000 } = {}) {
  let loaded = false;
  const onLoad = () => { loaded = true; };
  // chrome-remote-interface returns an unsubscribe fn. We MUST call it: a
  // long-running loop (e.g. the discovery deep pass) re-navigates the same tab
  // hundreds of times and every un-removed listener stacks up, eventually
  // emitting MaxListenersExceededWarning and leaking memory. Observed on a
  // 40-place prospecting run, 2026-07-31.
  const off = client.Page.loadEventFired(onLoad);
  try {
    await client.Page.navigate({ url });
    const start = Date.now();
    while (!loaded && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 200));
    }
    return loaded;
  } finally {
    if (typeof off === 'function') off();
  }
}

// Read the current document's full HTML (post-render) via the runtime — used by
// sources to grab JSON-LD and meta tags after the SPA has hydrated.
export async function getOuterHTML(client) {
  const r = await client.Runtime.evaluate({
    expression: 'document.documentElement.outerHTML',
    returnByValue: true
  });
  return r.result.value || '';
}

export { DEFAULT_PORT };
