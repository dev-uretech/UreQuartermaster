import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCollection, syncCollections } from '../skills/urequartermaster/scripts/lib/library/collections.mjs';
import { park } from '../skills/urequartermaster/scripts/lib/library/park.mjs';
import { unpark } from '../skills/urequartermaster/scripts/lib/library/unpark.mjs';
import { parkPlugin } from '../skills/urequartermaster/scripts/lib/library/plugin.mjs';
import { deriveName, validateSource } from '../skills/urequartermaster/scripts/lib/library/names.mjs';
import { dirLinkArgs, dirLinkAttempts } from '../skills/urequartermaster/scripts/lib/library/move.mjs';
import { envGet, findExe } from '../skills/urequartermaster/scripts/lib/core/which.mjs';
import { loadState } from '../skills/urequartermaster/scripts/lib/core/config.mjs';

const QM = fileURLToPath(new URL('../skills/urequartermaster/scripts/qm.mjs', import.meta.url));
const HAS_GIT = spawnSync('git', ['--version']).status === 0;
const gitTest = (name, a, b) => {
  const o = typeof a === 'function' ? {} : a;
  const fn = typeof a === 'function' ? a : b;
  test(name, { ...o, skip: o.skip || (!HAS_GIT && 'git not available') }, fn);
};
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const skillMd = (n, d = 'does things') => `---\nname: ${n}\ndescription: ${d}\n---\n# ${n}\n`;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-lib-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const cwd = path.join(root, 'cwd');
  for (const d of [home, data, cwd]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, UREQM_HOME: data, UREQM_NO_UPDATE: '1' };
  delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
  return { root, home, data, cwd, env, opts: { home, env, cwd, dataDir: data } };
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function makeRepo(root, name = 'upstream') {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  write(path.join(dir, 'skills', 'alpha', 'SKILL.md'), skillMd('alpha', 'Alpha skill'));
  write(path.join(dir, 'skills', 'beta', 'SKILL.md'), skillMd('beta', 'Beta skill'));
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const canSymlink = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-sl-'));
  try { fs.symlinkSync(d, path.join(d, 'l'), 'dir'); return true; } catch { return false; } finally { fs.rmSync(d, { recursive: true, force: true }); }
})();

test('deriveName: last segment without .git, lowercased', () => {
  assert.equal(deriveName('https://github.com/Acme/Skill-Pack.git'), 'skill-pack');
  assert.equal(deriveName('https://github.com/acme/tools/'), 'tools');
  assert.equal(deriveName('git@github.com:acme/my.skills.git'), 'my.skills');
  assert.equal(deriveName('ssh://git@host.example/a/b/c'), 'c');
  assert.equal(deriveName(path.join(path.sep, 'tmp', 'x', 'Repo')), 'repo');
});

test('validateSource accepts the allowed forms', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-v-'));
  for (const ok of ['https://github.com/a/b.git', 'ssh://git@host.example/a/b', 'git@github.com:a/b.git', d]) {
    assert.doesNotThrow(() => validateSource(ok), ok);
  }
});

test('validateSource refuses everything else before git runs', () => {
  const bad = ['--upload-pack=x', '-x', 'ext::sh -c x', 'https://host/a b', 'http://host/a/b', 'file:///tmp/x', 'ftp://h/a',
    'git://host/a/b', 'https://host/a\nb', 'git@host:a b', 'relative/dir', '', 'https://-evil/a', '/no/such/dir/anywhere', 'x\u0000y', 'git@-h:a'];
  for (const b of bad) assert.throws(() => validateSource(b), /./, JSON.stringify(b));
});

test('addCollection refuses a bad URL without touching the library', () => {
  const s = setup();
  assert.throws(() => addCollection('ext::sh -c touch pwned', s.opts), /not accepted|Unsupported|refus/i);
  assert.equal(fs.existsSync(path.join(s.data, 'library')), false);
  assert.equal(fs.existsSync('pwned'), false);
});

gitTest('addCollection clones a local repo into library/<name> and reindexes', () => {
  const s = setup();
  const repo = makeRepo(s.root, 'My-Pack');
  const r = addCollection(repo, s.opts);
  assert.equal(r.name, 'my-pack');
  assert.equal(r.path, path.join(s.data, 'library', 'my-pack'));
  assert.equal(r.skills, 2);
  assert.ok(fs.existsSync(path.join(r.path, '.git')));
  const idx = JSON.parse(fs.readFileSync(path.join(s.data, 'index.json'), 'utf8'));
  const a = idx.entries.find((e) => e.name === 'alpha');
  assert.equal(a.source, 'library:my-pack');
  assert.equal(a.state, 'library');
  assert.deepEqual(fs.readdirSync(path.join(s.data, 'library')).filter((n) => n.startsWith('.')), []);
});

gitTest('addCollection honours --name and validates it', () => {
  const s = setup();
  const repo = makeRepo(s.root);
  assert.equal(addCollection(repo, { ...s.opts, name: 'Custom' }).name, 'custom');
  for (const bad of ['../x', '.hidden', '_parked', 'a b', 'x'.repeat(65), '']) {
    assert.throws(() => addCollection(repo, { ...s.opts, name: bad }), /name/i, bad);
  }
});

gitTest('addCollection refuses an existing destination', () => {
  const s = setup();
  const repo = makeRepo(s.root);
  addCollection(repo, { ...s.opts, name: 'dup' });
  assert.throws(() => addCollection(repo, { ...s.opts, name: 'dup' }), /exists.*qm sync|qm sync/);
});

