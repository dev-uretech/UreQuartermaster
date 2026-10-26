import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, loadState, saveState } from '../skills/urequartermaster/scripts/lib/core/config.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'qm-cfg-'));
const DEFAULT_CFG = { extraSkillDirs: [], clis: [], autoUpdate: true, hook: true, maxIndexAgeHours: 24, mcpDescriptions: {}, trustProjectMcp: false };
const DEFAULT_STATE = { lastUpdateCheck: null, installedVersion: null, lastUpdateMessage: null, parked: [] };

test('loadConfig on empty dir returns defaults', () => {
  const d = tmp();
  assert.deepEqual(loadConfig(d), DEFAULT_CFG);
  rmSync(d, { recursive: true });
});

test('loadConfig on missing dir returns defaults', () => {
  assert.deepEqual(loadConfig(path.join(tmp(), 'nope')), DEFAULT_CFG);
});

test('corrupt or wrong-shaped config.json returns defaults without throwing', () => {
  const d = tmp();
  for (const bad of ['{not json', '', '[1,2]', 'null', '"x"']) {
    writeFileSync(path.join(d, 'config.json'), bad);
    assert.deepEqual(loadConfig(d), DEFAULT_CFG);
  }
  rmSync(d, { recursive: true });
});

test('partial config is merged with defaults; bad field types fall back', () => {
  const d = tmp();
  writeFileSync(path.join(d, 'config.json'), JSON.stringify({ autoUpdate: false, extraSkillDirs: 'oops', maxIndexAgeHours: 'x', clis: [{ name: 'gh', description: 'GitHub' }, 5] }));
  const c = loadConfig(d);
  assert.equal(c.autoUpdate, false);
  assert.equal(c.hook, true);
  assert.deepEqual(c.extraSkillDirs, []);
  assert.equal(c.maxIndexAgeHours, 24);
  assert.deepEqual(c.clis, [{ name: 'gh', description: 'GitHub' }]);
  rmSync(d, { recursive: true });
});

test('saveConfig creates the dir, round-trips and leaves no temp files', () => {
  const d = path.join(tmp(), 'deep', 'dir');
  const cfg = { ...DEFAULT_CFG, extraSkillDirs: ['/a b/é'], mcpDescriptions: { x: 'y' }, hook: false };
  saveConfig(d, cfg);
  assert.deepEqual(loadConfig(d), cfg);
  assert.deepEqual(readdirSync(d), ['config.json']);
  saveConfig(d, { ...cfg, hook: true });
  assert.equal(loadConfig(d).hook, true);
  assert.deepEqual(readdirSync(d), ['config.json']);
});

test('state defaults, corrupt file, and round-trip', () => {
  const d = tmp();
  assert.deepEqual(loadState(d), DEFAULT_STATE);
  writeFileSync(path.join(d, 'state.json'), '{{{');
  assert.deepEqual(loadState(d), DEFAULT_STATE);
  const st = { lastUpdateCheck: '2026-10-25T00:00:00.000Z', installedVersion: '0.1.0', lastUpdateMessage: 'UreQuartermaster updated to 1.1.0: x', parked: [{ name: 'p', from: '/a', to: '/b', lockEntry: { k: 1 } }] };
  saveState(d, st);
  assert.deepEqual(loadState(d), st);
  assert.deepEqual(JSON.parse(readFileSync(path.join(d, 'state.json'), 'utf8')), st);
  rmSync(d, { recursive: true });
});

test('state with wrong field types falls back per field', () => {
  const d = tmp();
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'state.json'), JSON.stringify({ lastUpdateCheck: 3, installedVersion: '1.0.0', parked: [{ name: 'a', from: 'b', to: 'c' }, 'junk'] }));
  const s = loadState(d);
  assert.equal(s.lastUpdateCheck, null);
  assert.equal(s.installedVersion, '1.0.0');
  assert.deepEqual(s.parked, [{ name: 'a', from: 'b', to: 'c' }]);
  rmSync(d, { recursive: true });
});

test('trustProjectMcp: only a real true is accepted', () => {
  for (const [v, want] of [[true, true], ['true', false], [1, false], [false, false]]) {
    const d = tmp();
    writeFileSync(path.join(d, 'config.json'), JSON.stringify({ trustProjectMcp: v }));
    assert.equal(loadConfig(d).trustProjectMcp, want);
    rmSync(d, { recursive: true });
  }
});

test('lastUpdateCheck must be a real date; lastUpdateMessage is one clean line', () => {
  const d = tmp();
  for (const [v, want] of [['garbage', null], ['', null], ['2026-13-45T00:00:00Z', null], ['2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z']]) {
    writeFileSync(path.join(d, 'state.json'), JSON.stringify({ lastUpdateCheck: v }));
    assert.equal(loadState(d).lastUpdateCheck, want, v);
  }
  writeFileSync(path.join(d, 'state.json'), JSON.stringify({ lastUpdateMessage: 'a\nb\u001b[31m' + 'x'.repeat(500) }));
  const m = loadState(d).lastUpdateMessage;
  assert.ok(!/[\n\u001b]/.test(m));
  assert.ok(m.length <= 300);
  writeFileSync(path.join(d, 'state.json'), JSON.stringify({ lastUpdateMessage: 7 }));
  assert.equal(loadState(d).lastUpdateMessage, null);
  rmSync(d, { recursive: true });
});
