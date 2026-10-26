// `qm park`: moves a skill out of one of the user's skill folders into library/_parked/<name>, with
// its links and its skills CLI lock entry, so it stays searchable without taking room in the host's
// skill list. A record is written before anything moves, so an interrupted park can always be resumed
// or undone by `qm unpark`. Skills from plugins, projects or the library are never moved.
import fs from 'node:fs';
import path from 'node:path';
import { agentLocations } from '../core/paths.mjs';
import { resolveOptions as resolve } from '../core/options.mjs';
import { safe, exists, real, isPlainDir } from '../core/files.mjs';
import { loadConfig, loadState, saveState } from '../core/config.mjs';
import { scanSkills } from '../scan/skills.mjs';
import { safeFolderName } from './names.mjs';
import { isSubset, moveDir } from './move.mjs';
import { readLock, writeLock } from './skills-lock.mjs';
import { parkedPath, prepareParkedRoot, rebuild } from './store.mjs';

/** The user's own skill folders (never the project's), plus extraSkillDirs. */
export function userSkillDirs(r, loc, config) {
  const dirs = loc.skillDirs.filter((s) => s.source !== 'project').map((s) => s.dir);
  for (const d of config.extraSkillDirs) dirs.push(d);
  return dirs;
}

export const bothKept = (name, from, parked) => `Both copies were kept: ${from} and ${parked}. The parked copy contains files missing from ${from}; compare them before removing either. To drop only the record, without touching any file: qm unpark --forget ${name}`;

/**
 * Moves a skill out of a user skill folder into library/_parked/<name>.
 * `opts._deps` holds test-only hooks (rename, remove).
 * @returns {{from:string,to:string}}
 */