gitTest('addCollection failure leaves no temp dir behind', () => {
  const s = setup();
  const notRepo = path.join(s.root, 'plain');
  fs.mkdirSync(notRepo);
  assert.throws(() => addCollection(notRepo, s.opts), /git clone failed/);
  const lib = path.join(s.data, 'library');
  assert.deepEqual(fs.existsSync(lib) ? fs.readdirSync(lib) : [], []);
});

gitTest('symlinks in the cloned repo are not created as symlinks', { skip: !canSymlink && 'no symlink support' }, () => {
  const s = setup();
  const repo = makeRepo(s.root);
  fs.symlinkSync('/etc', path.join(repo, 'skills', 'evil-link'));
  fs.symlinkSync('../../../outside', path.join(repo, 'skills', 'alpha', 'out'));
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'links');
  const r = addCollection(repo, s.opts);
  for (const rel of [['skills', 'evil-link'], ['skills', 'alpha', 'out']]) {
    const st = fs.lstatSync(path.join(r.path, ...rel));
    assert.equal(st.isSymbolicLink(), false);
    assert.equal(st.isFile(), true);
  }
});

gitTest('syncCollections pulls new commits, skips _parked, symlinked and non-git collections', () => {
  const s = setup();
  const repo = makeRepo(s.root);
  addCollection(repo, { ...s.opts, name: 'pack' });
  write(path.join(repo, 'skills', 'gamma', 'SKILL.md'), skillMd('gamma', 'Gamma skill'));
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'more');
  const lib = path.join(s.data, 'library');
  fs.mkdirSync(path.join(lib, '_parked', 'x'), { recursive: true });
  fs.mkdirSync(path.join(lib, 'plain-dir'));
  if (canSymlink) fs.symlinkSync(path.join(s.root, 'upstream'), path.join(lib, 'linked'), 'dir');
  const res = syncCollections(s.opts);
  assert.deepEqual(res.map((r) => r.name), ['pack']);
  assert.equal(res[0].updated, true);
  assert.equal(res[0].error, undefined);
  assert.ok(fs.existsSync(path.join(lib, 'pack', 'skills', 'gamma', 'SKILL.md')));
  const idx = JSON.parse(fs.readFileSync(path.join(s.data, 'index.json'), 'utf8'));
  assert.ok(idx.entries.some((e) => e.name === 'gamma'));
  // Nothing new upstream: not updated.
  assert.equal(syncCollections(s.opts)[0].updated, false);
});

gitTest('syncCollections reports an error per collection and keeps going', () => {
  const s = setup();
  const repo = makeRepo(s.root);
  addCollection(repo, { ...s.opts, name: 'aaa' });
  addCollection(repo, { ...s.opts, name: 'bbb' });
  fs.rmSync(repo, { recursive: true, force: true });
  const res = syncCollections(s.opts);
  assert.equal(res.length, 2);
  assert.ok(res.every((r) => r.updated === false && typeof r.error === 'string'));
});

function userSkill(s, name, dirName = name) {
  const dir = path.join(s.home, '.claude', 'skills', dirName);
  write(path.join(dir, 'SKILL.md'), skillMd(name, `The ${name} skill`));
  write(path.join(dir, 'extra', 'note.txt'), 'hello');
  return dir;
}

test('park / unpark round trip for a plain directory', () => {
  const s = setup();
  const dir = userSkill(s, 'seo-audit');
  const r = park('seo-audit', s.opts);
  assert.equal(r.from, dir);
  assert.equal(r.to, path.join(s.data, 'library', '_parked', 'seo-audit'));
  assert.equal(fs.existsSync(dir), false);
  assert.ok(fs.existsSync(path.join(r.to, 'extra', 'note.txt')));
  const st = loadState(s.data);
  assert.equal(st.parked.length, 1);
  assert.equal(st.parked[0].name, 'seo-audit');
  const idx = JSON.parse(fs.readFileSync(path.join(s.data, 'index.json'), 'utf8'));
  assert.equal(idx.entries.find((e) => e.name === 'seo-audit').source, 'library:_parked');
  assert.throws(() => park('seo-audit', s.opts), /already in the library/);

  const u = unpark('seo-audit', s.opts);
  assert.equal(u.to, dir);
  assert.equal(fs.readFileSync(path.join(dir, 'extra', 'note.txt'), 'utf8'), 'hello');
  assert.equal(fs.existsSync(r.to), false);
  assert.deepEqual(loadState(s.data).parked, []);
  const idx2 = JSON.parse(fs.readFileSync(path.join(s.data, 'index.json'), 'utf8'));
  assert.equal(idx2.entries.find((e) => e.name === 'seo-audit').source, 'claude');
});

test('park refuses when the destination exists; unpark refuses when the origin is taken', () => {
  const s = setup();
  const dir = userSkill(s, 'one');
  write(path.join(s.data, 'library', '_parked', 'one', 'SKILL.md'), skillMd('one'));
  assert.throws(() => park('one', s.opts), /exists/);
  assert.ok(fs.existsSync(dir));
  fs.rmSync(path.join(s.data, 'library', '_parked', 'one'), { recursive: true });
  park('one', s.opts);
  write(path.join(dir, 'SKILL.md'), skillMd('one'));
  assert.throws(() => unpark('one', s.opts), /exists/);
  assert.equal(loadState(s.data).parked.length, 1);
});

test('park refuses an unknown skill and unpark an unknown name', () => {
  const s = setup();
  assert.throws(() => park('nope', s.opts), /No installed skill/);
  assert.throws(() => unpark('nope', s.opts), /not parked/i);
});

