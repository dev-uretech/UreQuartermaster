import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanSkills } from '../skills/urequartermaster/scripts/lib/scan/skills.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qm-scan-'));
const skillMd = (name, desc = `Does ${name}`) => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`;
function put(dir, md) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), md); }
const write = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };

function setup() {
  const root = tmp();
  const home = path.join(root, 'Casa Rossi'); // space in path
  const locations = {
    skillDirs: [
      { dir: path.join(home, '.claude', 'skills'), source: 'claude' },
      { dir: path.join(home, '.agents', 'skills'), source: 'agents' },
      { dir: path.join(home, '.codex', 'skills'), source: 'codex' },
    ],
    pluginCache: path.join(home, '.claude', 'plugins', 'cache'),
    installedPluginsFile: path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    claudeSettingsFile: path.join(home, '.claude', 'settings.json'),
  };
  const dataDir = path.join(root, 'data');
  return { root, home, locations, dataDir, config: { extraSkillDirs: [] } };
}
const byId = (list, id) => list.filter((e) => e.id === id);

test('installed skills: top level only, spaces and accents in names', () => {
  const s = setup();
  put(path.join(s.home, '.claude', 'skills', 'ricerca città'), skillMd('ricerca-città', 'Cerca'));
  put(path.join(s.home, '.claude', 'skills', 'nested', 'deep'), skillMd('deep'));
  const r = scanSkills(s.locations, s);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].id, r[0].state, r[0].source, r[0].usage], ['skill:ricerca-città', 'installed', 'claude', 'Skill tool: ricerca-città']);
  assert.equal(r[0].kind, 'skill');
  assert.equal(r[0].path, path.join(s.home, '.claude', 'skills', 'ricerca città', 'SKILL.md'));
});

test('missing frontmatter falls back to folder name', () => {
  const s = setup();
  put(path.join(s.home, '.codex', 'skills', 'plain'), '# Just text\n');
  const r = scanSkills(s.locations, s);
  assert.equal(r[0].name, 'plain');
});

test('plugin skills use installPath, enabled only when exactly true', () => {
  const s = setup();
  const a = path.join(s.home, '.claude', 'plugins', 'cache', 'mk', 'alpha', '2.0.0');
  const old = path.join(s.home, '.claude', 'plugins', 'cache', 'mk', 'alpha', '1.0.0');
  const b = path.join(s.home, '.claude', 'plugins', 'cache', 'mk', 'beta', '1.0.0');
  put(path.join(a, 'skills', 'one'), skillMd('one'));
  put(path.join(old, 'skills', 'stale'), skillMd('stale'));
  put(path.join(b, 'skills', 'two'), skillMd('two'));
  write(s.locations.installedPluginsFile, { version: 2, plugins: { 'alpha@mk': [{ installPath: a, version: '2.0.0' }], 'beta@mk': [{ installPath: b }] } });
  write(s.locations.claudeSettingsFile, { env: { TOKEN: 'secret-xyz' }, enabledPlugins: { 'alpha@mk': true, 'beta@mk': [] } });
  const r = scanSkills(s.locations, s);
  const one = byId(r, 'skill:alpha:one')[0];
  assert.deepEqual([one.name, one.source, one.state, one.usage], ['alpha:one', 'plugin:alpha', 'installed', 'Skill tool: alpha:one']);
  const two = byId(r, 'skill:beta:two')[0];
  assert.deepEqual([two.state, two.usage], ['plugin-disabled', 'qm load beta:two']);
  assert.equal(byId(r, 'skill:alpha:stale').length, 0);
  assert.ok(!JSON.stringify(r).includes('secret-xyz'));
});

test('plugin fallback: no installed_plugins.json -> highest version in cache', () => {
  const s = setup();
  const c = s.locations.pluginCache;
  put(path.join(c, 'mk', 'gamma', '1.9.0', 'skills', 'old'), skillMd('old'));
  put(path.join(c, 'mk', 'gamma', '1.10.0', 'skills', 'new'), skillMd('new'));
  write(s.locations.claudeSettingsFile, { enabledPlugins: { 'gamma@mk': true } });
  const r = scanSkills(s.locations, s);
  assert.deepEqual(r.map((e) => e.id), ['skill:gamma:new']);
  assert.equal(r[0].state, 'installed');
});

test('library: collections, depth limit, usage', () => {
  const s = setup();
  const lib = path.join(s.dataDir, 'library');
  put(path.join(lib, 'coll', 'a', 'b', 'tool'), skillMd('tool'));
  put(path.join(lib, 'coll', '1', '2', '3', '4', '5', '6', 'tooDeep'), skillMd('tooDeep'));
  const r = scanSkills(s.locations, s);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].id, r[0].state, r[0].source, r[0].usage], ['skill:tool', 'library', 'library:coll', 'qm load tool']);
});

test('duplicates: plugin > agents > claude > library, others carry duplicateOf', () => {
  const s = setup();
  const p = path.join(s.home, 'plug');
  put(path.join(p, 'skills', 'x'), skillMd('x'));
  write(s.locations.installedPluginsFile, { plugins: { 'pl@mk': [{ installPath: p }] } });
  write(s.locations.claudeSettingsFile, { enabledPlugins: { 'pl@mk': true } });
  put(path.join(s.home, '.claude', 'skills', 'dup'), skillMd('dup'));
  put(path.join(s.home, '.agents', 'skills', 'dup'), skillMd('dup'));
  put(path.join(s.dataDir, 'library', 'c', 'dup'), skillMd('dup'));
  const r = scanSkills(s.locations, s);
  const dups = r.filter((e) => e.name === 'dup');
  assert.equal(dups.length, 3);
  const kept = dups.filter((e) => !e.duplicateOf);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].source, 'agents');
  const losers = dups.filter((e) => e.duplicateOf);
  for (const d of losers) assert.equal(d.duplicateOf, 'skill:dup');
  assert.deepEqual(losers.map((e) => e.id).sort(), ['skill:dup@claude', 'skill:dup@library:c']);
  assert.equal(new Set(r.map((e) => e.id)).size, r.length);
  assert.equal(r.filter((e) => e.name === 'pl:x' && !e.duplicateOf).length, 1);
});

test('same realpath reached twice appears once', (t) => {
  const s = setup();
  const real = path.join(s.home, 'store', 'shared');
  put(real, skillMd('shared'));
  for (const d of ['.claude', '.codex']) {
    fs.mkdirSync(path.join(s.home, d, 'skills'), { recursive: true });
    try { fs.symlinkSync(real, path.join(s.home, d, 'skills', 'shared'), 'dir'); } catch (e) { if (e.code === 'EPERM') return t.skip('symlinks need privileges on Windows'); throw e; }
  }
  const r = scanSkills(s.locations, s);
  assert.equal(r.length, 1);
  assert.equal(r[0].duplicateOf, undefined);
});

test('symlink loop in library does not hang or duplicate; broken links skipped', (t) => {
  const s = setup();
  const coll = path.join(s.dataDir, 'library', 'c');
  put(path.join(coll, 'real', 'sk'), skillMd('sk'));
  try {
    fs.symlinkSync(coll, path.join(coll, 'real', 'loop'), 'dir');
    fs.symlinkSync(path.join(s.root, 'nowhere'), path.join(coll, 'broken'), 'dir');
    fs.mkdirSync(path.join(s.home, '.claude', 'skills'), { recursive: true });
    fs.symlinkSync(path.join(s.root, 'nowhere'), path.join(s.home, '.claude', 'skills', 'dead'), 'dir');
  } catch (e) { if (e.code === 'EPERM') return t.skip('symlinks need privileges on Windows'); throw e; }
  const r = scanSkills(s.locations, s);
  assert.deepEqual(r.map((e) => e.id), ['skill:sk']);
});

test('extraSkillDirs from config are scanned; missing dirs ignored', () => {
  const s = setup();
  const extra = path.join(s.root, 'mie skill');
  put(path.join(extra, 'e1'), skillMd('e1'));
  const r = scanSkills(s.locations, { dataDir: s.dataDir, config: { extraSkillDirs: [extra, path.join(s.root, 'absent')] } });
  assert.deepEqual(r.map((e) => [e.id, e.state]), [['skill:e1', 'installed']]);
});

test('nothing exists -> empty list, no throw', () => {
  const s = setup();
  assert.deepEqual(scanSkills(s.locations, s), []);
});

test('stale installPath falls back to highest cached version of that plugin', () => {
  const s = setup();
  const c = s.locations.pluginCache;
  put(path.join(c, 'mk', 'gamma', '1.9.0', 'skills', 'old'), skillMd('old'));
  put(path.join(c, 'mk', 'gamma', '1.10.0', 'skills', 'new'), skillMd('new'));
  write(s.locations.installedPluginsFile, { plugins: { 'gamma@mk': [{ installPath: path.join(c, 'mk', 'gamma', 'gone') }] } });
  write(s.locations.claudeSettingsFile, { enabledPlugins: { 'gamma@mk': true } });
  assert.deepEqual(scanSkills(s.locations, s).map((e) => e.id), ['skill:gamma:new']);
});

test('duplicates from the same source get #2 suffix', () => {
  const s = setup();
  put(path.join(s.dataDir, 'library', 'c', 'a', 'dup'), skillMd('dup'));
  put(path.join(s.dataDir, 'library', 'c', 'b', 'dup'), skillMd('dup'));
  put(path.join(s.dataDir, 'library', 'c', 'z', 'dup'), skillMd('dup'));
  const ids = scanSkills(s.locations, s).map((e) => e.id).sort();
  assert.deepEqual(ids, ['skill:dup', 'skill:dup@library:c', 'skill:dup@library:c#2']);
});

test('library skips .git and node_modules', () => {
  const s = setup();
  const coll = path.join(s.dataDir, 'library', 'coll');
  put(path.join(coll, '.git', 'x'), skillMd('gitx'));
  put(path.join(coll, 'node_modules', 'y'), skillMd('nmy'));
  put(path.join(coll, 'ok'), skillMd('ok'));
  assert.deepEqual(scanSkills(s.locations, s).map((e) => e.id), ['skill:ok']);
});

test('library skill at exactly depth 6 is found', () => {
  const s = setup();
  put(path.join(s.dataDir, 'library', 'coll', '1', '2', '3', '4', '5', 'deep6'), skillMd('deep6'));
  assert.deepEqual(scanSkills(s.locations, s).map((e) => e.id), ['skill:deep6']);
});

test('non-array extraSkillDirs does not throw', () => {
  const s = setup();
  assert.deepEqual(scanSkills(s.locations, { dataDir: s.dataDir, config: { extraSkillDirs: 'oops' } }), []);
});

test('unsafe skill names never reach the index: folder name, then sanitized folder name, else dropped', () => {
  const s = setup();
  const d = path.join(s.home, '.claude', 'skills');
  put(path.join(d, 'pdf-merge'), skillMd('pdf-merge$(touch /tmp/qm-pwned)'));
  put(path.join(d, 'tick'), skillMd('a`id`b'));
  put(path.join(d, 'semi'), skillMd('x; rm -rf ~'));
  put(path.join(d, 'spaced'), skillMd('two words'));
  put(path.join(d, 'opt'), skillMd('--help'));
  put(path.join(d, 'colon'), skillMd('toolkit:fake'));
  put(path.join(d, 'bad$(id)dir'), '# no frontmatter\n');
  put(path.join(d, '$(x)'), '# no frontmatter\n');
  const names = scanSkills(s.locations, s).map((e) => e.name).sort();
  assert.deepEqual(names, ['bad-id-dir', 'colon', 'opt', 'pdf-merge', 'semi', 'spaced', 'tick', 'x-']);
  for (const e of scanSkills(s.locations, s)) assert.match(e.usage, /^Skill tool: [\p{L}\p{N}][\p{L}\p{M}\p{N}._-]*$/u);
});

test('a plugin with an unsafe name is skipped', () => {
  const s = setup();
  const a = path.join(s.home, '.claude', 'plugins', 'cache', 'mk', 'evil', '1.0.0');
  put(path.join(a, 'skills', 'one'), skillMd('one'));
  write(s.locations.installedPluginsFile, { version: 2, plugins: { 'ev$(id)il@mk': [{ installPath: a }] } });
  assert.deepEqual(scanSkills(s.locations, s), []);
});
