import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, saveIndex } from '../skills/urequartermaster/scripts/lib/index/index.mjs';
import { doctor, listingSize } from '../skills/urequartermaster/scripts/lib/agent/doctor.mjs';

const QM = fileURLToPath(new URL('../skills/urequartermaster/scripts/qm.mjs', import.meta.url));
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const skillMd = (n, d = 'does things') => `---\nname: ${n}\ndescription: ${d}\n---\n# ${n}\n`;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-doc-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const cwd = path.join(root, 'cwd');
  for (const d of [home, data, cwd]) fs.mkdirSync(d, { recursive: true });
  const env = { HOME: home, USERPROFILE: home, UREQM_HOME: data, PATH: path.join(root, 'nobin'), UREQM_NO_UPDATE: '1' };
  const opts = { home, env, cwd, dataDir: data };
  return { root, home, data, cwd, env, opts, index: () => saveIndex(data, buildIndex(opts)) };
}
const canSymlink = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-sl-'));
  try { fs.symlinkSync(d, path.join(d, 'l'), 'junction'); return true; } catch { return false; } finally { fs.rmSync(d, { recursive: true, force: true }); }
})();
const msgs = (r, level) => r.filter((x) => x.level === level).map((x) => x.message);

test('healthy setup: only ok lines', () => {
  const s = setup();
  write(path.join(s.home, '.claude', 'skills', 'a', 'SKILL.md'), skillMd('a'));
  s.index();
  const r = doctor({ ...s.opts, nodeVersion: '22.1.0' });
  assert.ok(r.length >= 3);
  assert.deepEqual(msgs(r, 'warn'), []);
  assert.deepEqual(msgs(r, 'error'), []);
});

test('Node < 18 is an error', () => {
  const s = setup();
  s.index();
  assert.equal(msgs(doctor({ ...s.opts, nodeVersion: '16.20.0' }), 'error').length, 1);
});

test('missing and stale index warn', () => {
  const s = setup();
  assert.ok(msgs(doctor(s.opts), 'warn').some((m) => /index/i.test(m) && /qm index/.test(m)));
  s.index();
  write(path.join(s.home, '.claude', 'skills', 'late', 'SKILL.md'), skillMd('late'));
  assert.ok(msgs(doctor(s.opts), 'warn').some((m) => /stale|out of date/i.test(m)));
});

test('hook disabled warns', () => {
  const s = setup();
  write(path.join(s.data, 'config.json'), JSON.stringify({ hook: false }));
  s.index();
  assert.ok(msgs(doctor(s.opts), 'warn').some((m) => /hook/i.test(m)));
});

test('duplicates are reported', () => {
  const s = setup();
  write(path.join(s.home, '.claude', 'skills', 'same', 'SKILL.md'), skillMd('same', 'one'));
  write(path.join(s.home, '.agents', 'skills', 'same', 'SKILL.md'), skillMd('same', 'two'));
  s.index();
  assert.ok(msgs(doctor(s.opts), 'warn').some((m) => /duplicate/i.test(m) && m.includes('same')));
});

test('Claude Code skill listing: size reported as info, counting only what Claude Code reads', () => {
  const s = setup();
  write(path.join(s.home, '.claude', 'skills', 'a', 'SKILL.md'), skillMd('a', 'does things')); // 1 + 11
  write(path.join(s.home, '.claude', 'skills', 'bb', 'SKILL.md'), skillMd('bb', 'x'.repeat(20))); // 2 + 20
  write(path.join(s.home, '.agents', 'skills', 'not-claude', 'SKILL.md'), skillMd('not-claude', 'y'.repeat(900)));
  write(path.join(s.home, '.codex', 'skills', 'nor-this', 'SKILL.md'), skillMd('nor-this', 'z'.repeat(900)));
  s.index();
  const r = doctor(s.opts);
  assert.ok(msgs(r, 'info').includes('Claude Code skill listing: ~34 characters for 2 skills'), JSON.stringify(r));
  assert.ok(!msgs(r, 'warn').some((m) => /budget/.test(m)));
});