test('park of a plugin skill is refused with the hint', () => {
  const s = setup();
  const inst = path.join(s.home, '.claude', 'plugins', 'cache', 'mkt', 'tools', '1.0.0');
  write(path.join(inst, 'skills', 'fmt', 'SKILL.md'), skillMd('fmt'));
  write(path.join(s.home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'tools@mkt': [{ scope: 'user', installPath: inst, version: '1.0.0' }] } }));
  write(path.join(s.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'tools@mkt': true } }));
  assert.throws(() => park('tools:fmt', s.opts), /qm park --plugin tools/);
  assert.throws(() => park('fmt', s.opts), /qm park --plugin tools/);
  assert.ok(fs.existsSync(path.join(inst, 'skills', 'fmt', 'SKILL.md')));
});

test('park refuses library and project skills', () => {
  const s = setup();
  write(path.join(s.data, 'library', 'col', 'lib-skill', 'SKILL.md'), skillMd('lib-skill'));
  assert.throws(() => park('lib-skill', s.opts), /library/i);
  write(path.join(s.cwd, '.claude', 'skills', 'proj-skill', 'SKILL.md'), skillMd('proj-skill'));
  assert.throws(() => park('proj-skill', s.opts), /No installed skill|project/i);
  assert.ok(fs.existsSync(path.join(s.cwd, '.claude', 'skills', 'proj-skill', 'SKILL.md')));
});

test('park refuses a skill name that is not a safe folder name', () => {
  const s = setup();
  write(path.join(s.home, '.claude', 'skills', 'folder', 'SKILL.md'), skillMd('../escape'));
  assert.throws(() => park('../escape', s.opts), /not a safe|name/i);
  assert.ok(fs.existsSync(path.join(s.home, '.claude', 'skills', 'folder')));
});

test('park / unpark of the skills-CLI symlink layout restores link and lock byte-identical', { skip: !canSymlink && 'no symlink support' }, () => {
  const s = setup();
  const real = path.join(s.home, '.agents', 'skills', 'pdf-tools');
  write(path.join(real, 'SKILL.md'), skillMd('pdf-tools'));
  const link = path.join(s.home, '.claude', 'skills', 'pdf-tools');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const target = path.join('..', '..', '.agents', 'skills', 'pdf-tools');
  fs.symlinkSync(target, link, 'dir');
  const lockFile = path.join(s.home, '.agents', '.skill-lock.json');
  const lock = { version: 3, skills: { 'a-first': { source: 'x/y', hash: '1' }, 'pdf-tools': { source: 'acme/pdf', hash: 'abc', nested: { k: [1, 2] } }, 'z-last': { source: 'q/r' } }, dismissed: { tip: true } };
  const original = `${JSON.stringify(lock, null, 2)}\n`;
  fs.writeFileSync(lockFile, original);

  const r = park('pdf-tools', s.opts);
  assert.equal(r.to, path.join(s.data, 'library', '_parked', 'pdf-tools'));
  assert.equal(fs.existsSync(real), false);
  assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined);
  assert.ok(fs.existsSync(path.join(r.to, 'SKILL.md')));
  const afterPark = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.deepEqual(Object.keys(afterPark.skills), ['a-first', 'z-last']);
  assert.deepEqual(afterPark.dismissed, { tip: true });
  const st = loadState(s.data);
  assert.deepEqual(st.parked[0].lockEntry, lock.skills['pdf-tools']);

  unpark('pdf-tools', s.opts);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), original);
  assert.ok(fs.existsSync(path.join(real, 'SKILL.md')));
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), target);
  assert.deepEqual(loadState(s.data).parked, []);
});

test('park leaves a corrupt lock file untouched', () => {
  const s = setup();
  userSkill(s, 'seo-audit');
  const lockFile = path.join(s.home, '.agents', '.skill-lock.json');
  write(lockFile, '{ not json');
  park('seo-audit', s.opts);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), '{ not json');
});

test('parkPlugin without --yes only returns the command', () => {
  const s = setup();
  const inst = path.join(s.home, '.claude', 'plugins', 'cache', 'mkt', 'tools', '1.0.0');
  write(path.join(inst, 'skills', 'fmt', 'SKILL.md'), skillMd('fmt'));
  write(path.join(s.home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'tools@mkt': [{ scope: 'user', installPath: inst, version: '1.0.0' }] } }));
  const marker = path.join(s.root, 'ran');
  const bin = path.join(s.root, 'bin');
  write(path.join(bin, 'claude'), `#!/bin/sh\necho "$@" > "${marker}"\n`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const opts = { ...s.opts, env: { ...s.env, PATH: `${bin}${path.delimiter}${s.env.PATH}` } };
  const r = parkPlugin('tools', opts);
  assert.equal(r.command, 'claude plugin disable tools@mkt');
  assert.equal(r.ran, false);
  assert.equal(fs.existsSync(marker), false);
  assert.throws(() => parkPlugin('missing', opts), /not installed|No plugin/i);
  assert.throws(() => parkPlugin('tools', { ...opts, agent: 'codex' }), /claude/i);
  if (process.platform !== 'win32') {
    const y = parkPlugin('tools', { ...opts, yes: true });
    assert.equal(y.ok, true);
    assert.equal(y.ran, true);
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'plugin disable tools@mkt');
  }
});

test('CLI: bad URL exits 2, park --plugin prints the command, usage lists the commands', () => {
  const s = setup();
  const run = (...a) => spawnSync(process.execPath, [QM, ...a], { env: s.env, cwd: s.cwd, encoding: 'utf8' });
  const bad = run('add', '--upload-pack=x');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /not accepted|Unknown option/);
  assert.equal(run('add').status, 2);
  assert.equal(run('park').status, 2);
  const miss = run('park', '--plugin', 'nope');
  assert.equal(miss.status, 1);
  assert.match(run('help').stdout, /qm add <url>/);
  const sync = run('sync');
  assert.equal(sync.status, 0);
  const none = run('park', 'nothing-here');
  assert.equal(none.status, 1);
});

