import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildIndex, saveIndex, loadIndex, isStale, ensureIndex, INDEX_VERSION,
} from '../skills/urequartermaster/scripts/lib/index/index.mjs';
import { computeFingerprint } from '../skills/urequartermaster/scripts/lib/index/fingerprint.mjs';
import { scanProject } from '../skills/urequartermaster/scripts/lib/index/project.mjs';

const write = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o)); };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-idx-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  write(path.join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha skill\n---\n# Alpha\n');
  write(path.join(home, '.claude.json'), { mcpServers: { srv: { command: 'node', args: ['x.js'] } } });
  const opts = { home, platform: 'linux', env: { PATH: '', UREQM_HOME: data }, cwd, dataDir: data };
  return { root, home, data, cwd, opts };
}
const touch = (p, sec) => { const t = new Date(Date.now() + sec * 1000); fs.utimesSync(p, t, t); };

test('buildIndex collects skills and MCP, with version, builtAt and fingerprint', () => {
  const s = setup();
  const idx = buildIndex(s.opts);
  assert.equal(idx.version, INDEX_VERSION);
  assert.ok(!Number.isNaN(Date.parse(idx.builtAt)));
  assert.match(idx.fingerprint, /^[0-9a-f]{64}\.[0-9a-f]{64}$/);
  assert.ok(idx.entries.some((e) => e.kind === 'skill' && e.name === 'alpha'));
  assert.ok(idx.entries.some((e) => e.kind === 'mcp' && e.name === 'srv'));
});

test('fingerprint changes when a skill folder mtime or the MCP servers change', () => {
  const s = setup();
  const f0 = computeFingerprint(s.opts);
  assert.equal(computeFingerprint(s.opts), f0);
  touch(path.join(s.home, '.claude', 'skills', 'alpha'), 100);
  const f1 = computeFingerprint(s.opts);
  assert.notEqual(f1, f0);
  write(path.join(s.home, '.claude.json'), { mcpServers: { srv: { command: 'node', args: ['y.js'] } } });
  assert.notEqual(computeFingerprint(s.opts), f1);
});

test('fingerprint ignores rewrites of .claude.json and settings.json that leave servers and plugins alone', () => {
  const s = setup();
  const claudeJson = path.join(s.home, '.claude.json');
  const settings = path.join(s.home, '.claude', 'settings.json');
  write(settings, { enabledPlugins: { 'a@m': true }, theme: 'dark' });
  const f0 = computeFingerprint(s.opts);
  // What Claude Code does on almost every tool call: other keys change, the file is saved again.
  write(claudeJson, { numStartups: 7, tipsHistory: { x: 3 }, mcpServers: { srv: { command: 'node', args: ['x.js'] } },
    projects: { [s.cwd]: { lastCost: 1, mcpServers: { local: { command: 'npx', args: ['p'] } } } } });
  touch(claudeJson, 300);
  write(settings, { enabledPlugins: { 'a@m': true }, theme: 'light' });
  touch(settings, 300);
  assert.equal(computeFingerprint(s.opts), f0);
  // A secret in env changes nothing that is indexed either.
  write(claudeJson, { mcpServers: { srv: { command: 'node', args: ['x.js'], env: { TOKEN: 'other' } } } });
  assert.equal(computeFingerprint(s.opts), f0);
  write(settings, { enabledPlugins: { 'a@m': false } });
  assert.notEqual(computeFingerprint(s.opts), f0);
});

test('fingerprint changes when a skill folder is added, or config.json / library appear', () => {
  const s = setup();
  const f0 = computeFingerprint(s.opts);
  fs.mkdirSync(path.join(s.home, '.claude', 'skills', 'beta'));
  const f1 = computeFingerprint(s.opts);
  assert.notEqual(f1, f0);
  write(path.join(s.data, 'config.json'), { hook: false });
  const f2 = computeFingerprint(s.opts);
  assert.notEqual(f2, f1);
  fs.mkdirSync(path.join(s.data, 'library', 'col'), { recursive: true });
  assert.notEqual(computeFingerprint(s.opts), f2);
});

