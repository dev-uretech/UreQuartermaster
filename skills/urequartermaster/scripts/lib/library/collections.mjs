// `qm add` and `qm sync`: skill collections cloned from git. Their content is untrusted third-party
// text: it is indexed as state "library" and only ever read through the trust checks of scan/trust.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { resolveOptions as resolve } from '../core/options.mjs';
import { exists, isPlainDir } from '../core/files.mjs';
import { validateSource, deriveName, checkName } from './names.mjs';
import { runGit } from './git.mjs';
import { ensureLibrary, rebuild } from './store.mjs';

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
