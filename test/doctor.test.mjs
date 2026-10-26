import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, saveIndex } from '../skills/urequartermaster/scripts/lib/index/index.mjs';
import { doctor } from '../skills/urequartermaster/scripts/lib/agent/doctor.mjs';

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

test('more than 60 installed skills warns about truncation', () => {
  const s = setup();
  for (let i = 0; i < 61; i++) write(path.join(s.home, '.claude', 'skills', `sk-${i}`, 'SKILL.md'), skillMd(`sk-${i}`));
  s.index();
  assert.ok(msgs(doctor(s.opts), 'warn').some((m) => m.includes('the host may truncate descriptions; consider `qm park`')));
  const s2 = setup();
  for (let i = 0; i < 60; i++) write(path.join(s2.home, '.claude', 'skills', `sk-${i}`, 'SKILL.md'), skillMd(`sk-${i}`));
  s2.index();
  assert.ok(!msgs(doctor(s2.opts), 'warn').some((m) => /truncate/.test(m)));
});

test('several copies of urequartermaster warn with the paths', () => {
  const s = setup();
  write(path.join(s.home, '.claude', 'skills', 'urequartermaster', 'SKILL.md'), skillMd('urequartermaster'));
  write(path.join(s.home, '.agents', 'skills', 'urequartermaster', 'SKILL.md'), skillMd('urequartermaster'));
  s.index();
  const w = msgs(doctor(s.opts), 'warn').find((m) => /UreQuartermaster/.test(m) && /cop/i.test(m));
  assert.ok(w);
  assert.ok(w.includes(path.join(s.home, '.claude', 'skills', 'urequartermaster')) && w.includes(path.join(s.home, '.agents', 'skills', 'urequartermaster')));
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

test('a plugin copy plus a manual copy of urequartermaster are reported', () => {
  const s = setup();
  const inst = path.join(s.home, '.claude', 'plugins', 'cache', 'urequartermaster', 'urequartermaster', '0.1.0');
  write(path.join(inst, 'skills', 'urequartermaster', 'SKILL.md'), skillMd('urequartermaster'));
  write(path.join(s.home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'urequartermaster@urequartermaster': [{ installPath: inst }] } }));
  write(path.join(s.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'urequartermaster@urequartermaster': true } }));
  write(path.join(s.home, '.agents', 'skills', 'urequartermaster', 'SKILL.md'), skillMd('urequartermaster'));
  s.index();
  const w = msgs(doctor(s.opts), 'warn').find((m) => /Several copies/.test(m));
  assert.ok(w && w.includes(path.join(inst, 'skills', 'urequartermaster')), w);
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
