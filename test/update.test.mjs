import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { makeBundle } from '../skills/urequartermaster/scripts/lib/update/bundle.mjs';
import { runUpdate, autoUpdateTick } from '../skills/urequartermaster/scripts/lib/update/update.mjs';
import { applyUpdate, rollback } from '../skills/urequartermaster/scripts/lib/update/install.mjs';
import { acquireLock } from '../skills/urequartermaster/scripts/lib/update/lock.mjs';
import { installKind, devCheckoutOf, MANAGER_COMMANDS } from '../skills/urequartermaster/scripts/lib/update/install-kind.mjs';
import { checkForUpdate, downloadRelease, semverCompare, API_URL } from '../skills/urequartermaster/scripts/lib/update/release.mjs';
import { httpsGet } from '../skills/urequartermaster/scripts/lib/update/net.mjs';
import { PUBLIC_KEY_PEM } from '../skills/urequartermaster/scripts/lib/pubkey.mjs';
import { loadState, saveState, saveConfig } from '../skills/urequartermaster/scripts/lib/core/config.mjs';
import { dispatch } from '../skills/urequartermaster/scripts/lib/cli.mjs';
import { VERSION } from '../skills/urequartermaster/scripts/lib/version.mjs';
import { fakeSkill, hashTree, write } from './helpers/skill-fixture.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PEM = publicKey.export({ type: 'spki', format: 'pem' });
const OTHER = crypto.generateKeyPairSync('ed25519');
const sign = (buf, key = privateKey) => crypto.sign(null, buf, key).toString('base64');

function setup(installed = '1.0.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-upd-'));
  const skillDir = fakeSkill(path.join(root, 'skills', 'urequartermaster'), installed);
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  return { root, skillDir, data, hash: hashTree(skillDir) };
}
const release = (root, version, notes) => {
  const buf = makeBundle(fakeSkill(path.join(root, `src-${version}-${Math.random()}`), version), notes ? { notes } : {});
  return { buf, sig: sign(buf) };
};
const backups = (data) => { try { return fs.readdirSync(path.join(data, 'backup')).sort(); } catch { return []; } };
const leftovers = (s) => fs.readdirSync(path.dirname(s.skillDir)).filter((n) => n !== 'urequartermaster');

test('the shipped build carries the Ed25519 release key', () => {
  const key = crypto.createPublicKey(PUBLIC_KEY_PEM);
  assert.equal(key.asymmetricKeyType, 'ed25519');
  // fingerprint of the maintainer's key (SHA-256 of the SPKI DER); a change here means a new release key
  assert.equal(crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex'),
    'd92c1abee955b293bffa6032fa566984095b8ac386b052826b836f09bccf7e82');
});

test('semverCompare', () => {
  assert.equal(semverCompare('1.2.0', '1.10.0'), -1);
  assert.equal(semverCompare('2.0.0', '1.99.99'), 1);
  assert.equal(semverCompare('1.0.0', '1.0.0'), 0);
});

test('applyUpdate with a valid signature swaps the folder and keeps a backup', () => {
  const s = setup();
  const r = release(s.root, '1.1.0');
  const res = applyUpdate({ skillDir: s.skillDir, bundleBuf: r.buf, sigBase64: r.sig, publicKeyPem: PEM, tagVersion: '1.1.0', _deps: { dataDir: s.data } });
  assert.deepEqual({ from: res.from, to: res.to }, { from: '1.0.0', to: '1.1.0' });
  assert.match(fs.readFileSync(path.join(s.skillDir, 'scripts', 'lib', 'version.mjs'), 'utf8'), /1\.1\.0/);
  const b = backups(s.data);
  assert.equal(b.length, 1);
  assert.match(b[0], /^1\.0\.0-/);
  assert.equal(hashTree(path.join(s.data, 'backup', b[0])), s.hash);
  assert.deepEqual(leftovers(s), []);
  assert.equal(fs.existsSync(path.join(s.data, 'update.lock')), false);
});