test('Claude Code skill listing over 8,000 characters warns, without claiming it as certain', () => {
  const s = setup();
  for (let i = 0; i < 9; i++) write(path.join(s.home, '.claude', 'skills', `sk-${i}`, 'SKILL.md'), skillMd(`sk-${i}`, 'd'.repeat(1000)));
  s.index();
  const w = msgs(doctor(s.opts), 'warn').find((m) => /budget/.test(m));
  assert.ok(w);
  assert.match(w, /may exceed Claude Code's skill listing budget \(1% of the context window; 8,000 characters when unknown\): descriptions of the least-used skills are dropped\. Check \/context, or park skills you rarely use with qm park\./);
  assert.match(w, /~9,036 characters for 9 skills/);
  const s2 = setup();
  for (let i = 0; i < 61; i++) write(path.join(s2.home, '.claude', 'skills', `sk-${i}`, 'SKILL.md'), skillMd(`sk-${i}`, 'short'));
  s2.index();
  assert.ok(!msgs(doctor(s2.opts), 'warn').some((m) => /budget|truncate/.test(m)), 'no skill-count rule');
});

test('the listing size counts enabled plugin skills with their plugin prefix, and not disabled ones', () => {
  const s = setup();
  const inst = installPlugin(s, 'kit', true);
  write(path.join(inst, 'skills', 'one', 'SKILL.md'), skillMd('one', 'abc'));
  s.index();
  assert.ok(msgs(doctor(s.opts), 'info').includes('Claude Code skill listing: ~10 characters for 1 skill')); // "kit:one" + "abc"
  const s2 = setup();
  const inst2 = installPlugin(s2, 'kit', false);
  write(path.join(inst2, 'skills', 'one', 'SKILL.md'), skillMd('one', 'abc'));
  s2.index();
  assert.ok(msgs(doctor(s2.opts), 'info').includes('Claude Code skill listing: ~0 characters for 0 skills'));
});

test('a description longer than 1,536 characters counts as 1,536 in the listing estimate', () => {
  assert.equal(listingSize([{ name: 'ab', description: 'x'.repeat(5000) }, { name: 'c', description: 'yy' }]), 2 + 1536 + 1 + 2);
});

test('parked records stuck in pending/interrupted warn with the way out', () => {
  const s = setup();
  s.index();
  write(path.join(s.data, 'state.json'), JSON.stringify({ parked: [
    { name: 'half', from: '/a', to: '/b', pending: true },
    { name: 'fine', from: '/a', to: '/c' },
    { name: 'broken', from: '/a', to: '/d', interrupted: 'unpark' },
  ] }));
  const w = msgs(doctor(s.opts), 'warn').filter((m) => /qm unpark/.test(m));
  assert.equal(w.length, 2);
  assert.ok(w.some((m) => m.includes('half') && m.includes('--forget')));
  assert.ok(!w.some((m) => m.includes('fine')));
});

test('third-party text is cleaned', () => {
  const s = setup();
  write(path.join(s.data, 'state.json'), JSON.stringify({ parked: [{ name: 'x\u001b[2Jy', from: '/a', to: '/b', pending: true }] }));
  s.index();
  assert.ok(doctor(s.opts).every((x) => !/[\x00-\x1f\x7f-\x9f]/.test(x.message)));
});

test('qm doctor prints levels and exits 1 only on error', () => {
  const s = setup();
  const run = (extra = {}) => spawnSync(process.execPath, [QM, 'doctor'], { env: { ...s.env, ...extra }, cwd: s.cwd, encoding: 'utf8' });
  const r = run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\[warn\] /m);
  assert.match(r.stdout, /^\[ok\] /m);
  // the real Node version is >= 18 here, so the error exit is covered by the unit test above
  const bad = spawnSync(process.execPath, [QM, 'doctor', 'extra'], { env: s.env, encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

// A Claude Code plugin in the plugin cache, enabled or not; returns its install folder.
function installPlugin(s, plugin = 'urequartermaster', enabled = true) {
  const inst = path.join(s.home, '.claude', 'plugins', 'cache', plugin, plugin, '0.1.0');
  fs.mkdirSync(inst, { recursive: true });
  const f = path.join(s.home, '.claude', 'plugins', 'installed_plugins.json');
  const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { version: 2, plugins: {} };
  cur.plugins[`${plugin}@${plugin}`] = [{ installPath: inst }];
  write(f, JSON.stringify(cur));
  const sf = path.join(s.home, '.claude', 'settings.json');
  const set = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : { enabledPlugins: {} };
  set.enabledPlugins[`${plugin}@${plugin}`] = enabled;
  write(sf, JSON.stringify(set));
  return inst;
}
const qmCopy = (dir) => write(path.join(dir, 'urequartermaster', 'SKILL.md'), skillMd('urequartermaster'));
const copyWarn = (r) => msgs(r, 'warn').filter((m) => /copies of UreQuartermaster/.test(m));

test('plugin for Claude Code plus a skills CLI copy for Codex: one copy per agent, an ok line, no warning', () => {
  const s = setup();
  const inst = installPlugin(s);
  qmCopy(path.join(inst, 'skills'));
  qmCopy(path.join(s.home, '.agents', 'skills'));
  fs.mkdirSync(path.join(s.home, '.codex'), { recursive: true });
  s.index();
  const r = doctor(s.opts);
  assert.deepEqual(copyWarn(r), []);
  const ok = msgs(r, 'ok').find((m) => /UreQuartermaster cop/.test(m));
  assert.ok(ok, JSON.stringify(r));
  assert.ok(ok.includes(`Claude Code uses ${path.join(inst, 'skills', 'urequartermaster')}`), ok);
  assert.ok(ok.includes(`Codex uses ${path.join(s.home, '.agents', 'skills', 'urequartermaster')}`), ok);
});

test('plugin plus a copy in ~/.claude/skills: Claude Code sees both, warn with both paths', () => {
  const s = setup();
  const inst = installPlugin(s);
  qmCopy(path.join(inst, 'skills'));
  qmCopy(path.join(s.home, '.claude', 'skills'));
  s.index();
  const w = copyWarn(doctor(s.opts));
  assert.equal(w.length, 1, JSON.stringify(w));
  assert.match(w[0], /^Claude Code would load 2 copies of UreQuartermaster: /);
  assert.ok(w[0].includes(path.join(inst, 'skills', 'urequartermaster')) && w[0].includes(path.join(s.home, '.claude', 'skills', 'urequartermaster')), w[0]);
  assert.match(w[0], /Keep one\.$/);
});

test('a disabled plugin copy does not count', () => {
  const s = setup();
  qmCopy(path.join(installPlugin(s, 'urequartermaster', false), 'skills'));
  qmCopy(path.join(s.home, '.claude', 'skills'));
  s.index();
  assert.deepEqual(copyWarn(doctor(s.opts)), []);
});

test('~/.agents/skills plus ~/.codex/skills: Codex sees both', () => {
  const s = setup();
  qmCopy(path.join(s.home, '.agents', 'skills'));
  qmCopy(path.join(s.home, '.codex', 'skills'));
  s.index();
  const w = copyWarn(doctor(s.opts));
  assert.equal(w.length, 1);
  assert.match(w[0], /^Codex would load 2 copies/);
});

test('CODEX_HOME moves the legacy Codex folder', () => {
  const s = setup();
  const codexHome = path.join(s.root, 'codex-home');
  qmCopy(path.join(s.home, '.agents', 'skills'));
  qmCopy(path.join(codexHome, 'skills'));
  const env = { ...s.env, CODEX_HOME: codexHome };
  saveIndex(s.data, buildIndex({ ...s.opts, env }));
  const w = copyWarn(doctor({ ...s.opts, env }));
  assert.equal(w.length, 1);
  assert.ok(w[0].includes(path.join(codexHome, 'skills', 'urequartermaster')));
});

test('a project copy shadowing a global one for the same agent warns', () => {
  const s = setup();
  qmCopy(path.join(s.home, '.claude', 'skills'));
  qmCopy(path.join(s.cwd, '.claude', 'skills'));
  s.index();
  const w = copyWarn(doctor(s.opts));
  assert.equal(w.length, 1);
  assert.ok(w[0].startsWith('Claude Code') && w[0].includes(path.join(s.cwd, '.claude', 'skills', 'urequartermaster')), w[0]);
});

test('~/.claude/skills and ~/.agents/skills copies: warn only when OpenCode, which reads both, is in use', () => {
  const s = setup();
  qmCopy(path.join(s.home, '.claude', 'skills'));
  qmCopy(path.join(s.home, '.agents', 'skills'));
  fs.mkdirSync(path.join(s.home, '.codex'), { recursive: true });
  s.index();
  assert.deepEqual(copyWarn(doctor(s.opts)), []);
  fs.mkdirSync(path.join(s.home, '.config', 'opencode'), { recursive: true });
  const w = copyWarn(doctor(s.opts));
  assert.equal(w.length, 1);
  assert.match(w[0], /^OpenCode would load 2 copies/);
});

test('a skills CLI link in ~/.claude/skills is the same copy, not a second one', { skip: !canSymlink && 'no symlink support' }, () => {
  const s = setup();
  qmCopy(path.join(s.home, '.agents', 'skills'));
  fs.mkdirSync(path.join(s.home, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(path.join(s.home, '.agents', 'skills', 'urequartermaster'), path.join(s.home, '.claude', 'skills', 'urequartermaster'), 'junction');
  fs.mkdirSync(path.join(s.home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(s.home, '.config', 'opencode'), { recursive: true });
  s.index();
  const r = doctor(s.opts);
  assert.deepEqual(copyWarn(r), []);
  const ok = msgs(r, 'ok').find((m) => /UreQuartermaster cop/.test(m));
  assert.ok(ok && /Claude Code uses/.test(ok) && /Codex uses/.test(ok) && /OpenCode uses/.test(ok), ok);
});

test('the hook line says whether the Claude Code plugin that runs it is enabled', () => {
  const s = setup();
  s.index();
  const without = msgs(doctor(s.opts), 'ok').join('\n');
  assert.match(without, /Prompt hook not active/);
  assert.doesNotMatch(without, /Prompt hook enabled/);
  write(path.join(s.home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'urequartermaster@urequartermaster': [{ installPath: path.join(s.root, 'x') }] } }));
  write(path.join(s.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'urequartermaster@urequartermaster': true } }));
  assert.match(msgs(doctor(s.opts), 'ok').join('\n'), /Prompt hook enabled/);
});
