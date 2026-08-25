// =============================================================================
// lib/launchChrome.js — Launch an ISOLATED debug Chrome on port 9222.
//
// CRITICAL ISOLATION RULE (owner's standing instruction): this tool must NEVER
// use the IG-login profile (%USERPROFILE%\ig-research-chrome) and NEVER use
// the operator's normal Chrome. It launches a dedicated, separate profile dir used
// ONLY by the lead-asset scraper. Sources here are public listing pages that
// don't require login, so a clean profile is correct and safest.
//
// We do not auto-launch inside orchestrate by default — the operator launches
// Chrome (so a human is in the loop and the session is real). This helper is
// provided for convenience / the spike-style isolated launch.
// =============================================================================

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Dedicated profile dir — distinct from ig-research-chrome on purpose.
export const LEAD_SCRAPER_PROFILE = join(homedir(), 'lead-asset-scraper-chrome');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
];

export function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  return null;
}

// Launch detached so it stays up across the run. Returns { ok, pid, profile }.
export function launchDebugChrome({ port = 9222, startUrl = 'about:blank' } = {}) {
  const chrome = findChrome();
  if (!chrome) return { ok: false, error: 'chrome_not_found' };
  if (LEAD_SCRAPER_PROFILE.toLowerCase().includes('ig-research-chrome')) {
    // hard guard against ever pointing at the IG profile
    return { ok: false, error: 'refusing_ig_profile' };
  }
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${LEAD_SCRAPER_PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    startUrl,
  ];
  const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: true, pid: child.pid, profile: LEAD_SCRAPER_PROFILE };
}