gitTest('CLI: add, sync, park, unpark end to end', () => {
  const s = setup();
  const run = (...a) => spawnSync(process.execPath, [QM, ...a], { env: s.env, cwd: s.cwd, encoding: 'utf8' });
  const repo = makeRepo(s.root, 'pack');
  const a = run('add', repo);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /Added "pack": 2 skills/);
  assert.match(run('sync').stdout, /pack: up to date/);
  userSkill(s, 'seo-audit');
  assert.match(run('park', 'seo-audit').stdout, /Parked "seo-audit"/);
  assert.match(run('unpark', 'seo-audit').stdout, /Restored "seo-audit"/);
});

// ---------------------------------------------------------------- moving folders, interrupted moves, validation
import { moveDir } from '../skills/urequartermaster/scripts/lib/library/move.mjs';
import { buildIndex } from '../skills/urequartermaster/scripts/lib/index/index.mjs';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
// Deletes the files named in `gone` (relative to the folder) and then fails, like a partial rmdir.
const failRemoveWith = (gone) => (dir) => {
  for (const g of gone) fs.rmSync(path.join(dir, g), { force: true });
  throw Object.assign(new Error('denied'), { code: 'EACCES' });
};
const failRemove = failRemoveWith(['extra/note.txt']);
const exdev = () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
// Every path below d, relative to it (readdirSync's `recursive` needs Node 20.1; CI also runs Node 18).
const fileTree = (d, rel = '') => fs.readdirSync(path.join(d, rel), { withFileTypes: true })
  .flatMap((e) => { const p = rel ? `${rel}/${e.name}` : e.name; return e.isDirectory() ? [p, ...fileTree(d, p)] : [p]; }).sort();

test('moveDir: a non-EXDEV rename error fails and leaves the source untouched', () => {
  const s = setup();
  const src = path.join(s.root, 'a'); write(path.join(src, 'f.txt'), 'x');
  const dst = path.join(s.root, 'b');
  assert.throws(() => moveDir(src, dst, { rename: () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); } }), /nope/);
  assert.ok(fs.existsSync(path.join(src, 'f.txt')));
  assert.equal(fs.existsSync(dst), false);
});

test('moveDir: EXDEV falls back to copy, verify and delete', () => {
  const s = setup();
  const src = path.join(s.root, 'a'); write(path.join(src, 'f.txt'), 'x'); write(path.join(src, 'd', 'g.txt'), 'yy');
  const dst = path.join(s.root, 'b');
  moveDir(src, dst, { rename: exdev });
  assert.equal(fs.existsSync(src), false);
  assert.deepEqual(fileTree(dst), ['d', 'd/g.txt', 'f.txt']);
});

test('park under a read-only skills folder fails cleanly: source intact, no state record', { skip: (process.platform === 'win32' || isRoot) && 'needs POSIX permissions and non-root' }, () => {
  const s = setup();
  const dir = userSkill(s, 'seo-audit');
  const parent = path.dirname(dir);
  fs.chmodSync(parent, 0o555);
  try {
    assert.throws(() => park('seo-audit', s.opts), /EACCES|EPERM|permission/i);
  } finally { fs.chmodSync(parent, 0o755); }
  assert.ok(fs.existsSync(path.join(dir, 'extra', 'note.txt')));
  assert.deepEqual(loadState(s.data).parked, []);
  assert.equal(fs.existsSync(path.join(s.data, 'library', '_parked', 'seo-audit')), false);
});

test('park: copy done but source not removable keeps a record and unpark restores', () => {
  const s = setup();
  const dir = userSkill(s, 'seo-audit');
  const failing = { ...s.opts, _deps: { rename: exdev, remove: failRemove } };
  assert.throws(() => park('seo-audit', failing), /could not be removed.*qm unpark seo-audit/s);
  const st = loadState(s.data);
  assert.equal(st.parked.length, 1);
  assert.equal(st.parked[0].interrupted, 'park');
  assert.ok(fs.existsSync(dir));
  assert.ok(fs.existsSync(path.join(s.data, 'library', '_parked', 'seo-audit', 'SKILL.md')));
  const u = unpark('seo-audit', s.opts);
  assert.equal(u.to, dir);
  assert.equal(fs.readFileSync(path.join(dir, 'extra', 'note.txt'), 'utf8'), 'hello');
  assert.equal(fs.existsSync(path.join(s.data, 'library', '_parked', 'seo-audit')), false);
  assert.deepEqual(loadState(s.data).parked, []);
});

test('unpark: parked copy not removable keeps the record; a second unpark finishes', () => {
  const s = setup();
  const dir = userSkill(s, 'seo-audit');
  park('seo-audit', s.opts);
  const failing = { ...s.opts, _deps: { rename: exdev, remove: failRemove } };
  assert.throws(() => unpark('seo-audit', failing), /could not be removed/);
  assert.equal(loadState(s.data).parked.length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')));
  unpark('seo-audit', s.opts);
  assert.deepEqual(loadState(s.data).parked, []);
  assert.equal(fs.readFileSync(path.join(dir, 'extra', 'note.txt'), 'utf8'), 'hello');
  assert.equal(fs.existsSync(path.join(s.data, 'library', '_parked', 'seo-audit')), false);
});

gitTest('qm sync does not run a core.fsmonitor planted in a collection', { skip: process.platform === 'win32' && 'POSIX shell script' }, () => {
  const s = setup();
  const repo = makeRepo(s.root);
  addCollection(repo, { ...s.opts, name: 'pack' });
  const marker = path.join(s.root, 'fsmonitor-ran');
  const hook = path.join(s.root, 'fsm.sh');
  write(hook, `#!/bin/sh\ntouch "${marker}"\n`);
  fs.chmodSync(hook, 0o755);
  const cfg = path.join(s.data, 'library', 'pack', '.git', 'config');
  fs.appendFileSync(cfg, `\n[core]\n\tfsmonitor = ${hook}\n`);
  write(path.join(repo, 'skills', 'delta', 'SKILL.md'), skillMd('delta'));
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'more');
  const res = syncCollections(s.opts);
  assert.equal(res[0].updated, true, res[0].error);
  assert.equal(fs.existsSync(marker), false);
});

