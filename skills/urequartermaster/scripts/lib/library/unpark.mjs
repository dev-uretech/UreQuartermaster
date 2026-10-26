// `qm unpark` and `qm unpark --forget`: restore a parked skill (folder, links, lock entry), finishing
// an interrupted park or unpark in the right direction, or drop its record without touching any file.
// state.json is plain data: a restore goes only to a direct child of one of the user's skill folders.
import fs from 'node:fs';
import path from 'node:path';
import { agentLocations } from '../core/paths.mjs';
import { resolveOptions as resolve } from '../core/options.mjs';
import { safe, exists, real, isPlainDir } from '../core/files.mjs';
import { loadConfig, loadState, saveState } from '../core/config.mjs';
import { safeFolderName } from './names.mjs';
import { isSubset, moveDir, dirLinkArgs } from './move.mjs';
import { readLock, writeLock } from './skills-lock.mjs';
import { parkedPath, rebuild } from './store.mjs';
import { userSkillDirs, bothKept } from './park.mjs';

/**
 * Drops the record of a parked skill without touching any file.
 * @returns {{name:string, from:string, parked:string, fromExists:boolean, parkedExists:boolean}}
 */
export function forget(skillName, opts = {}) {
  const r = resolve(opts);
  const state = loadState(r.dataDir);
  const want = String(skillName).toLowerCase();
  const rec = state.parked.find((p) => p.name.toLowerCase() === want);
  if (!rec) throw new Error(`"${skillName}" is not parked.`);
  const parked = safeFolderName(rec.name) ? parkedPath(r, rec.name) : rec.to;
  state.parked = state.parked.filter((p) => p !== rec);
  saveState(r.dataDir, state);
  rebuild(r);
  return { name: rec.name, from: rec.from, parked, fromExists: exists(rec.from), parkedExists: exists(parked) };
}

/**
 * Restores a parked skill: folder, links and skills CLI lock entry. A record left by an interrupted
 * move is finished in the right direction: after an interrupted unpark `from` is the live copy and is
 * never touched; after an interrupted park (or a crash mid-copy, `pending`) the source is whole.
 * @returns {{from:string,to:string}}
 */
export function unpark(skillName, opts = {}) {
  const r = resolve(opts);
  const loc = agentLocations(r);
  const config = loadConfig(r.dataDir);
  const state = loadState(r.dataDir);
  const want = String(skillName).toLowerCase();
  const rec = state.parked.find((p) => p.name.toLowerCase() === want);
  if (!rec) throw new Error(`"${skillName}" is not parked.`);
  if (!safeFolderName(rec.name)) throw new Error(`State entry "${rec.name}" is not a safe folder name: refusing to restore it.`);
  const src = parkedPath(r, rec.name);

  // state.json is plain data: the target must be a direct child of one of the user's skill folders.
  const skillDirs = userSkillDirs(r, loc, config);
  const from = rec.from;
  const parent = real(path.dirname(from));
  const okParent = skillDirs.some((d) => { const rd = real(d) || path.resolve(d); return (parent || path.resolve(path.dirname(from))) === rd; });
  if (!okParent) throw new Error(`Recorded origin ${from} is not inside a skill folder of yours: refusing to restore.`);
  const links = (Array.isArray(rec.links) ? rec.links : []).filter((l) => l && typeof l.path === 'string' && typeof l.target === 'string'
    && skillDirs.some((d) => path.dirname(path.resolve(l.path)) === path.resolve(d)));
  const mode = rec.interrupted || (rec.pending ? 'park' : null);
  const sameLink = (l) => safe(() => fs.lstatSync(l.path).isSymbolicLink() && fs.readlinkSync(l.path) === l.target, false);
  const done = () => { state.parked = state.parked.filter((p) => p !== rec); saveState(r.dataDir, state); };
  const finish = () => {
    const warnings = [];
    for (const l of links) {
      if (exists(l.path)) continue;
      try {
        fs.mkdirSync(path.dirname(l.path), { recursive: true });
        fs.symlinkSync(...dirLinkArgs(l.target, l.path, r.platform));
      } catch (e) { warnings.push(`could not recreate link ${l.path}: ${e.code || e.message}`); }
    }
    if (rec.lockEntry !== undefined && rec.lockKey) {
      const lock = readLock(loc.skillsLockFile);
      if (lock && !Object.hasOwn(lock.doc.skills, rec.lockKey)) {
        const pairs = Object.entries(lock.doc.skills);
        const at = Number.isInteger(rec.lockIndex) ? Math.min(Math.max(rec.lockIndex, 0), pairs.length) : pairs.length;
        pairs.splice(at, 0, [rec.lockKey, rec.lockEntry]);
        lock.doc.skills = Object.fromEntries(pairs);
        writeLock(loc.skillsLockFile, lock);
      }
    }
    done();
    rebuild(r);
    return { from: src, to: from, ...(warnings.length ? { warnings } : {}) };
  };

  if (mode === 'unpark') {
    // `from` is the live copy; only the parked leftover may go, and only if `from` already holds all of it.
    if (!isPlainDir(from)) throw new Error(`${from} is missing although an earlier unpark restored it: nothing was changed. Parked copy: ${src}. To drop the record only: qm unpark --forget ${rec.name}`);
    if (exists(src)) {
      if (!isPlainDir(src) || !isSubset(src, from)) {
        throw new Error(bothKept(rec.name, from, src));
      }
      fs.rmSync(src, { recursive: true, force: true });
    }
    return finish();
  }

  if (!isPlainDir(src)) throw new Error(`${src} is missing: nothing to restore. To drop the record: qm unpark --forget ${rec.name}`);
  if (exists(from)) {
    const interrupted = mode === 'park';
    if (interrupted && isPlainDir(from) && isSubset(from, src)) {
      fs.rmSync(from, { recursive: true, force: true }); // leftover of the source after a verified copy
    } else if (interrupted && isPlainDir(from) && isSubset(src, from)) {
      // Crash mid-copy: the parked folder is a partial copy, the source never left. Nothing to restore.
      fs.rmSync(src, { recursive: true, force: true });
      done();
      rebuild(r);
      return { from: src, to: from };
    } else {
      throw new Error(interrupted && isPlainDir(from) ? bothKept(rec.name, from, src) : `${from} already exists: cannot restore over it.`);
    }
  }
  for (const l of links) if (exists(l.path) && !(mode && sameLink(l))) throw new Error(`${l.path} already exists: cannot restore over it.`);

  // The record stays until the folder is back; a failed delete of the parked copy keeps it.
  try {
    moveDir(src, from, { rename: opts._deps?.rename, remove: opts._deps?.remove });
  } catch (e) {
    if (!e.leftover) throw e;
    rec.interrupted = 'unpark';
    delete rec.pending;
    saveState(r.dataDir, state);
    throw new Error(`"${rec.name}" was restored to ${from} but the parked copy at ${e.leftover} could not be removed (${e.message}). Fix the permissions and run: qm unpark ${rec.name}`);
  }
  return finish();
}