test('applyUpdate refuses bad signatures, wrong keys and replays without touching anything', () => {
  const s = setup();
  const r = release(s.root, '1.1.0');
  const flipped = Buffer.from(r.buf); flipped[20] ^= 1;
  const old = release(s.root, '0.9.0');
  const same = release(s.root, '1.0.0');
  const attempts = [
    { bundleBuf: r.buf, sigBase64: sign(r.buf, OTHER.privateKey), tagVersion: '1.1.0', re: /signature/ },
    { bundleBuf: flipped, sigBase64: r.sig, tagVersion: '1.1.0', re: /signature/ },
    { bundleBuf: r.buf, sigBase64: '', tagVersion: '1.1.0', re: /signature/ },
    { bundleBuf: r.buf, sigBase64: r.sig, tagVersion: '1.2.0', re: /tag/ },
    { bundleBuf: r.buf, sigBase64: r.sig, tagVersion: undefined, re: /tag/ },
    { bundleBuf: old.buf, sigBase64: old.sig, tagVersion: '0.9.0', re: /not newer/ },
    { bundleBuf: same.buf, sigBase64: same.sig, tagVersion: '1.0.0', re: /not newer/ },
  ];
  for (const a of attempts) {
    const { re, ...args } = a;
    assert.throws(() => applyUpdate({ skillDir: s.skillDir, publicKeyPem: PEM, ...args, _deps: { dataDir: s.data } }), re);
    assert.equal(hashTree(s.skillDir), s.hash);
    assert.deepEqual(backups(s.data), []);
    assert.deepEqual(leftovers(s), []);
  }
  assert.throws(() => applyUpdate({ skillDir: s.skillDir, bundleBuf: r.buf, sigBase64: r.sig, publicKeyPem: null, tagVersion: '1.1.0', _deps: { dataDir: s.data } }), /key/);
  assert.equal(hashTree(s.skillDir), s.hash);
});

test('a failure in the middle of applyUpdate leaves the installed copy intact', () => {
  for (const failAt of [1, 2]) {
    const s = setup();
    const r = release(s.root, '1.1.0');
    let n = 0;
    const rename = (a, b) => { if (++n === failAt) throw Object.assign(new Error('simulated'), { code: 'EBUSY' }); fs.renameSync(a, b); };
    assert.throws(() => applyUpdate({ skillDir: s.skillDir, bundleBuf: r.buf, sigBase64: r.sig, publicKeyPem: PEM, tagVersion: '1.1.0', _deps: { dataDir: s.data, rename } }), /simulated/);
    assert.equal(hashTree(s.skillDir), s.hash, `failAt ${failAt}`);
    assert.deepEqual(leftovers(s), []);
    assert.deepEqual(backups(s.data), []);
    assert.equal(fs.existsSync(path.join(s.data, 'update.lock')), false);
  }
});

test('a failure while writing the new copy leaves the installed copy intact', () => {
  const s = setup();
  const r = release(s.root, '1.1.0');
  let n = 0;
  const writeFile = (f, d, o) => { if (++n === 3) throw new Error('disk full'); fs.writeFileSync(f, d, o); };
  assert.throws(() => applyUpdate({ skillDir: s.skillDir, bundleBuf: r.buf, sigBase64: r.sig, publicKeyPem: PEM, tagVersion: '1.1.0', _deps: { dataDir: s.data, writeFile } }), /disk full/);
  assert.equal(hashTree(s.skillDir), s.hash);
  assert.deepEqual(leftovers(s), []);
});

test('applyUpdate falls back to copy+delete across devices (EXDEV)', () => {
  const s = setup();
  const r = release(s.root, '1.1.0');
  const rename = (a, b) => {
    if (b.includes(`${path.sep}backup${path.sep}`)) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    fs.renameSync(a, b);
  };
  const res = applyUpdate({ skillDir: s.skillDir, bundleBuf: r.buf, sigBase64: r.sig, publicKeyPem: PEM, tagVersion: '1.1.0', _deps: { dataDir: s.data, rename } });
  assert.equal(res.to, '1.1.0');
  assert.equal(hashTree(path.join(s.data, 'backup', backups(s.data)[0])), s.hash);
  assert.deepEqual(leftovers(s), []);
});

test('the lock prevents a concurrent update; a stale lock is taken over', () => {
  const s = setup();
  const r = release(s.root, '1.1.0');
  const lock = path.join(s.data, 'update.lock');
  fs.writeFileSync(lock, 'other');
  const args = { skillDir: s.skillDir, bundleBuf: r.buf, sigBase64: r.sig, publicKeyPem: PEM, tagVersion: '1.1.0', _deps: { dataDir: s.data } };
  assert.throws(() => applyUpdate(args), /in progress/);
  assert.equal(hashTree(s.skillDir), s.hash);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'other');
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  assert.equal(applyUpdate(args).to, '1.1.0');
  assert.equal(fs.existsSync(lock), false);
});

