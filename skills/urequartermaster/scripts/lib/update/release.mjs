// What the latest release is and how to fetch it: the GitHub "latest release" document (at most once
// a day, never without a release key, never when updates are off) and its two assets, whose URLs must
// be exactly this project's release download URLs for that tag.
import { isSemver } from './bundle.mjs';
import { PUBLIC_KEY_PEM } from '../pubkey.mjs';
import { VERSION } from '../version.mjs';
import { isObj } from '../core/files.mjs';
import { httpsGet, USER_AGENT, CHECK_TIMEOUT_MS } from './net.mjs';

export const REPO = 'dev-uretech/UreQuartermaster';
export const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET_PREFIX = `https://github.com/${REPO}/releases/download/`;
const DAY_MS = 24 * 3600 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const MAX_API_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
const MAX_SIG_BYTES = 1024;

/** The release key in force: pubkey.mjs, unless a test passes its own (null included). */
export const keyFrom = (deps) => (Object.hasOwn(deps, 'publicKeyPem') ? deps.publicKeyPem : PUBLIC_KEY_PEM);

export function semverCompare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

async function defaultFetchJson(url, headers, deps = {}) {
  void headers; // httpsGet always sends the same User-Agent
  const body = await httpsGet(url, { maxBytes: MAX_API_BYTES, timeoutMs: CHECK_TIMEOUT_MS }, deps);
  return JSON.parse(body.toString('utf8'));
}

/** Validates a GitHub "latest release" document; null unless it is a usable stable release. */
export function parseRelease(json) {
  if (!isObj(json) || json.draft === true || json.prerelease === true) return null;
  const m = typeof json.tag_name === 'string' ? /^v(\d+\.\d+\.\d+)$/.exec(json.tag_name) : null;
  if (!m || !isSemver(m[1])) return null;
  const version = m[1];
  if (!Array.isArray(json.assets)) return null;
  const url = (name) => {
    const a = json.assets.find((x) => isObj(x) && x.name === name);
    return a && typeof a.browser_download_url === 'string' ? a.browser_download_url : null;
  };
  const bundleUrl = url(`urequartermaster-${version}.bundle.gz`);
  const sigUrl = url(`urequartermaster-${version}.bundle.gz.sig`);
  if (!bundleUrl || !sigUrl) return null;
  return { version, bundleUrl, sigUrl };
}

export function isDue(state, now) {
  const t = Date.parse(state && state.lastUpdateCheck);
  if (!Number.isFinite(t) || t > now.getTime()) return true; // never checked, or clock went back
  return now.getTime() - t >= DAY_MS;
}

/**
 * Asks GitHub for the latest release, at most once per 24 h, never when disabled or when
 * this build has no release key. Never throws. `latest` is set only for a newer stable
 * release with both assets; `ok` tells "checked" from "could not check".
 */
export async function checkForUpdate({ now = new Date(), state = {}, config = {}, env = process.env, fetchJson, _deps = {} } = {}) {
  const none = (due, ok = false) => ({ due, latest: null, ok, release: null });
  try {
    if (!keyFrom(_deps)) return none(false);
    if (!_deps.force) {
      if (config.autoUpdate === false || env.UREQM_NO_UPDATE === '1') return none(false);
      if (!isDue(state, now)) return none(false);
    }
    let json;
    try { json = await (fetchJson || defaultFetchJson)(API_URL, { 'User-Agent': USER_AGENT }); } catch { return none(true); }
    const rel = parseRelease(json);
    if (!rel) return none(true);
    const installed = _deps.currentVersion || VERSION;
    if (semverCompare(rel.version, installed) <= 0) return none(true, true);
    return { due: true, latest: rel.version, ok: true, release: rel };
  } catch {
    return none(true);
  }
}

function checkAssetUrl(href, version, name) {
  let u;
  try { u = new URL(href); } catch { throw new Error('Refusing a malformed asset URL'); }
  if (u.href !== href || href !== `${ASSET_PREFIX}v${version}/${name}`) {
    throw new Error('Refusing an asset URL outside this project\'s releases');
  }
}

/** Downloads the two release assets. Rejects on any network or policy problem. */
export async function downloadRelease(release, deps = {}) {
  const name = `urequartermaster-${release.version}.bundle.gz`;
  if (!isSemver(release.version)) throw new Error('Refusing an asset with an invalid version');
  checkAssetUrl(release.bundleUrl, release.version, name);
  checkAssetUrl(release.sigUrl, release.version, `${name}.sig`);
  const bundleBuf = await httpsGet(release.bundleUrl, { maxBytes: MAX_BUNDLE_BYTES, timeoutMs: DOWNLOAD_TIMEOUT_MS }, deps);
  const sig = await httpsGet(release.sigUrl, { maxBytes: MAX_SIG_BYTES, timeoutMs: CHECK_TIMEOUT_MS * 3 }, deps);
  return { bundleBuf, sigBase64: sig.toString('utf8') };
}