test('library scan skips .tmp and _internal folders but keeps _parked', () => {
  const s = setup();
  write(path.join(s.data, 'library', '.tmp-x-1', 'a', 'SKILL.md'), skillMd('tmp-skill'));
  write(path.join(s.data, 'library', '_other', 'b', 'SKILL.md'), skillMd('other-skill'));
  write(path.join(s.data, 'library', '_parked', 'p', 'SKILL.md'), skillMd('parked-skill'));
  write(path.join(s.data, 'library', 'col', 'c', 'SKILL.md'), skillMd('col-skill'));
  const names = buildIndex(s.opts).entries.filter((e) => e.kind === 'skill').map((e) => e.name).sort();
  assert.deepEqual(names, ['col-skill', 'parked-skill']);
});

gitTest('addCollection deletes .tmp folders older than an hour and keeps fresh ones', () => {
  const s = setup();
  const lib = path.join(s.data, 'library');
  write(path.join(lib, '.tmp-old-1', 'f'), 'x');
  write(path.join(lib, '.tmp-new-2', 'f'), 'x');
  const old = new Date(Date.now() - 2 * 3600_000);
  fs.utimesSync(path.join(lib, '.tmp-old-1'), old, old);
  addCollection(makeRepo(s.root), s.opts);
  assert.equal(fs.existsSync(path.join(lib, '.tmp-old-1')), false);
  assert.equal(fs.existsSync(path.join(lib, '.tmp-new-2')), true);
});

test('validateSource: leading dashes, shell metacharacters, bidi and control characters', () => {
  for (const b of ['ssh://-oProxyCommand=x@host/y', 'https://-oX@host/y', 'git@host:-x', 'ssh://git@host/a;b', 'https://host/a|b',
    'https://host/a&b', 'https://host/a$(x)', 'https://host/a`x`', 'https://host/a<b', 'https://host/a"b', "https://host/a'b",
    'https://host/a\\b', 'https://host/a‮b', 'https://host/a\u0007b', 'git@host:a‮b']) {
    assert.throws(() => validateSource(b), /not accepted/, JSON.stringify(b));
  }
  assert.doesNotThrow(() => validateSource('https://user@host.example:8443/a/b-c.git'));
});

test('Windows-reserved and unsafe names are refused', () => {
  const s = setup();
  for (const n of ['con', 'NUL', 'com1', 'lpt9', 'aux', 'prn', 'con.txt']) {
    assert.throws(() => addCollection(path.join(s.root), { ...s.opts, name: n }), /name/i, n);
  }
  for (const n of ['nul', 'COM3.md']) {
    write(path.join(s.home, '.claude', 'skills', 'f', 'SKILL.md'), skillMd(n));
    assert.throws(() => park(n, s.opts), /not a safe/, n);
  }
  // Names with shell or path characters never get into the index: the folder name is used instead.
  for (const n of ['a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b']) {
    write(path.join(s.home, '.claude', 'skills', 'f', 'SKILL.md'), skillMd(n));
    assert.throws(() => park(n, s.opts), /No installed skill/, n);
  }
  assert.ok(fs.existsSync(path.join(s.home, '.claude', 'skills', 'f')));
});

test('the skills CLI lock is touched only for a folder directly in ~/.agents/skills', () => {
  const s = setup();
  write(path.join(s.home, '.codex', 'skills', 'foo', 'SKILL.md'), skillMd('foo-codex'));
  write(path.join(s.home, '.agents', 'skills', 'foo', 'SKILL.md'), skillMd('foo'));
  const lockFile = path.join(s.home, '.agents', '.skill-lock.json');
  const original = `${JSON.stringify({ version: 3, skills: { foo: { source: 'a/b' } } }, null, 2)}\n`;
  fs.writeFileSync(lockFile, original);
  park('foo-codex', s.opts);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), original);
  assert.deepEqual(loadState(s.data).parked[0].lockEntry, undefined);
  assert.ok(fs.existsSync(path.join(s.home, '.agents', 'skills', 'foo', 'SKILL.md')));
});

