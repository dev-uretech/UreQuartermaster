// `qm add`, `qm sync` and `qm remove`: skill collections cloned from git. Their content is untrusted third-party
// text: it is indexed as state "library" and only ever read through the trust checks of scan/trust.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { resolveOptions as resolve } from '../core/options.mjs';
import { exists, isPlainDir, lstat } from '../core/files.mjs';
import { validateSource, deriveName, checkName } from './names.mjs';
import { runGit } from './git.mjs';
import { ensureLibrary, rebuild, PARKED } from './store.mjs';
import { libraryRoot } from '../scan/trust.mjs';
import { scanSkills } from '../scan/skills.mjs';

/** Clones a skill collection into <dataDir>/library/<name>. @returns {{name:string,path:string,skills:number}} */
export function addCollection(src, opts = {}) {
  const r = resolve(opts);
  validateSource(src);
  const name = checkName(opts.name !== undefined ? opts.name : deriveName(src));
  const lib = ensureLibrary(r);
  const dest = path.join(lib, name);
  if (exists(dest)) throw new Error(`Collection "${name}" already exists. Update it with "qm sync" or remove ${dest} first.`);
  const tmp = path.join(lib, `.tmp-${name}-${process.pid}-${Date.now()}`);
  const res = runGit(r, ['clone', '--depth', '1', '--no-recurse-submodules', '--single-branch', '--', src, tmp]);
  if (!res.ok) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`git clone failed: ${res.err}`);
  }
  try {
    if (exists(dest)) throw new Error(`Collection "${name}" already exists.`);
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  const idx = rebuild(r);
  const skills = idx.entries.filter((e) => e.kind === 'skill' && e.source === `library:${name}`).length;
  return { name, path: dest, skills };
}

/**
 * Updates every real git collection: `fetch --depth 1 origin HEAD` then `reset --hard FETCH_HEAD`.
 * `pull --ff-only` is not used: on a depth-1 clone it fails whenever upstream rewrites history,
 * and the new tip is unrelated to the old shallow root. The collection is a read-only third-party
 * clone, so resetting to the remote tip is the intended outcome.
 * @returns {{name:string,updated:boolean,error?:string}[]}
 */
export function syncCollections(opts = {}) {
  const r = resolve(opts);
  const lib = path.join(r.dataDir, 'library');
  const results = [];
  if (!isPlainDir(lib)) return results;
  const names = fs.readdirSync(lib).filter((n) => !n.startsWith('_') && !n.startsWith('.')).sort();
  for (const name of names) {
    const dir = path.join(lib, name);
    if (!isPlainDir(dir) || !isPlainDir(path.join(dir, '.git'))) continue;
    const before = runGit(r, ['-C', dir, 'rev-parse', 'HEAD']);
    const fetch = before.ok && runGit(r, ['-C', dir, 'fetch', '--depth', '1', '--no-recurse-submodules', 'origin', 'HEAD']);
    if (!before.ok || !fetch.ok) { results.push({ name, updated: false, error: (before.ok ? fetch : before).err }); continue; }
    const reset = runGit(r, ['-C', dir, 'reset', '--hard', '-q', 'FETCH_HEAD']);
    if (!reset.ok) { results.push({ name, updated: false, error: reset.err }); continue; }
    const after = runGit(r, ['-C', dir, 'rev-parse', 'HEAD']);
    results.push({ name, updated: after.ok && after.out !== before.out });
  }
  rebuild(r);
  return results;
}

/**
 * Removes the git collection <dataDir>/library/<name> added with `qm add`, then rebuilds the index. Refuses the
 * parked folder, invalid names (separators, "..", reserved names), links and anything that is not a git clone.
 * The folder is first renamed to a .tmp- name, so a failed delete leaves nothing that is indexed.
 * @returns {{name:string,path:string,skills:number}}
 */
export function removeCollection(name, opts = {}) {
  const r = resolve(opts);
  if (String(name).toLowerCase() === PARKED) throw new Error(`"${PARKED}" holds parked skills, not a collection: restore one with "qm unpark <skill>".`);
  const n = checkName(name);
  // Windows drops a trailing dot: "pack." would open the folder "pack"
  if (n.endsWith('.')) throw new Error(`Collection names do not end with ".": ${n}`);
  const lib = path.join(r.dataDir, 'library');
  if (lstat(lib)?.isSymbolicLink()) throw new Error(`${lib} is a symbolic link: refusing to use it.`);
  const dest = path.join(lib, n);
  const st = lstat(dest);
  if (!st) throw new Error(`No collection "${n}" in the library. See the collections with: qm list --state library`);
  if (st.isSymbolicLink() || libraryRoot(r.dataDir, n) === null) throw new Error(`${dest} is a link or resolves outside the library: refusing to remove it.`);
  if (!isPlainDir(path.join(dest, '.git'))) throw new Error(`${dest} is not a git collection added with "qm add": remove it by hand if you want it gone.`);
  const none = { skillDirs: [], installedPluginsFile: null, pluginCache: null, claudeSettingsFile: null };
  const skills = scanSkills(none, { dataDir: r.dataDir }).filter((e) => e.source === `library:${n}`).length;
  const tmp = path.join(lib, `.tmp-remove-${n}-${process.pid}-${Date.now()}`);
  fs.renameSync(dest, tmp);
  let failed = null;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { failed = e; }
  // the index must forget the collection even when the files could not all be deleted
  try { rebuild(r); } catch (e) { if (!failed) throw e; }
  if (failed) throw new Error(`"${n}" is out of the library, but its files could not all be deleted (${failed.code || failed.message}): delete ${tmp} by hand, or a later qm add or qm park removes it once it is an hour old.`);
  return { name: n, path: dest, skills };
}
