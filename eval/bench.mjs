// Shared helpers of the acceptance bench: paths, the isolated environment, the qm toggle.
// The bench never copies credentials: each agent logs in once inside the bench's own config dir.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.dirname(EVAL_DIR);
export const SKILL_DIR = path.join(REPO, 'skills', 'urequartermaster');
export const QM = path.join(SKILL_DIR, 'scripts', 'qm.mjs');
export const DEFAULT_BENCH = path.join(EVAL_DIR, '.cache', 'bench');

export const readCatalog = () => JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'catalog.json'), 'utf8'));

export function benchPaths(bench) {
  const home = path.join(bench, 'home');
  return {
    bench, home,
    bin: path.join(bench, 'bin'),
    claudeDir: path.join(home, '.claude'),
    codexDir: path.join(home, '.codex'),
    agentsSkills: path.join(home, '.agents', 'skills'),
    claudeSkills: path.join(home, '.claude', 'skills'),
    codexSkills: path.join(home, '.codex', 'skills'),
    uqm: path.join(home, '.urequartermaster'),
  };
}

const ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TERM', 'SystemRoot', 'ComSpec', 'PATHEXT'];

/**
 * Environment for every process that runs inside the bench: an allowlist, not a copy of the caller's env
 * (no GITHUB_TOKEN, AWS_*, ANTHROPIC_API_KEY ...). `pass` names extra variables the user explicitly forwards.
 */
export function benchEnv(bench, { pathOnlyBin = false, pass = [] } = {}) {
  const p = benchPaths(bench);
  const src = process.env;
  const env = {};
  for (const k of Object.keys(src)) if (ENV_ALLOW.includes(k) || /^LC_/.test(k) || pass.includes(k)) env[k] = src[k];
  Object.assign(env, {
    HOME: p.home,
    USERPROFILE: p.home,
    UREQM_HOME: p.uqm,
    UREQM_NO_UPDATE: '1',
    CLAUDE_CONFIG_DIR: p.claudeDir,
    CODEX_HOME: p.codexDir,
    DISABLE_AUTOUPDATER: '1',
    PATH: pathOnlyBin ? p.bin : `${p.bin}${path.delimiter}${src.PATH || ''}`,
  });
  return env;
}

export function qm(bench, args, opts = {}) {
  const r = spawnSync(process.execPath, [QM, ...args], {
    env: benchEnv(bench, opts), encoding: 'utf8', cwd: opts.cwd || p0(bench), timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const p0 = (bench) => { const d = path.join(bench, 'project'); fs.mkdirSync(d, { recursive: true }); return d; };

const copyFilter = (src) => path.basename(src) !== '.git';

/** Install (or remove) UreQuartermaster for Codex: skill copy in ~/.agents/skills + `qm init` block. Claude gets it through --plugin-dir. */
export function setQm(bench, withQm) {
  const p = benchPaths(bench);
  const dest = path.join(p.agentsSkills, 'urequartermaster');
  fs.rmSync(dest, { recursive: true, force: true });
  if (withQm) {
    fs.mkdirSync(p.agentsSkills, { recursive: true });
    fs.cpSync(SKILL_DIR, dest, { recursive: true, filter: copyFilter });
    qm(bench, ['init', '--agent', 'codex'], { pathOnlyBin: true });
  } else {
    qm(bench, ['init', '--remove', '--agent', 'codex'], { pathOnlyBin: true });
  }
  qm(bench, ['index'], { pathOnlyBin: true });
}

/** The `security` invocations that give the bench its own login keychain (macOS only); every one runs with HOME=<bench home>. */
export function benchKeychainCommands(home) {
  const k = path.join(home, 'Library', 'Keychains', 'bench.keychain-db');
  const unlock = ['unlock-keychain', '-p', '', k];
  const select = [['list-keychains', '-d', 'user', '-s', k], ['default-keychain', '-d', 'user', '-s', k]];
  // an existing file may come from a half-built setup: unlock and (re)select, all idempotent
  if (fs.existsSync(k)) return [unlock, ...select];
  return [['create-keychain', '-p', '', k], ['set-keychain-settings', k], unlock, ...select];
}

/**
 * Claude Code keeps its login in the default keychain found through $HOME. With the fake HOME the bench needs its own
 * (empty password, inside eval/.cache). Always runs with the fake HOME: the user's real keychain is never touched.
 */
export function ensureBenchKeychain(bench) {
  if (process.platform !== 'darwin') return;
  const home = benchPaths(bench).home;
  fs.mkdirSync(path.join(home, 'Library', 'Keychains'), { recursive: true });
  for (const args of benchKeychainCommands(home)) {
    const r = spawnSync('security', args, { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`security ${args[0]} failed: ${[r.error && r.error.message, (r.stderr || '').trim()].filter(Boolean).join(' ')}`);
  }
}