test('parkPlugin: refuses a key starting with -, adds --scope for non-user installs', () => {
  const s = setup();
  const reg = (plugins) => write(path.join(s.home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
  const inst = path.join(s.home, 'inst');
  fs.mkdirSync(inst, { recursive: true });
  reg({ '-evil@m': [{ scope: 'user', installPath: inst }], 'proj@m': [{ scope: 'project', installPath: inst }], 'usr@m': [{ scope: 'user', installPath: inst }, { scope: 'project', installPath: inst }] });
  assert.throws(() => parkPlugin('-evil', s.opts), /unexpected characters/);
  assert.equal(parkPlugin('proj', s.opts).command, 'claude plugin disable proj@m --scope project');
  assert.equal(parkPlugin('usr', s.opts).command, 'claude plugin disable usr@m');
});

test('interrupted unpark: a second unpark keeps the user edit and removes the parked leftover', () => {
  const s = setup();
  const dir = userSkill(s, 'seo-audit');
  const parked = path.join(s.data, 'library', '_parked', 'seo-audit');
  park('seo-audit', s.opts);
  assert.throws(() => unpark('seo-audit', { ...s.opts, _deps: { rename: exdev, remove: failRemove } }), /could not be removed/);
  assert.equal(loadState(s.data).parked[0].interrupted, 'unpark');
  assert.ok(fs.existsSync(path.join(parked, 'SKILL.md')) && !fs.existsSync(path.join(parked, 'extra', 'note.txt')));
  fs.writeFileSync(path.join(dir, 'extra', 'note.txt'), 'HELLO'); // same size as "hello"
  unpark('seo-audit', s.opts);
  assert.equal(fs.readFileSync(path.join(dir, 'extra', 'note.txt'), 'utf8'), 'HELLO');
  assert.equal(fs.existsSync(parked), false);
  assert.deepEqual(loadState(s.data).parked, []);
});

test('interrupted unpark: a leftover that differs from the live copy is kept and reported', () => {
  const s = setup();
  const dir = userSkill(s, 'seo-audit');
  const parked = path.join(s.data, 'library', '_parked', 'seo-audit');
  park('seo-audit', s.opts);
  assert.throws(() => unpark('seo-audit', { ...s.opts, _deps: { rename: exdev, remove: failRemove } }), /could not be removed/);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd('seo-audit', 'The seo-audit skill, edited by the user'));
  assert.throws(() => unpark('seo-audit', s.opts), /Both copies were kept/);
  assert.ok(fs.existsSync(path.join(parked, 'SKILL.md')));
  assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /edited by the user/);
  assert.equal(loadState(s.data).parked.length, 1);
});

test('interrupted unpark restores the skills-CLI link and lock on the second run', { skip: !canSymlink && 'no symlink support' }, () => {
  const s = setup();
  const real = path.join(s.home, '.agents', 'skills', 'pdf-tools');
  write(path.join(real, 'SKILL.md'), skillMd('pdf-tools'));
  write(path.join(real, 'x.txt'), 'x');
  const link = path.join(s.home, '.claude', 'skills', 'pdf-tools');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join('..', '..', '.agents', 'skills', 'pdf-tools'), link, 'dir');
  const lockFile = path.join(s.home, '.agents', '.skill-lock.json');
  const original = `${JSON.stringify({ version: 3, skills: { 'pdf-tools': { source: 'a/b' } } }, null, 2)}\n`;
  fs.writeFileSync(lockFile, original);
  park('pdf-tools', s.opts);
  assert.throws(() => unpark('pdf-tools', { ...s.opts, _deps: { rename: exdev, remove: failRemoveWith(['x.txt']) } }), /could not be removed/);
  unpark('pdf-tools', s.opts);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), original);
  assert.deepEqual(loadState(s.data).parked, []);
});

function crashedPark(s) {
  const dir = userSkill(s, 'seo-audit');
  const dest = path.join(s.data, 'library', '_parked', 'seo-audit');
  write(path.join(dest, 'SKILL.md'), skillMd('seo-audit', 'The seo-audit skill')); // partial copy
  fs.mkdirSync(s.data, { recursive: true });
  fs.writeFileSync(path.join(s.data, 'state.json'), JSON.stringify({ parked: [{ name: 'seo-audit', from: dir, to: dest, links: [], pending: true }] }));
  return { dir, dest };
}

test('a pending record with a partial parked copy: unpark drops the copy, the source stays whole', () => {
  const s = setup();
  const { dir, dest } = crashedPark(s);
  unpark('seo-audit', s.opts);
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.readFileSync(path.join(dir, 'extra', 'note.txt'), 'utf8'), 'hello');
  assert.deepEqual(loadState(s.data).parked, []);
});

test('a pending record with a partial parked copy: park starts over and completes', () => {
  const s = setup();
  const { dir, dest } = crashedPark(s);
  const r = park('seo-audit', s.opts);
  assert.equal(r.to, dest);
  assert.equal(fs.existsSync(dir), false);
  assert.ok(fs.existsSync(path.join(dest, 'extra', 'note.txt')));
  const st = loadState(s.data).parked;
  assert.equal(st.length, 1);
  assert.equal(st[0].pending, undefined);
});

// An executable named claude in <root>/bin (and claude.exe for Windows lookups); returns opts with PATH set.
function withClaude(s, body = '#!/bin/sh\nexit 0\n') {
  const bin = path.join(s.root, 'bin');
  for (const n of ['claude', 'claude.exe']) { write(path.join(bin, n), body); fs.chmodSync(path.join(bin, n), 0o755); }
  return { ...s.opts, env: { ...s.env, PATH: bin } };
}

test('parkPlugin: a spawn that cannot start claude gives ran false with the command', () => {
  const s = setup();
  const inst = path.join(s.home, 'inst'); fs.mkdirSync(inst, { recursive: true });
  write(path.join(s.home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'a@m': [{ scope: 'user', installPath: inst }] } }));
  for (const code of ['ENOENT', 'EINVAL']) {
    const spawn = () => ({ error: Object.assign(new Error('x'), { code }) });
    const r = parkPlugin('a', { ...withClaude(s), yes: true, _deps: { spawn } });
    assert.equal(r.ran, false);
    assert.equal(r.ok, false);
    assert.equal(r.command, 'claude plugin disable a@m');
  }
});