test('fingerprint never throws on missing paths', () => {
  const s = setup();
  const o = { ...s.opts, home: path.join(s.root, 'nope'), dataDir: path.join(s.root, 'nodata') };
  assert.match(computeFingerprint(o), /^[0-9a-f]{64}\.[0-9a-f]{64}$/);
});

test('saveIndex / loadIndex round trip, atomic (no temp files left)', () => {
  const s = setup();
  const idx = buildIndex(s.opts);
  const dir = path.join(s.root, 'new', 'dir');
  saveIndex(dir, idx);
  assert.deepEqual(fs.readdirSync(dir), ['index.json']);
  assert.deepEqual(loadIndex(dir), idx);
});

test('saveIndex writes a temp file then renames it', () => {
  const s = setup();
  const calls = [];
  const orig = fs.renameSync;
  fs.renameSync = (a, b) => { calls.push([a, b]); return orig(a, b); };
  try { saveIndex(s.data, buildIndex(s.opts)); } finally { fs.renameSync = orig; }
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0][0], calls[0][1]);
  assert.equal(path.dirname(calls[0][0]), path.dirname(calls[0][1]));
  assert.equal(calls[0][1], path.join(s.data, 'index.json'));
});

test('loadIndex returns null for missing, corrupt, wrong version, wrong shape', () => {
  const s = setup();
  assert.equal(loadIndex(s.data), null);
  write(path.join(s.data, 'index.json'), '{not json');
  assert.equal(loadIndex(s.data), null);
  write(path.join(s.data, 'index.json'), { version: 99, builtAt: 'x', fingerprint: 'y', entries: [] });
  assert.equal(loadIndex(s.data), null);
  write(path.join(s.data, 'index.json'), { version: INDEX_VERSION, builtAt: 'x', fingerprint: 'y', entries: 'no' });
  assert.equal(loadIndex(s.data), null);
});

test('isStale: fresh false; fingerprint change true; too old true; null true', () => {
  const s = setup();
  const idx = buildIndex(s.opts);
  assert.equal(isStale(idx, s.opts), false);
  assert.equal(isStale(null, s.opts), true);
  assert.equal(isStale(idx, { ...s.opts, now: Date.parse(idx.builtAt) + 25 * 3600e3 }), true);
  assert.equal(isStale(idx, { ...s.opts, now: Date.parse(idx.builtAt) + 23 * 3600e3 }), false);
  write(path.join(s.home, '.claude.json'), { mcpServers: { srv: { command: 'node', args: ['x.js'] }, two: { url: 'https://example.com/mcp' } } });
  assert.equal(isStale(idx, s.opts), true);
});

test('isStale honours maxIndexAgeHours from config', () => {
  const s = setup();
  write(path.join(s.data, 'config.json'), { maxIndexAgeHours: 1 });
  const idx = buildIndex(s.opts);
  assert.equal(isStale(idx, { ...s.opts, now: Date.parse(idx.builtAt) + 2 * 3600e3 }), true);
});

test('ensureIndex rebuilds and saves when missing, reuses when fresh', () => {
  const s = setup();
  const a = ensureIndex(s.opts);
  assert.ok(fs.existsSync(path.join(s.data, 'index.json')));
  const b = ensureIndex(s.opts);
  assert.equal(b.builtAt, a.builtAt);
});