export function park(skillName, opts = {}) {
  const r = resolve(opts);
  const loc = agentLocations(r);
  const config = loadConfig(r.dataDir);
  const entries = scanSkills(loc, { dataDir: r.dataDir, config }).filter((e) => e.kind === 'skill');
  const want = String(skillName).toLowerCase();
  const matches = entries.filter((e) => e.name.toLowerCase() === want
    || (e.source.startsWith('plugin:') && e.name.toLowerCase().split(':').pop() === want));

  const plugin = matches.find((e) => e.source.startsWith('plugin:'));
  const user = matches.find((e) => !e.source.startsWith('plugin:') && !e.source.startsWith('library:') && e.source !== 'project' && !e.duplicateOf)
    || matches.find((e) => !e.source.startsWith('plugin:') && !e.source.startsWith('library:') && e.source !== 'project');
  if (!user && plugin) {
    const p = plugin.source.slice('plugin:'.length);
    throw new Error(`"${plugin.name}" comes from the plugin "${p}": it cannot be parked by itself. Use: qm park --plugin ${p}`);
  }
  if (!user && matches.some((e) => e.source.startsWith('library:'))) {
    throw new Error(`"${skillName}" is already in the library, not in a skill folder of yours.`);
  }
  if (!user) throw new Error(`No installed skill named "${skillName}" in your skill folders.`);
  if (!safeFolderName(user.name)) throw new Error(`Skill name "${user.name}" is not a safe folder name: refusing to park it.`);

  const dest = parkedPath(r, user.name);
  const old = loadState(r.dataDir).parked.find((p) => p.name === user.name);
  const srcDir = path.dirname(user.path);
  const dropRecord = () => {
    const st0 = loadState(r.dataDir);
    st0.parked = st0.parked.filter((p) => p.name !== user.name);
    saveState(r.dataDir, st0);
  };
  if (old) {
    const crashed = old.pending || old.interrupted === 'park';
    if (old.interrupted === 'unpark') {
      throw new Error(`An earlier unpark of "${user.name}" did not finish (links and lock entry still to restore). Run: qm unpark ${user.name}  (or drop the record only: qm unpark --forget ${user.name})`);
    } else if (old.pending && !exists(dest)) {
      dropRecord(); // crash before anything was copied: the source never left
    } else if (crashed && isPlainDir(dest)) {
      const sameSource = path.resolve(srcDir) === path.resolve(old.from) && isPlainDir(srcDir);
      if (sameSource && isSubset(dest, srcDir)) {
        // A crash left a partial copy of this very skill: the source is whole, drop the copy and start over.
        fs.rmSync(dest, { recursive: true, force: true });
        dropRecord();
      } else if (sameSource && isSubset(srcDir, dest)) {
        throw new Error(`An earlier park of "${user.name}" was interrupted after copying it. Finish it with: qm unpark ${user.name}`);
      } else {
        throw new Error(bothKept(user.name, old.from, dest));
      }
    } else {
      throw new Error(`"${user.name}" has a record in the parked list (${dest}). Restore it first with: qm unpark ${user.name}  (or drop the record only: qm unpark --forget ${user.name})`);
    }
  }
  if (exists(dest)) throw new Error(`${dest} already exists and is not recorded as a parked skill: move or rename it first.`);

  const entryDir = path.dirname(user.path);
  const realDir = real(entryDir);
  const fromDir = isPlainDir(entryDir) ? entryDir : realDir; // path as the user knows it
  const skillDirs = userSkillDirs(r, loc, config);
  const realSkillDirs = skillDirs.map(real).filter(Boolean);
  if (!realDir || !realSkillDirs.some((d) => path.dirname(realDir) === d)) {
    throw new Error(`${entryDir} does not resolve to a folder directly inside one of your skill folders: refusing to move it.`);
  }

  // Every link in a user skill folder that points at the real folder goes away with it.
  const links = [];
  for (const dir of skillDirs) {
    for (const d of safe(() => fs.readdirSync(dir, { withFileTypes: true }), [])) {
      const p = path.join(dir, d.name);
      if (d.isSymbolicLink() && real(p) === realDir && !links.some((l) => l.path === p)) {
        links.push({ path: p, target: fs.readlinkSync(p) });
      }
    }
  }

  // Lock entry of the skills CLI (keep its position so unpark restores the file exactly).
  // Only skills installed by the skills CLI (real folder directly in ~/.agents/skills) have a lock entry.
  const agentsSkills = real(path.join(path.dirname(loc.skillsLockFile), 'skills'));
  const lock = agentsSkills && path.dirname(realDir) === agentsSkills ? readLock(loc.skillsLockFile) : null;
  let lockInfo = null;
  if (lock) {
    const keys = Object.keys(lock.doc.skills);
    const key = [user.name, path.basename(realDir)].find((k) => Object.hasOwn(lock.doc.skills, k));
    if (key !== undefined) lockInfo = { lockKey: key, lockIndex: keys.indexOf(key), lockEntry: lock.doc.skills[key] };
  }

  prepareParkedRoot(r);
  // The record goes first: whatever happens to the move, unpark can find the skill.
  const state = loadState(r.dataDir);
  state.parked = state.parked.filter((p) => p.name !== user.name);
  const rec = { name: user.name, from: fromDir, to: dest, links, ...(lockInfo || {}), pending: true };
  state.parked.push(rec);
  saveState(r.dataDir, state);
  try {
    moveDir(fromDir, dest, { rename: opts._deps?.rename, remove: opts._deps?.remove });
  } catch (e) {
    if (e.leftover) {
      rec.interrupted = 'park';
      delete rec.pending;
      saveState(r.dataDir, state);
      throw new Error(`"${user.name}" was copied to ${dest} but the original at ${e.leftover} could not be removed (${e.message}). Fix the permissions and run: qm unpark ${user.name}`);
    }
    state.parked = state.parked.filter((p) => p !== rec);
    saveState(r.dataDir, state);
    throw e;
  }
  delete rec.pending;
  saveState(r.dataDir, state);
  for (const l of links) fs.rmSync(l.path, { force: true });
  if (lockInfo) {
    delete lock.doc.skills[lockInfo.lockKey];
    writeLock(loc.skillsLockFile, lock);
  }
  rebuild(r);
  return { from: fromDir, to: dest };
}