test('CLI: park --plugin --yes without claude on PATH prints "Run this yourself"', () => {
  const s = setup();
  const inst = path.join(s.home, 'inst'); fs.mkdirSync(inst, { recursive: true });
  write(path.join(s.home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'a@m': [{ scope: 'user', installPath: inst }] } }));
  const env = { ...s.env, PATH: path.join(s.root, 'nobin') };
  const r = spawnSync(process.execPath, [QM, 'park', '--plugin', 'a', '--yes'], { env, cwd: s.cwd, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Run this yourself: claude plugin disable a@m/);
});

test('parkPlugin: project scope runs in projectPath, refuses to run without one', () => {
  const s = setup();
  const inst = path.join(s.home, 'inst'); fs.mkdirSync(inst, { recursive: true });
  const proj = path.join(s.root, 'proj'); fs.mkdirSync(proj);
  write(path.join(s.home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'p@m': [{ scope: 'project', installPath: inst, projectPath: proj }],
    'q@m': [{ scope: 'local', installPath: inst }],
  } }));
  const base = withClaude(s);
  const claudePath = path.join(s.root, 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  const calls = [];
  const spawn = (bin, args, o) => { calls.push({ bin, args, cwd: o.cwd, shell: o.shell }); return { status: 0 }; };
  const dry = parkPlugin('p', base);
  assert.equal(dry.cwd, proj);
  const ok = parkPlugin('p', { ...base, yes: true, _deps: { spawn } });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls, [{ bin: claudePath, args: ['plugin', 'disable', 'p@m', '--scope', 'project'], cwd: proj, shell: false }]);
  const no = parkPlugin('q', { ...base, yes: true, _deps: { spawn } });
  assert.equal(no.ran, false);
  assert.match(no.error, /projectPath/);
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------- crash recovery, forget, PATH resolution of claude and git
const interruptedPark = (s) => {
  const dir = userSkill(s, 'seo-audit');
  const parked = path.join(s.data, 'library', '_parked', 'seo-audit');
  assert.throws(() => park('seo-audit', { ...s.opts, _deps: { rename: exdev, remove: failRemove } }), /could not be removed/);
  return { dir, parked };
};

test('after an interrupted park and an edit of the source, unpark and park say both copies were kept', () => {
  const s = setup();
  const { dir, parked } = interruptedPark(s);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd('seo-audit', 'edited by the user'));
  for (const run of [() => unpark('seo-audit', s.opts), () => park('seo-audit', s.opts)]) {
    assert.throws(run, (e) => /Both copies were kept: .*compare them before removing either/s.test(e.message)
      && /--forget/.test(e.message) && !/or remove it/.test(e.message));
  }
  assert.ok(fs.existsSync(path.join(parked, 'extra', 'note.txt')));
  assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /edited by the user/);
});

test('park is refused while an unfinished unpark record exists', () => {
  const s = setup();
  const dir = userSkill(s, 'seo-audit');
  park('seo-audit', s.opts);
  assert.throws(() => unpark('seo-audit', { ...s.opts, _deps: { rename: exdev, remove: failRemove } }), /could not be removed/);
  const before = fs.readFileSync(path.join(s.data, 'state.json'), 'utf8');
  assert.ok(fs.existsSync(dir));
  assert.throws(() => park('seo-audit', s.opts), /did not finish.*qm unpark seo-audit/s);
  assert.equal(fs.readFileSync(path.join(s.data, 'state.json'), 'utf8'), before);
});

test('park crash recovery requires the recorded source: same-named skill elsewhere keeps both', () => {
  const s = setup();
  const claudeK = path.join(s.home, '.claude', 'skills', 'k');
  const agentsK = path.join(s.home, '.agents', 'skills', 'k');
  write(path.join(claudeK, 'SKILL.md'), skillMd('k'));
  write(path.join(agentsK, 'SKILL.md'), skillMd('k'));
  write(path.join(agentsK, 'extra', 'n.txt'), 'n');
  const dest = path.join(s.data, 'library', '_parked', 'k');
  write(path.join(dest, 'SKILL.md'), skillMd('k'));
  fs.writeFileSync(path.join(s.data, 'state.json'), JSON.stringify({ parked: [{ name: 'k', from: claudeK, to: dest, links: [], pending: true }] }));
  assert.throws(() => park('k', s.opts), /Both copies were kept/);
  assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(agentsK, 'extra', 'n.txt')));
  assert.equal(loadState(s.data).parked.length, 1);
});

test('unpark --forget drops the record without touching files and prints both locations', () => {
  const s = setup();
  const { dir, parked } = interruptedPark(s);
  const run = (...a) => spawnSync(process.execPath, [QM, ...a], { env: s.env, cwd: s.cwd, encoding: 'utf8' });
  const r = run('unpark', '--forget', 'seo-audit');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`original location: .*seo-audit \\(exists\\)`));
  assert.match(r.stdout, /parked copy: .*_parked.*seo-audit \(exists\)/);
  assert.deepEqual(loadState(s.data).parked, []);
  assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')) && fs.existsSync(path.join(parked, 'SKILL.md')));
  assert.equal(run('unpark', '--forget', 'seo-audit').status, 1);
});