test('two concurrent takeovers of one stale lock: exactly one acquires', () => {
  const s = setup();
  const lock = path.join(s.data, 'update.lock');
  for (const when of [Date.now() - 11 * 60 * 1000, Date.now() + 3600 * 1000]) { // stale, and dated in the future
    fs.writeFileSync(lock, 'dead');
    fs.utimesSync(lock, new Date(when), new Date(when));
    let a = null;
    // B reads the stale lock's stat, then A runs its whole takeover before B continues.
    const stat = (f) => { const st = fs.statSync(f); if (!a) a = acquireLock(s.data); return st; };
    assert.throws(() => acquireLock(s.data, { stat }), /in progress/);
    assert.equal(typeof a, 'function', 'A acquired');
    assert.notEqual(fs.readFileSync(lock, 'utf8'), 'dead', 'A holds the lock');
    assert.deepEqual(fs.readdirSync(s.data).filter((n) => n.startsWith('update.lock')), ['update.lock']);
    a();
    assert.equal(fs.existsSync(lock), false);
  }
});

test('with a clock gone backwards, prune keeps the new backup and rollback picks it', () => {
  const s = setup();
  // older backups carry later stamps (written when the clock was ahead) but older mtimes
  for (let i = 0; i < 4; i++) {
    const b = fakeSkill(path.join(s.data, 'backup', `0.0.${i}-2030-01-0${i + 1}T00-00-00-000Z`), `0.0.${i}`);
    const t = new Date(Date.now() - (10 - i) * 60000);
    fs.utimesSync(b, t, t);
  }
  const r = release(s.root, '1.1.0');
  const past = new Date('2020-01-01T00:00:00Z');
  const res = applyUpdate({ skillDir: s.skillDir, bundleBuf: r.buf, sigBase64: r.sig, publicKeyPem: PEM, tagVersion: '1.1.0', _deps: { dataDir: s.data, now: past } });
  assert.ok(fs.existsSync(res.backup), 'the backup just made survives pruning');
  assert.equal(backups(s.data).length, 3);
  assert.equal(rollback(s.skillDir, { _deps: { dataDir: s.data, now: past } }).to, '1.0.0');
  assert.equal(hashTree(s.skillDir), s.hash);
  assert.equal(backups(s.data).length, 3);
  assert.ok(backups(s.data).some((n) => n.startsWith('1.1.0-')), 'the copy replaced by rollback survives');
});

test('rollback restores the previous version and keeps at most 3 backups', () => {
  const s = setup();
  for (let i = 0; i < 4; i++) fakeSkill(path.join(s.data, 'backup', `0.0.${i}-2020-01-0${i + 1}T00-00-00-000Z`), `0.0.${i}`);
  const r = release(s.root, '1.1.0');
  applyUpdate({ skillDir: s.skillDir, bundleBuf: r.buf, sigBase64: r.sig, publicKeyPem: PEM, tagVersion: '1.1.0', _deps: { dataDir: s.data } });
  assert.ok(backups(s.data).length <= 3);
  const back = rollback(s.skillDir, { _deps: { dataDir: s.data } });
  assert.equal(back.to, '1.0.0');
  assert.equal(hashTree(s.skillDir), s.hash);
  assert.ok(backups(s.data).length <= 3);
  assert.ok(backups(s.data).some((n) => n.startsWith('1.1.0-')), 'the replaced version is kept as a backup');
  assert.deepEqual(leftovers(s), []);
});

test('rollback with no backup fails cleanly', () => {
  const s = setup();
  assert.throws(() => rollback(s.skillDir, { _deps: { dataDir: s.data } }), /no backup/i);
  assert.equal(hashTree(s.skillDir), s.hash);
});

// --- checkForUpdate ---------------------------------------------------------------

