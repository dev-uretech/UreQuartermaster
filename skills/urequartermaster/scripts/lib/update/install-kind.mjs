// How this copy of the skill was installed, which decides who may update it: a plugin or the skills CLI
// update through their manager, a copy inside a project or a git checkout of this repository is never
// replaced, and only a manual copy in a global skill folder updates itself. Unknown means "project".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir as defaultDataDir, agentLocations } from '../core/paths.mjs';
import { loadConfig } from '../core/config.mjs';
import { isObj, isBelow, readJsonObject } from '../core/files.mjs';

export const MANAGER_COMMANDS = {
  plugin: 'claude plugin update urequartermaster@urequartermaster',
  'skills-cli': 'npx skills update urequartermaster',
};

/**
 * How this copy was installed: 'plugin', 'skills-cli', 'manual' (a direct child of one of the
 * user's global skill folders, or of an extraSkillDirs folder) or 'project' (anything else, e.g.
 * <repo>/.agents/skills: files in the user's working tree). Only 'manual' copies are updated by qm.
 */
export function installKind(skillDir, { home = os.homedir(), env = process.env, dataDir } = {}) {
  const rp = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const real = rp(skillDir);
  if (!real) return 'project'; // unknown: fail closed, never self-update
  const loc = agentLocations({ home, env });
  const cache = rp(loc.pluginCache);
  if (cache && isBelow(cache, real)) return 'plugin';
  const lock = readJsonObject(loc.skillsLockFile);
  if (isObj(lock) && isObj(lock.skills) && Object.hasOwn(lock.skills, 'urequartermaster')) {
    const agentsSkills = path.join(path.dirname(loc.skillsLockFile), 'skills');
    const base = rp(agentsSkills);
    if (base && isBelow(base, real)) return 'skills-cli';
    if (rp(path.join(agentsSkills, 'urequartermaster')) === real) return 'skills-cli';
  }
  const extra = loadConfig(dataDir || defaultDataDir(env)).extraSkillDirs;
  const globalDirs = [
    ...agentLocations({ home, env, cwd: path.join(home, '\u0000no-project') }).skillDirs.filter((s) => s.source !== 'project').map((s) => s.dir),
    ...(Array.isArray(extra) ? extra.filter((d) => typeof d === 'string' && path.isAbsolute(d)) : []),
  ].map(rp).filter(Boolean);
  return globalDirs.includes(path.dirname(real)) ? 'manual' : 'project';
}

// Name in this repository's package.json; a git checkout of this project is recognised by it.
const PACKAGE_NAME = 'urequartermaster';

/**
 * The root of a git checkout of this very project that skillDir belongs to, else null.
 * Such a copy is a developer's working tree and must not be replaced. Any other git repo
 * above the skill (e.g. dotfiles kept under git in ~ or ~/.claude) does not count.
 */
export function devCheckoutOf(skillDir) {
  let real;
  try { real = fs.realpathSync(skillDir); } catch { return null; }
  const root = path.dirname(path.dirname(real));
  if (path.basename(path.dirname(real)) !== 'skills' || !fs.existsSync(path.join(root, '.git'))) return null;
  try {
    if (fs.realpathSync(path.join(root, 'skills', 'urequartermaster')) !== real) return null;
    const pkg = readJsonObject(path.join(root, 'package.json'));
    return pkg && pkg.name === PACKAGE_NAME ? root : null;
  } catch {
    return null;
  }
}