test('parkPlugin never runs a claude placed in the project folder; the one on PATH runs', { skip: process.platform === 'win32' && 'POSIX scripts' }, () => {
  const s = setup();
  const inst = path.join(s.home, 'inst'); fs.mkdirSync(inst, { recursive: true });
  const proj = path.join(s.root, 'proj');
  const bad = path.join(s.root, 'bad-ran');
  const good = path.join(s.root, 'good-ran');
  for (const n of ['claude', 'claude.exe']) { write(path.join(proj, n), `#!/bin/sh\n: > "${bad}"\n`); fs.chmodSync(path.join(proj, n), 0o755); }
  write(path.join(s.home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'p@m': [{ scope: 'project', installPath: inst, projectPath: proj }] } }));
  const opts = withClaude(s, `#!/bin/sh\n: > "${good}"\n`);
  // PATH holds a relative entry and the project folder is the cwd: neither may be used.
  opts.env = { ...opts.env, PATH: `.${path.delimiter}${opts.env.PATH}` };
  const prev = process.cwd();
  process.chdir(proj);
  try { assert.equal(parkPlugin('p', { ...opts, yes: true }).ok, true); } finally { process.chdir(prev); }
  assert.equal(fs.existsSync(good), true);
  assert.equal(fs.existsSync(bad), false);
});

test('parkPlugin without claude on PATH does not spawn and returns the command', () => {
  const s = setup();
  const inst = path.join(s.home, 'inst'); fs.mkdirSync(inst, { recursive: true });
  write(path.join(s.home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'a@m': [{ scope: 'user', installPath: inst }] } }));
  let called = false;
  const r = parkPlugin('a', { ...s.opts, env: { ...s.env, PATH: path.join(s.root, 'nobin') }, yes: true, _deps: { spawn: () => { called = true; return { status: 0 }; } } });
  assert.equal(called, false);
  assert.equal(r.ran, false);
  assert.equal(r.command, 'claude plugin disable a@m');
});

gitTest('add and sync never run a git placed in the current folder; the one on PATH runs', { skip: process.platform === 'win32' && 'POSIX scripts' }, () => {
  const s = setup();
  const repo = makeRepo(s.root, 'pack');
  const proj = path.join(s.root, 'proj');
  const bad = path.join(s.root, 'bad-ran');
  for (const n of ['git', 'git.exe', 'git.com']) { write(path.join(proj, n), `#!/bin/sh\n: > "${bad}"\nexit 1\n`); fs.chmodSync(path.join(proj, n), 0o755); }
  // A relative PATH entry and the project as cwd: neither may be used to find git.
  const env = { ...s.env, PATH: `.${path.delimiter}${s.env.PATH}` };
  const prev = process.cwd();
  process.chdir(proj);
  try {
    assert.equal(addCollection(repo, { ...s.opts, env }).skills, 2);
    syncCollections({ ...s.opts, env });
  } finally { process.chdir(prev); }
  assert.equal(fs.existsSync(bad), false);
});

test('add without git on PATH says so and runs nothing', () => {
  const s = setup();
  const repo = path.join(s.root, 'pack'); fs.mkdirSync(repo, { recursive: true });
  assert.throws(() => addCollection(repo, { ...s.opts, env: { ...s.env, PATH: path.join(s.root, 'nobin') } }), /git is not installed or not on PATH/);
});

test('unpark recreates folder links as junctions on Windows (no Developer Mode needed)', () => {
  assert.deepEqual(dirLinkArgs('../../.agents/skills/foo', '/h/.claude/skills/foo', 'linux'), ['../../.agents/skills/foo', '/h/.claude/skills/foo', 'dir']);
  assert.deepEqual(dirLinkArgs('..\\..\\.agents\\skills\\foo', 'C:\\Users\\a\\.claude\\skills\\foo', 'win32'),
    ['C:\\Users\\a\\.agents\\skills\\foo', 'C:\\Users\\a\\.claude\\skills\\foo', 'junction']);
  assert.deepEqual(dirLinkArgs('D:\\skills\\foo', 'C:\\x\\foo', 'win32'), ['D:\\skills\\foo', 'C:\\x\\foo', 'junction']);
});

test('on Windows a relative link is recreated as the same symlink first, a junction only as fallback', () => {
  const rel = '..\\..\\.agents\\skills\\foo';
  const link = 'C:\\Users\\a\\.claude\\skills\\foo';
  assert.deepEqual(dirLinkAttempts(rel, link, 'win32'), [[rel, link, 'dir'], ['C:\\Users\\a\\.agents\\skills\\foo', link, 'junction']]);
  // A junction reads back absolute: it is recreated as a junction, never tried as a symlink.
  assert.deepEqual(dirLinkAttempts('C:\\Users\\a\\.agents\\skills\\foo\\', link, 'win32'), [['C:\\Users\\a\\.agents\\skills\\foo', link, 'junction']]);
  assert.deepEqual(dirLinkAttempts('../../x', '/h/.claude/skills/x', 'linux'), [['../../x', '/h/.claude/skills/x', 'dir']]);
});

test('Windows env lookup: with both "Path" and "PATH" the one child_process passes on wins', () => {
  // child_process on Windows keeps the first of case-insensitive duplicate keys in sorted order.
  assert.equal(envGet({ Path: 'C:\\real', PATH: 'C:\\nobin' }, 'PATH', true), 'C:\\nobin');
  assert.equal(envGet({ PATH: 'C:\\nobin', Path: 'C:\\real' }, 'PATH', true), 'C:\\nobin');
  assert.equal(envGet({ Path: 'C:\\real' }, 'PATH', true), 'C:\\real');
  assert.equal(envGet({ Path: 'x' }, 'PATH', false), undefined);
  // The same rule end to end: an inherited Path holding git must not be searched when PATH overrides it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-which-'));
  const real = path.join(root, 'real'); const none = path.join(root, 'nobin');
  write(path.join(real, 'git.exe'), '');
  fs.mkdirSync(none);
  assert.equal(findExe('git', { Path: real }, 'win32'), path.join(real, 'git.exe'));
  assert.equal(findExe('git', { Path: real, PATH: none }, 'win32'), null);
});