const NOW = new Date('2026-10-25T12:00:00Z');
const relJson = (tag, extra = {}) => ({
  tag_name: tag, draft: false, prerelease: false, body: 'Notes',
  assets: [
    { name: `urequartermaster-${tag.slice(1)}.bundle.gz`, browser_download_url: `https://github.com/dev-uretech/UreQuartermaster/releases/download/${tag}/urequartermaster-${tag.slice(1)}.bundle.gz` },
    { name: `urequartermaster-${tag.slice(1)}.bundle.gz.sig`, browser_download_url: `https://github.com/dev-uretech/UreQuartermaster/releases/download/${tag}/urequartermaster-${tag.slice(1)}.bundle.gz.sig` },
  ],
  ...extra,
});
function spyFetch(result) {
  const calls = [];
  const fn = async (url, headers) => { calls.push({ url, headers }); if (result instanceof Error) throw result; return result; };
  fn.calls = calls;
  return fn;
}
const cfg = (o = {}) => ({ autoUpdate: true, ...o });
const st = (o = {}) => ({ lastUpdateCheck: null, ...o });

test('checkForUpdate never calls the network when not due or disabled', async () => {
  const cases = [
    { state: st({ lastUpdateCheck: new Date(NOW - 23 * 3600e3).toISOString() }), config: cfg(), env: {}, key: PEM },
    { state: st(), config: cfg({ autoUpdate: false }), env: {}, key: PEM },
    { state: st(), config: cfg(), env: { UREQM_NO_UPDATE: '1' }, key: PEM },
    { state: st(), config: cfg(), env: {}, key: null },
  ];
  for (const c of cases) {
    const f = spyFetch(relJson('v9.0.0'));
    const r = await checkForUpdate({ now: NOW, state: c.state, config: c.config, env: c.env, fetchJson: f, _deps: { publicKeyPem: c.key } });
    assert.equal(f.calls.length, 0);
    assert.equal(r.latest, null);
    assert.equal(r.due, false);
  }
});

test('checkForUpdate hits only the fixed URL with the User-Agent and reports a newer release', async () => {
  for (const last of [null, 'garbage', new Date(NOW - 25 * 3600e3).toISOString()]) {
    const f = spyFetch(relJson('v9.0.0'));
    const r = await checkForUpdate({ now: NOW, state: st({ lastUpdateCheck: last }), config: cfg(), env: {}, fetchJson: f, _deps: { publicKeyPem: PEM } });
    assert.equal(r.due, true);
    assert.equal(r.latest, '9.0.0');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://api.github.com/repos/dev-uretech/UreQuartermaster/releases/latest');
    assert.equal(API_URL, f.calls[0].url);
    assert.equal(f.calls[0].headers['User-Agent'], `UreQuartermaster/${VERSION}`);
    assert.match(r.release.bundleUrl, /urequartermaster-9\.0\.0\.bundle\.gz$/);
  }
});

test('checkForUpdate: failures, old, pre-release and odd releases give latest null without throwing', async () => {
  const bad = [
    Object.assign(new Error('HTTP 403'), { status: 403 }),
    new Error('ENOTFOUND'),
    null, 'text', [], { tag_name: 5 },
    relJson(`v${VERSION}`), relJson('v0.0.1'),
    relJson('v9.0.0-beta.1'), relJson('v9.0.0', { prerelease: true }), relJson('v9.0.0', { draft: true }),
    relJson('9.0.0'), relJson('v9.0.0', { assets: [] }), relJson('v9.0.0', { assets: 'x' }),
  ];
  for (const b of bad) {
    const r = await checkForUpdate({ now: NOW, state: st(), config: cfg(), env: {}, fetchJson: spyFetch(b), _deps: { publicKeyPem: PEM } });
    assert.equal(r.latest, null, JSON.stringify(b));
  }
});

// --- HTTP layer ------------------------------------------------------------------

function fakeGet(routes) {
  const seen = [];
  const get = (url, opts, cb) => {
    seen.push({ url: String(url), opts });
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (e) => { if (e) setImmediate(() => req.emit('error', e)); };
    setImmediate(() => {
      const r = routes[String(url)];
      if (!r) return req.emit('error', new Error('ECONNREFUSED'));
      const res = Readable.from(r.body ? [Buffer.from(r.body)] : []);
      res.statusCode = r.status;
      res.headers = r.headers || {};
      res.resume = res.resume.bind(res);
      cb(res);
    });
    return req;
  };
  get.seen = seen;
  return get;
}

