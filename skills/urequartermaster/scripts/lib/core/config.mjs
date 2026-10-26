// config.json (user settings) and state.json (bookkeeping). Loading never throws:
// a missing, corrupt or wrong-shaped file yields defaults. Saving is atomic.
import path from 'node:path';
import { clean } from './text.mjs';
import { isObj, readJsonObject, writeFileAtomic } from './files.mjs';

const str = (v) => typeof v === 'string';

export const defaultConfig = () => ({
  extraSkillDirs: [],
  clis: [],
  autoUpdate: true,
  hook: true,
  maxIndexAgeHours: 24,
  mcpDescriptions: {},
  trustProjectMcp: false,
});

export const defaultState = () => ({ lastUpdateCheck: null, installedVersion: null, lastUpdateMessage: null, parked: [] });
const MAX_MESSAGE = 300;

export function loadConfig(dir) {
  const d = defaultConfig();
  const r = readJsonObject(path.join(dir, 'config.json'));
  if (!r) return d;
  if (Array.isArray(r.extraSkillDirs)) d.extraSkillDirs = r.extraSkillDirs.filter(str);
  if (Array.isArray(r.clis)) {
    d.clis = r.clis
      .filter((c) => isObj(c) && str(c.name))
      .map((c) => ({ name: c.name, description: str(c.description) ? c.description : '' }));
  }
  if (typeof r.autoUpdate === 'boolean') d.autoUpdate = r.autoUpdate;
  if (typeof r.hook === 'boolean') d.hook = r.hook;
  if (typeof r.maxIndexAgeHours === 'number' && Number.isFinite(r.maxIndexAgeHours) && r.maxIndexAgeHours > 0) {
    d.maxIndexAgeHours = r.maxIndexAgeHours;
  }
  if (r.trustProjectMcp === true) d.trustProjectMcp = true;
  if (isObj(r.mcpDescriptions)) {
    for (const [k, v] of Object.entries(r.mcpDescriptions)) if (str(v)) d.mcpDescriptions[k] = v;
  }
  return d;
}

export function saveConfig(dir, cfg) {
  writeFileAtomic(path.join(dir, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
}

export function loadState(dir) {
  const d = defaultState();
  const r = readJsonObject(path.join(dir, 'state.json'));
  if (!r) return d;
  // An unparseable date counts as "never checked" rather than blocking checks forever.
  if (str(r.lastUpdateCheck) && Number.isFinite(Date.parse(r.lastUpdateCheck))) d.lastUpdateCheck = r.lastUpdateCheck;
  if (str(r.lastUpdateMessage)) {
    const m = clean(r.lastUpdateMessage).replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);
    if (m) d.lastUpdateMessage = m;
  }
  if (str(r.installedVersion)) d.installedVersion = r.installedVersion;
  if (Array.isArray(r.parked)) {
    d.parked = r.parked.filter((x) => isObj(x) && str(x.name) && str(x.from) && str(x.to));
  }
  return d;
}

export function saveState(dir, st) {
  writeFileAtomic(path.join(dir, 'state.json'), `${JSON.stringify(st, null, 2)}\n`);
}