test('ensureIndex allowRebuild:false returns null if missing, stale one without rebuilding', () => {
  const s = setup();
  assert.equal(ensureIndex(s.opts, { allowRebuild: false }), null);
  assert.ok(!fs.existsSync(path.join(s.data, 'index.json')));
  const idx = ensureIndex(s.opts);
  write(path.join(s.home, '.claude', 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: Beta\n---\n');
  const old = ensureIndex(s.opts, { allowRebuild: false });
  assert.equal(old.fingerprint, idx.fingerprint);
  assert.deepEqual(loadIndex(s.data), idx);
  const fresh = ensureIndex(s.opts);
  assert.notEqual(fresh.fingerprint, idx.fingerprint);
});

test('ensureIndex still returns the built index when saving fails', () => {
  const s = setup();
  // dataDir is a file: mkdir/write fail
  const bad = path.join(s.root, 'afile');
  fs.writeFileSync(bad, 'x');
  const idx = ensureIndex({ ...s.opts, dataDir: bad });
  assert.equal(idx.version, INDEX_VERSION);
  assert.ok(idx.entries.length > 0);
});

test('index keeps duplicates', () => {
  const s = setup();
  write(path.join(s.home, '.agents', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha skill\n---\n');
  const idx = buildIndex(s.opts);
  assert.equal(idx.entries.filter((e) => e.kind === 'skill' && e.name === 'alpha').length, 2);
});

test('fingerprint is taken before scanning: a change mid-scan leaves the index stale', () => {
  const s = setup();
  const target = path.join(s.home, '.claude', 'skills', 'alpha', 'SKILL.md');
  const orig = fs.openSync;
  let fired = false;
  fs.openSync = function (f, ...rest) {
    if (!fired && String(f) === target) {
      fired = true;
      write(path.join(s.home, '.claude', 'skills', 'late', 'SKILL.md'), '---\nname: late\ndescription: Late\n---\n');
    }
    return orig.call(this, f, ...rest);
  };
  let idx;
  try { idx = buildIndex(s.opts); } finally { fs.openSync = orig; }
  assert.ok(fired);
  assert.equal(isStale(idx, s.opts), true);
});

test('fingerprint changes when a skill SKILL.md is edited', () => {
  const s = setup();
  const f0 = computeFingerprint(s.opts);
  touch(path.join(s.home, '.claude', 'skills', 'alpha', 'SKILL.md'), 300);
  assert.notEqual(computeFingerprint(s.opts), f0);
});

test('changing cwd does not change the fingerprint', () => {
  const s = setup();
  const other = path.join(s.root, 'other');
  fs.mkdirSync(other);
  assert.equal(computeFingerprint({ ...s.opts, cwd: other }), computeFingerprint(s.opts));
  write(path.join(s.cwd, '.claude', 'skills', 'p', 'SKILL.md'), '---\nname: p\ndescription: P\n---\n');
  write(path.join(s.cwd, '.mcp.json'), { mcpServers: { pm: { command: 'node' } } });
  assert.equal(computeFingerprint({ ...s.opts, cwd: other }), computeFingerprint(s.opts));
});

test('buildIndex leaves project entries out; ensureIndex adds them for that cwd only', () => {
  const s = setup();
  write(path.join(s.data, 'config.json'), { trustProjectMcp: true });
  write(path.join(s.cwd, '.claude', 'skills', 'projskill', 'SKILL.md'), '---\nname: projskill\ndescription: Only in A\n---\n');
  write(path.join(s.cwd, '.cursor', 'mcp.json'), { mcpServers: { projmcp: { command: 'node' } } });
  const other = path.join(s.root, 'other');
  fs.mkdirSync(other);
  const built = buildIndex(s.opts);
  assert.ok(!built.entries.some((e) => e.name === 'projskill' || e.name === 'projmcp'));
  const a = ensureIndex(s.opts);
  assert.ok(a.entries.some((e) => e.name === 'projskill' && e.source === 'project'));
  assert.ok(a.entries.some((e) => e.name === 'projmcp'));
  const b = ensureIndex({ ...s.opts, cwd: other });
  assert.ok(!b.entries.some((e) => e.name === 'projskill' || e.name === 'projmcp'));
  assert.ok(!loadIndex(s.data).entries.some((e) => e.name === 'projskill'));
  assert.deepEqual(scanProject(s.opts).map((e) => e.name).sort(), ['projmcp', 'projskill']);
});

test('a project skill never shadows a global one: the project entry becomes the duplicate', () => {
  const s = setup();
  write(path.join(s.cwd, '.claude', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Project alpha\n---\n');
  const idx = ensureIndex(s.opts);
  const alphas = idx.entries.filter((e) => e.kind === 'skill' && e.name === 'alpha');
  assert.equal(alphas.length, 2);
  const proj = alphas.find((e) => e.source === 'project');
  const glob = alphas.find((e) => e.source === 'claude');
  assert.equal(glob.duplicateOf, undefined);
  assert.equal(proj.duplicateOf, glob.id);
  assert.ok(proj.id.endsWith('@project'));
  assert.equal(new Set(idx.entries.map((e) => e.id)).size, idx.entries.length);
});

test('ensureIndex without saved index and allowRebuild:false returns project entries, or null', () => {
  const s = setup();
  assert.equal(ensureIndex(s.opts, { allowRebuild: false }), null);
  write(path.join(s.cwd, '.claude', 'skills', 'p', 'SKILL.md'), '---\nname: p\ndescription: P\n---\n');
  const idx = ensureIndex(s.opts, { allowRebuild: false });
  assert.equal(idx.builtAt, null);
  assert.equal(idx.fingerprint, null);
  assert.deepEqual(idx.entries.map((e) => e.name), ['p']);
});

test('isStale after config.json change and after a library change', () => {
  const s = setup();
  const idx = buildIndex(s.opts);
  write(path.join(s.data, 'config.json'), { hook: false });
  assert.equal(isStale(idx, s.opts), true);
  const idx2 = buildIndex(s.opts);
  assert.equal(isStale(idx2, s.opts), false);
  write(path.join(s.data, 'library', 'col', 'x', 'SKILL.md'), '---\nname: x\ndescription: X\n---\n');
  assert.equal(isStale(idx2, s.opts), true);
});

test('loadIndex returns null when fingerprint or builtAt is missing', () => {
  const s = setup();
  write(path.join(s.data, 'index.json'), { version: INDEX_VERSION, builtAt: 'x', entries: [] });
  assert.equal(loadIndex(s.data), null);
  write(path.join(s.data, 'index.json'), { version: INDEX_VERSION, fingerprint: 'y', entries: [] });
  assert.equal(loadIndex(s.data), null);
});

test('cwd == home: global MCP servers and skills stay in the saved index, fingerprint cwd-independent', () => {
  const s = setup();
  const other = path.join(s.root, 'other');
  fs.mkdirSync(other);
  const o = { ...s.opts, cwd: s.home };
  assert.equal(computeFingerprint(o), computeFingerprint({ ...s.opts, cwd: other }));
  const saved = buildIndex(o);
  const srv = saved.entries.find((e) => e.kind === 'mcp' && e.name === 'srv');
  const alpha = saved.entries.find((e) => e.kind === 'skill' && e.name === 'alpha');
  assert.equal(srv.source, 'claude');
  assert.equal(alpha.source, 'claude');
  const idx = ensureIndex(o);
  assert.equal(idx.entries.find((e) => e.name === 'alpha').source, 'claude');
  assert.equal(idx.entries.filter((e) => e.kind === 'skill' && e.name === 'alpha').length, 1);
  assert.equal(scanProject(o).filter((e) => e.name === 'alpha').length, 0);
});

test('cwd is an ancestor of home: same classification', () => {
  const s = setup();
  const parent = path.dirname(s.home);
  const o = { ...s.opts, cwd: parent };
  assert.equal(computeFingerprint(o), computeFingerprint(s.opts));
  const saved = buildIndex(o);
  assert.ok(saved.entries.some((e) => e.kind === 'mcp' && e.name === 'srv' && e.source === 'claude'));
  assert.ok(saved.entries.some((e) => e.kind === 'skill' && e.name === 'alpha' && e.source === 'claude'));
});

test('ids are unique after merge: two same-name project skills plus a global one', () => {
  const s = setup();
  const md = '---\nname: alpha\ndescription: A\n---\n';
  write(path.join(s.cwd, '.claude', 'skills', 'alpha', 'SKILL.md'), md);
  write(path.join(s.cwd, '.agents', 'skills', 'alpha', 'SKILL.md'), md + 'x');
  const idx = ensureIndex(s.opts);
  assert.equal(idx.entries.filter((e) => e.name === 'alpha').length, 3);
  assert.equal(new Set(idx.entries.map((e) => e.id)).size, idx.entries.length);
});

const mcpNames = (idx) => idx.entries.filter((e) => e.kind === 'mcp').map((e) => e.name).sort();
function projectMcp(s, approval) {
  write(path.join(s.cwd, '.mcp.json'), { mcpServers: { one: { command: 'node' }, two: { command: 'node' } } });
  write(path.join(s.home, '.claude.json'), {
    mcpServers: { srv: { command: 'node' } },
    projects: { [s.cwd]: { mcpServers: { local: { command: 'node' } }, ...approval } },
  });
}

test('unapproved project .mcp.json servers are absent; projects[cwd].mcpServers are trusted', () => {
  const s = setup();
  projectMcp(s, {});
  assert.deepEqual(mcpNames(ensureIndex(s.opts)), ['local', 'srv']);
});

test('approved project .mcp.json servers are present, disabled ones are not', () => {
  const s = setup();
  projectMcp(s, { enabledMcpjsonServers: ['one', 'two'], disabledMcpjsonServers: ['two'] });
  assert.deepEqual(mcpNames(ensureIndex(s.opts)), ['local', 'one', 'srv']);
});

test('enableAllProjectMcpServers includes all', () => {
  const s = setup();
  projectMcp(s, { enableAllProjectMcpServers: true });
  assert.deepEqual(mcpNames(ensureIndex(s.opts)), ['local', 'one', 'srv', 'two']);
});

test('project .cursor/mcp.json servers are excluded unless config.trustProjectMcp is true', () => {
  const s = setup();
  write(path.join(s.cwd, '.cursor', 'mcp.json'), { mcpServers: { cur: { command: 'node' } } });
  assert.ok(!ensureIndex(s.opts).entries.some((x) => x.name === 'cur'));
  write(path.join(s.data, 'config.json'), { trustProjectMcp: true });
  const e = ensureIndex(s.opts).entries.find((x) => x.name === 'cur');
  assert.equal(e.source, 'project');
});

test('no orphan duplicateOf: unapproved .mcp.json server removed before deduplication', () => {
  const s = setup();
  write(path.join(s.data, 'config.json'), { trustProjectMcp: true });
  write(path.join(s.cwd, '.mcp.json'), { mcpServers: { secretdup: { command: 'node' } } });
  write(path.join(s.cwd, '.cursor', 'mcp.json'), { mcpServers: { secretdup: { command: 'node' } } });
  const idx = ensureIndex(s.opts);
  const ids = new Set(idx.entries.map((e) => e.id));
  for (const e of idx.entries) if (e.duplicateOf) assert.ok(ids.has(e.duplicateOf), `${e.id} -> ${e.duplicateOf}`);
  const d = idx.entries.filter((e) => e.name === 'secretdup');
  assert.equal(d.length, 1);
  assert.equal(d[0].id, 'mcp:secretdup');
  // now with the name unapproved only in .mcp.json and no cursor file: nothing leaks
  fs.rmSync(path.join(s.cwd, '.cursor'), { recursive: true });
  write(path.join(s.cwd, '.mcp.json'), { mcpServers: { leaky: { command: 'node' } } });
  assert.ok(!JSON.stringify(ensureIndex(s.opts)).includes('leaky'));
});

test('shadowing compares names case-insensitively', () => {
  const s = setup();
  write(path.join(s.cwd, '.claude', 'skills', 'Alpha', 'SKILL.md'), '---\nname: Alpha\ndescription: P\n---\n');
  const idx = ensureIndex(s.opts);
  const proj = idx.entries.find((e) => e.name === 'Alpha');
  const glob = idx.entries.find((e) => e.name === 'alpha');
  assert.equal(proj.duplicateOf, glob.id);
  assert.equal(glob.duplicateOf, undefined);
});

test('a global MCP server with the same name stays primary over a project one', () => {
  const s = setup();
  write(path.join(s.data, 'config.json'), { trustProjectMcp: true });
  write(path.join(s.cwd, '.cursor', 'mcp.json'), { mcpServers: { srv: { command: 'evil' } } });
  const srvs = ensureIndex(s.opts).entries.filter((e) => e.kind === 'mcp' && e.name === 'srv');
  assert.equal(srvs.length, 2);
  assert.equal(srvs.find((e) => e.source === 'claude').duplicateOf, undefined);
  assert.equal(srvs.find((e) => e.source === 'project').duplicateOf, 'mcp:srv');
});

test('an index written before skill names were validated (version 1) is not loaded', () => {
  const s = setup();
  write(path.join(s.data, 'index.json'), { version: 1, builtAt: new Date().toISOString(), fingerprint: 'y', entries: [] });
  assert.equal(loadIndex(s.data), null);
  assert.equal(INDEX_VERSION, 2);
});