test('httpsGet follows allowlisted https redirects only, at most 3, with a size cap', async () => {
  const A = 'https://github.com/dev-uretech/UreQuartermaster/releases/download/v9.0.0/a';
  const ok = fakeGet({
    [A]: { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/x' } },
    'https://release-assets.githubusercontent.com/x': { status: 200, body: 'DATA' },
  });
  assert.equal((await httpsGet(A, { maxBytes: 100 }, { get: ok })).toString(), 'DATA');
  assert.equal(ok.seen[0].opts.headers['User-Agent'], `UreQuartermaster/${VERSION}`);

  for (const loc of ['https://evil.example/x', 'http://github.com/x', 'https://github.com.evil.example/x', 'file:///etc/passwd', 'https://user@github.com/x']) {
    const g = fakeGet({ [A]: { status: 302, headers: { location: loc } }, [loc]: { status: 200, body: 'EVIL' } });
    await assert.rejects(httpsGet(A, { maxBytes: 100 }, { get: g }), Error, loc);
    assert.equal(g.seen.length, 1, loc);
  }
  const chain = {};
  for (let i = 0; i < 5; i++) chain[`https://github.com/r${i}`] = { status: 302, headers: { location: `https://github.com/r${i + 1}` } };
  chain['https://github.com/r5'] = { status: 200, body: 'x' };
  await assert.rejects(httpsGet('https://github.com/r0', { maxBytes: 100 }, { get: fakeGet(chain) }), /redirect/);
  await assert.rejects(httpsGet('https://evil.example/', { maxBytes: 100 }, { get: fakeGet({}) }), /host/);
  await assert.rejects(httpsGet(A, { maxBytes: 3 }, { get: fakeGet({ [A]: { status: 200, body: 'TOO BIG' } }) }), /large/);
  await assert.rejects(httpsGet(A, { maxBytes: 3 }, { get: fakeGet({ [A]: { status: 200, headers: { 'content-length': '999' }, body: '' } }) }), /large/);
  await assert.rejects(httpsGet(A, { maxBytes: 100 }, { get: fakeGet({ [A]: { status: 403, body: 'rate limited' } }) }), /403/);
  await assert.rejects(httpsGet(A, { maxBytes: 100 }, { get: fakeGet({}) }), /ECONNREFUSED/);
});

test('downloadRelease refuses asset URLs outside the project release path', async () => {
  const get = fakeGet({});
  for (const u of ['https://github.com/someone-else/repo/releases/download/v9.0.0/x', 'https://objects.githubusercontent.com/x']) {
    await assert.rejects(downloadRelease({ version: '9.0.0', bundleUrl: u, sigUrl: u }, { get }), /asset/);
  }
  assert.equal(get.seen.length, 0);
});

// --- installKind -----------------------------------------------------------------

test('installKind recognises plugin, skills CLI (direct and symlinked) and manual layouts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-kind-'));
  const home = path.join(root, 'home');
  const env = {};
  const plugin = fakeSkill(path.join(home, '.claude', 'plugins', 'cache', 'urequartermaster', 'urequartermaster', '0.1.0', 'skills', 'urequartermaster'));
  assert.equal(installKind(plugin, { home, env }), 'plugin');

  const agents = fakeSkill(path.join(home, '.agents', 'skills', 'urequartermaster'));
  assert.equal(installKind(agents, { home, env }), 'manual', 'no lock entry yet');
  write(path.join(home, '.agents', '.skill-lock.json'), JSON.stringify({ version: 3, skills: { urequartermaster: { source: 'x' } } }));
  assert.equal(installKind(agents, { home, env }), 'skills-cli');
  const link = path.join(home, '.claude', 'skills', 'urequartermaster');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  let linked = true;
  try { fs.symlinkSync(agents, link, 'junction'); } catch { linked = false; }
  if (linked) assert.equal(installKind(link, { home, env }), 'skills-cli');

  const manual = fakeSkill(path.join(home, '.codex', 'skills', 'urequartermaster'));
  assert.equal(installKind(manual, { home, env }), 'manual', 'lock entry alone is not enough');
  write(path.join(home, '.agents', '.skill-lock.json'), '{broken');
  assert.equal(installKind(agents, { home, env }), 'manual');
});

