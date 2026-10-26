// Self-update. Threat model: the network and even the GitHub release can be hostile, so
// nothing is installed unless (1) the bundle bytes carry a valid Ed25519 signature from
// the key in pubkey.mjs, (2) the signed bundle declares exactly the release tag's version,
// (3) that version is newer than the installed one, and (4) every path in the bundle passes
// readBundle(). This module runs one update (runUpdate) and starts the daily background check
// (autoUpdateTick). Never called from the hook: commands start a detached child instead.
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.mjs';
import { dataDir as defaultDataDir } from '../core/paths.mjs';
import { loadConfig, loadState, saveState } from '../core/config.mjs';
import { clean } from '../core/text.mjs';
import { keyFrom, isDue, checkForUpdate, downloadRelease } from './release.mjs';
import { applyUpdate, installedVersionOf } from './install.mjs';
import { installKind, devCheckoutOf, MANAGER_COMMANDS } from './install-kind.mjs';

export const SKILL_DIR = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export const QM_PATH = fileURLToPath(new URL('../../qm.mjs', import.meta.url));
export const NO_KEY_MESSAGE = 'this build has no release key; update with your installer';
const MAX_NOTE = 120;

function firstLine(notes) {
  if (typeof notes !== 'string') return '';
  const line = clean(notes.split(/\r?\n/).find((l) => l.trim()) || '').replace(/\s+/g, ' ').trim();
  return line.length > MAX_NOTE ? `${line.slice(0, MAX_NOTE - 1).trimEnd()}…` : line;
}

/**
 * One update run. mode: 'background' (detached child: stores the outcome in state),
 * 'foreground' (qm update) or 'check' (qm update --check). Returns { status, message }.
 */
export async function runUpdate({ env = process.env, now = new Date(), mode = 'foreground', skillDir = SKILL_DIR, _deps = {} } = {}) {
  const bg = mode === 'background';
  const key = keyFrom(_deps);
  if (!key) return { status: 'nokey', message: bg ? null : NO_KEY_MESSAGE };
  const dir = _deps.dataDir || defaultDataDir(env);
  const config = loadConfig(dir);
  if (env.UREQM_NO_UPDATE === '1' || (bg && config.autoUpdate === false)) {
    return { status: 'disabled', message: bg ? null : 'updates are disabled by UREQM_NO_UPDATE=1' };
  }
  const record = (patch = {}) => {
    try { saveState(dir, { ...loadState(dir), lastUpdateCheck: now.toISOString(), ...patch }); } catch {}
  };
  const installed = _deps.currentVersion || installedVersionOf(skillDir) || VERSION;
  const res = await checkForUpdate({ now, state: loadState(dir), config, env, fetchJson: _deps.fetchJson,
    _deps: { publicKeyPem: key, currentVersion: installed, force: true } });
  if (!res.ok) {
    record();
    // https.get ignores proxy variables: say so when one is set, or the failure looks like a GitHub problem.
    const proxy = Object.keys(env).some((k) => k.toUpperCase() === 'HTTPS_PROXY' && env[k]) ? ' HTTP proxies are not supported.' : '';
    return { status: 'unreachable', message: bg ? null : `Could not check GitHub for updates (offline or rate-limited); try again later.${proxy}` };
  }
  if (!res.latest) { record(); return { status: 'current', message: `UreQuartermaster ${installed} is up to date.` }; }

  const kind = (_deps.installKind || installKind)(skillDir, { home: _deps.home || os.homedir(), env, dataDir: dir });
  if (MANAGER_COMMANDS[kind]) {
    const message = `UreQuartermaster ${res.latest} is available: run ${MANAGER_COMMANDS[kind]}`;
    record(bg ? { lastUpdateMessage: message } : {});
    return { status: 'managed', message };
  }
  const checkout = devCheckoutOf(skillDir);
  if (checkout) {
    const message = `UreQuartermaster ${res.latest} is available, but this copy is a git checkout of the project (${clean(checkout)}): update it with git pull.`;
    record(bg ? { lastUpdateMessage: message } : {});
    return { status: 'checkout', message };
  }
  if (kind !== 'manual') {
    const message = `UreQuartermaster ${res.latest} is available. This copy is inside a project (${clean(skillDir)}): update it with the tool you installed it with, for example npx skills update urequartermaster.`;
    record(bg ? { lastUpdateMessage: message } : {});
    return { status: 'project', message };
  }
  if (mode === 'check') {
    record();
    return { status: 'available', message: `UreQuartermaster ${res.latest} is available (installed: ${installed}). Install it with: qm update` };
  }
  let dl;
  try { dl = await (_deps.download || downloadRelease)(res.release, _deps.http || {}); } catch {
    record();
    return { status: 'unreachable', message: bg ? null : `Could not download UreQuartermaster ${res.latest}; try again later.` };
  }
  try {
    const r = applyUpdate({ skillDir, bundleBuf: dl.bundleBuf, sigBase64: dl.sigBase64, publicKeyPem: key, tagVersion: res.latest,
      _deps: { dataDir: dir, currentVersion: installed, now } });
    const note = firstLine(r.notes);
    const message = `UreQuartermaster updated to ${r.to}${note ? `: ${note}` : ''}`;
    record({ installedVersion: r.to, lastUpdateMessage: bg ? message : null });
    return { status: 'updated', message };
  } catch (e) {
    if (/in progress/.test(e.message)) { record(); return { status: 'busy', message: bg ? null : 'Another update is in progress.' }; }
    const why = /signature/.test(e.message) ? 'its signature did not verify' : clean(e.message);
    const message = `UreQuartermaster ${res.latest} was not installed: ${why}. The installed version is unchanged.`;
    record(bg ? { lastUpdateMessage: message } : {});
    return { status: 'failed', message };
  }
}

/**
 * Runs before search/load/index/list (never before the hook): prints a stored update
 * message once, and when a check is due starts `qm update --background` detached.
 * Never throws and never waits for the network.
 */
export function autoUpdateTick({ env = process.env, now = new Date(), spawn = nodeSpawn, stderr = (s) => process.stderr.write(s), _deps = {} } = {}) {
  try {
    const dir = _deps.dataDir || defaultDataDir(env);
    let state = loadState(dir);
    if (state.lastUpdateMessage) {
      stderr(`${state.lastUpdateMessage}\n`);
      state = { ...state, lastUpdateMessage: null };
      saveState(dir, state);
    }
    if (!keyFrom(_deps) || env.UREQM_NO_UPDATE === '1') return;
    if (loadConfig(dir).autoUpdate === false || !isDue(state, now)) return;
    saveState(dir, { ...state, lastUpdateCheck: now.toISOString() }); // one child per day, even offline
    const child = spawn(process.execPath, [QM_PATH, 'update', '--background'], {
      detached: true, stdio: 'ignore', windowsHide: true, cwd: os.tmpdir(), env,
    });
    child.unref();
  } catch {
    // an update problem must never break the command the user asked for
  }
}