test('installKind: a copy outside the global skill folders is a project install, never manual', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-kind-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const env = { UREQM_HOME: data };
  const repo = path.join(root, 'repo');
  for (const d of [['.agents', 'skills'], ['.claude', 'skills']]) {
    const dir = fakeSkill(path.join(repo, ...d, 'urequartermaster'));
    assert.equal(installKind(dir, { home, env }), 'project', d.join('/'));
  }
  for (const d of [['.claude', 'skills'], ['.agents', 'skills'], ['.codex', 'skills'], ['.gemini', 'skills'], ['.config', 'opencode', 'skills']]) {
    assert.equal(installKind(fakeSkill(path.join(home, ...d, 'urequartermaster')), { home, env }), 'manual', d.join('/'));
  }
  // A folder the user listed in extraSkillDirs is theirs: manual.
  const extra = path.join(root, 'my-skills');
  write(path.join(data, 'config.json'), JSON.stringify({ extraSkillDirs: [extra] }));
  assert.equal(installKind(fakeSkill(path.join(extra, 'urequartermaster')), { home, env }), 'manual');
  // Nested deeper inside a global folder is not a skill folder of the agent either.
  assert.equal(installKind(fakeSkill(path.join(home, '.claude', 'skills', 'x', 'urequartermaster')), { home, env }), 'project');
});

test('a project install is never updated by qm: it says to use the installer', async () => {
  for (const mode of ['background', 'foreground', 'check']) {
    const w = world();
    const skillDir = fakeSkill(path.join(w.root, 'repo', '.agents', 'skills', 'urequartermaster'), '1.0.0');
    const before = hashTree(skillDir);
    const r = release(w.root, '1.1.0');
    let downloaded = false;
    const res = await runUpdate({ env: w.env, now: NOW, mode, skillDir,
      _deps: deps(w, r, { download: async () => { downloaded = true; return { bundleBuf: r.buf, sigBase64: r.sig }; } }) });
    assert.equal(res.status, 'project');
    assert.match(res.message, /1\.1\.0 is available.*inside a project.*update it with the tool you installed it with/);
    assert.equal(downloaded, false);
    assert.equal(hashTree(skillDir), before);
  }
});

// --- runUpdate / autoUpdateTick / dispatch -----------------------------------------

function world(installed = '1.0.0') {
  const s = setup(installed);
  const home = path.join(s.root, 'home');
  fs.mkdirSync(home);
  // CLAUDE_CONFIG_DIR = root makes <root>/skills a global skill folder, like ~/.claude/skills.
  const env = { UREQM_HOME: s.data, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: s.root };
  return { ...s, home, env };
}
const deps = (w, r, o = {}) => ({
  publicKeyPem: PEM, home: w.home, currentVersion: '1.0.0',
  fetchJson: spyFetch(relJson('v1.1.0')),
  download: async () => ({ bundleBuf: r.buf, sigBase64: r.sig }),
  ...o,
});

test('background run on a manual install verifies, applies and stores a one-line message', async () => {
  const w = world();
  const r = release(w.root, '1.1.0', 'Faster search.\nSecond line.');
  const res = await runUpdate({ env: w.env, now: NOW, mode: 'background', skillDir: w.skillDir, _deps: deps(w, r) });
  assert.equal(res.status, 'updated');
  assert.match(fs.readFileSync(path.join(w.skillDir, 'scripts', 'lib', 'version.mjs'), 'utf8'), /1\.1\.0/);
  const state = loadState(w.data);
  assert.equal(state.lastUpdateMessage, 'UreQuartermaster updated to 1.1.0: Faster search.');
  assert.equal(state.lastUpdateCheck, NOW.toISOString());
  assert.equal(state.installedVersion, '1.1.0');
});

test('background run with a bad signature changes nothing and says so', async () => {
  const w = world();
  const r = release(w.root, '1.1.0');
  const bad = { buf: r.buf, sig: sign(r.buf, OTHER.privateKey) };
  const res = await runUpdate({ env: w.env, now: NOW, mode: 'background', skillDir: w.skillDir, _deps: deps(w, bad) });
  assert.equal(res.status, 'failed');
  assert.equal(hashTree(w.skillDir), w.hash);
  assert.match(loadState(w.data).lastUpdateMessage, /not installed.*signature/);
});

test('plugin and skills-CLI installs are never touched: only the manager command is stored', async () => {
  for (const kind of ['plugin', 'skills-cli']) {
    const w = world();
    const r = release(w.root, '1.1.0');
    let downloaded = false;
    const res = await runUpdate({ env: w.env, now: NOW, mode: 'background', skillDir: w.skillDir,
      _deps: deps(w, r, { installKind: () => kind, download: async () => { downloaded = true; return {}; } }) });
    assert.equal(res.status, 'managed');
    assert.equal(downloaded, false);
    assert.equal(hashTree(w.skillDir), w.hash);
    assert.match(loadState(w.data).lastUpdateMessage, new RegExp(MANAGER_COMMANDS[kind].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(MANAGER_COMMANDS.plugin, 'claude plugin update urequartermaster@urequartermaster');
  assert.equal(MANAGER_COMMANDS['skills-cli'], 'npx skills update urequartermaster');
});

test('dotfiles kept under git (~/.git) do not block updates', async () => {
  const w = world();
  // the skill sits in <root>/home/.claude/skills/urequartermaster and the whole home is a git repo
  const skillDir = fakeSkill(path.join(w.home, '.claude', 'skills', 'urequartermaster'), '1.0.0');
  fs.mkdirSync(path.join(w.home, '.git'));
  fs.mkdirSync(path.join(w.home, '.claude', '.git'));
  write(path.join(w.home, '.claude', 'package.json'), JSON.stringify({ name: 'dotfiles' }));
  assert.equal(devCheckoutOf(skillDir), null);
  const r = release(w.root, '1.1.0');
  const { CLAUDE_CONFIG_DIR, ...env } = w.env; // ~/.claude/skills is the global folder here
  const res = await runUpdate({ env, now: NOW, mode: 'background', skillDir, _deps: deps(w, r) });
  assert.equal(res.status, 'updated');
  assert.match(fs.readFileSync(path.join(skillDir, 'scripts', 'lib', 'version.mjs'), 'utf8'), /1\.1\.0/);
});

test('a git checkout of this project is never replaced, and says so once in background', async () => {
  for (const mode of ['background', 'foreground']) {
    const w = world();
    const repo = path.join(w.root, 'skills', '..'); // <root>/skills/urequartermaster -> project root <root>
    fs.mkdirSync(path.join(repo, '.git'));
    write(path.join(repo, 'package.json'), JSON.stringify({ name: 'urequartermaster' }));
    assert.equal(devCheckoutOf(w.skillDir), fs.realpathSync(repo));
    const r = release(w.root, '1.1.0');
    let downloaded = false;
    const res = await runUpdate({ env: w.env, now: NOW, mode, skillDir: w.skillDir,
      _deps: deps(w, r, { download: async () => { downloaded = true; return { bundleBuf: r.buf, sigBase64: r.sig }; } }) });
    assert.equal(res.status, 'checkout');
    assert.match(res.message, /git checkout of the project.*git pull/);
    assert.equal(downloaded, false);
    assert.equal(hashTree(w.skillDir), w.hash);
    assert.equal(loadState(w.data).lastUpdateMessage, mode === 'background' ? res.message : null);
  }
  // same layout but another package name: not this project, so it is updated
  const w = world();
  fs.mkdirSync(path.join(w.root, '.git'));
  write(path.join(w.root, 'package.json'), JSON.stringify({ name: 'something-else' }));
  assert.equal(devCheckoutOf(w.skillDir), null);
});

test('offline background run records the check and stays silent', async () => {
  const w = world();
  const res = await runUpdate({ env: w.env, now: NOW, mode: 'background', skillDir: w.skillDir,
    _deps: deps(w, {}, { fetchJson: spyFetch(new Error('offline')) }) });
  assert.equal(res.status, 'unreachable');
  const state = loadState(w.data);
  assert.equal(state.lastUpdateMessage, null);
  assert.equal(state.lastUpdateCheck, NOW.toISOString());
  assert.equal(hashTree(w.skillDir), w.hash);
});

test('foreground runs refuse without a release key, and --check only reports', async () => {
  const w = world();
  const r = release(w.root, '1.1.0');
  const none = await runUpdate({ env: w.env, now: NOW, mode: 'foreground', skillDir: w.skillDir, _deps: deps(w, r, { publicKeyPem: null }) });
  assert.equal(none.status, 'nokey');
  assert.match(none.message, /no release key; update with your installer/);
  const chk = await runUpdate({ env: w.env, now: NOW, mode: 'check', skillDir: w.skillDir, _deps: deps(w, r) });
  assert.equal(chk.status, 'available');
  assert.match(chk.message, /1\.1\.0/);
  assert.equal(hashTree(w.skillDir), w.hash);
});

test('autoUpdateTick spawns one detached child when due and never otherwise', () => {
  const w = world();
  const spawned = [];
  const spawn = (cmd, args, opts) => { const c = { unref() { c.unrefd = true; }, cmd, args, opts }; spawned.push(c); return c; };
  const err = [];
  const tick = () => autoUpdateTick({ env: w.env, now: NOW, spawn, stderr: (s) => err.push(s), _deps: { publicKeyPem: PEM } });
  tick();
  assert.equal(spawned.length, 1);
  const c = spawned[0];
  assert.equal(c.cmd, process.execPath);
  assert.deepEqual(c.args.slice(1), ['update', '--background']);
  assert.match(c.args[0], /qm\.mjs$/);
  assert.equal(c.opts.detached, true);
  assert.equal(c.opts.stdio, 'ignore');
  assert.notEqual(c.opts.shell, true);
  assert.equal(c.unrefd, true);
  assert.equal(loadState(w.data).lastUpdateCheck, NOW.toISOString());
  tick();
  assert.equal(spawned.length, 1, 'not due again within 24 h');

  const w2 = world();
  autoUpdateTick({ env: w2.env, now: NOW, spawn, stderr: () => {}, _deps: { publicKeyPem: null } });
  autoUpdateTick({ env: { ...w2.env, UREQM_NO_UPDATE: '1' }, now: NOW, spawn, stderr: () => {}, _deps: { publicKeyPem: PEM } });
  saveConfig(w2.data, { autoUpdate: false });
  autoUpdateTick({ env: w2.env, now: NOW, spawn, stderr: () => {}, _deps: { publicKeyPem: PEM } });
  assert.equal(spawned.length, 1);
});

test('autoUpdateTick prints a stored message once to stderr and clears it', () => {
  const w = world();
  saveState(w.data, { ...loadState(w.data), lastUpdateCheck: NOW.toISOString(), lastUpdateMessage: 'UreQuartermaster updated to 1.1.0: x' });
  const err = [];
  const spawn = () => { throw new Error('should not spawn'); };
  autoUpdateTick({ env: w.env, now: NOW, spawn, stderr: (s) => err.push(s), _deps: { publicKeyPem: PEM } });
  autoUpdateTick({ env: w.env, now: NOW, spawn, stderr: (s) => err.push(s), _deps: { publicKeyPem: PEM } });
  assert.deepEqual(err, ['UreQuartermaster updated to 1.1.0: x\n']);
  assert.equal(loadState(w.data).lastUpdateMessage, null);
});

test('dispatch: hook never triggers the update tick; search/load/index/list do', () => {
  const calls = [];
  const tick = () => calls.push('tick');
  const out = () => {};
  dispatch(['hook'], out, { hook: () => 0, tick, commands: { search: () => 0 } });
  assert.deepEqual(calls, []);
  for (const c of ['search', 'load', 'index', 'list']) dispatch([c, 'x'], out, { tick, commands: { [c]: () => 0 } });
  assert.equal(calls.length, 4);
  dispatch(['doctor'], out, { tick, commands: { doctor: () => 0 } });
  dispatch(['--version'], out, { tick });
  assert.equal(calls.length, 4);
});

test('qm update offline behind a proxy says that proxies are not supported', async () => {
  const w = world();
  const run = (env) => runUpdate({ env, now: NOW, mode: 'foreground', skillDir: w.skillDir,
    _deps: deps(w, {}, { fetchJson: spyFetch(new Error('offline')) }) });
  assert.doesNotMatch((await run(w.env)).message, /prox/i);
  for (const k of ['HTTPS_PROXY', 'https_proxy']) {
    const res = await run({ ...w.env, [k]: 'http://proxy.example:3128' });
    assert.equal(res.status, 'unreachable');
    assert.match(res.message, /HTTP proxies are not supported/);
  }
});

test('installKind fails closed when the skill folder cannot be resolved', () => {
  assert.equal(installKind(path.join(os.tmpdir(), 'qm-does-not-exist-' + process.pid)), 'project');
});

test('installKind reads a skills lock file that starts with a BOM', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-bom-'));
  const dir = path.join(home, '.agents', 'skills', 'urequartermaster');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', '.skill-lock.json'), '﻿' + JSON.stringify({ skills: { urequartermaster: { source: 'dev-uretech/UreQuartermaster' } } }));
  const kind = installKind(dir, { home, env: {} });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(kind, 'skills-cli');
});
