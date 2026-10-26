// Entries of the current project (its skills and approved MCP servers): scanned live on each call,
// never saved, flagged as untrusted, and never allowed to shadow a global entry with the same name.
import { resolveOptions as resolve } from '../core/options.mjs';
import { readJsonObject } from '../core/files.mjs';
import { loadConfig } from '../core/config.mjs';
import { scanSkills } from '../scan/skills.mjs';
import { scanMcp } from '../scan/mcp.mjs';
import { splitLocations } from './locations.mjs';

// Names were deduplicated before unapproved servers were removed: do it again so no
// duplicateOf points at a removed entry. Same id scheme as scanMcp.
function dedupeMcp(entries) {
  const first = new Map();
  const count = new Map();
  return entries.map((e) => {
    const { duplicateOf, ...rest } = e;
    const k = first.get(e.name);
    if (!k) { first.set(e.name, `mcp:${e.name}`); return { ...rest, id: `mcp:${e.name}` }; }
    const base = `${k}@${e.source}`;
    const n = (count.get(base) || 0) + 1;
    count.set(base, n);
    return { ...rest, id: n === 1 ? base : `${base}#${n}`, duplicateOf: k };
  });
}

// Approval state of <cwd>/.mcp.json servers, as Claude Code stores it. Only these three keys are read.
function mcpApproval(claudeJson, cwd) {
  try {
    const doc = readJsonObject(claudeJson);
    const projects = doc && doc.projects;
    if (!projects || typeof projects !== 'object') return { all: false, enabled: new Set(), disabled: new Set() };
    const e = projects[cwd] || projects[cwd.replace(/\\/g, '/')];
    const list = (v) => new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    if (!e || typeof e !== 'object') return { all: false, enabled: new Set(), disabled: new Set() };
    return { all: e.enableAllProjectMcpServers === true, enabled: list(e.enabledMcpjsonServers), disabled: list(e.disabledMcpjsonServers) };
  } catch {
    return { all: false, enabled: new Set(), disabled: new Set() };
  }
}

/**
 * Skills and MCP servers of the current project only: live, never saved.
 * Servers from <cwd>/.mcp.json count only when the user approved them in Claude Code;
 * projects[...].mcpServers (claude mcp add -s local) are trusted. @returns {Entry[]}
 */
export function scanProject(opts = {}) {
  try {
    const r = resolve(opts);
    const { project, claudeJson, projectMcpFile } = splitLocations(r);
    const config = loadConfig(r.dataDir);
    const bare = { installedPluginsFile: null, pluginCache: null, claudeSettingsFile: null };
    // Cursor keeps no approval state we can read: its project file counts only on explicit trust.
    const mcpConfigs = project.mcpConfigs
      .filter((m) => m.agent !== 'cursor' || config.trustProjectMcp === true)
      .map((m) => (m.agent === 'cursor' ? { ...m, agent: 'project' } : m));
    const ap = claudeJson ? mcpApproval(claudeJson, r.cwd) : { all: false, enabled: new Set(), disabled: new Set() };
    const approved = scanMcp({ ...project, mcpConfigs, ...bare }, config).filter((e) => {
      if (e.path !== projectMcpFile) return true;
      if (ap.disabled.has(e.name)) return false;
      return ap.all || ap.enabled.has(e.name);
    });
    const mcp = dedupeMcp(approved);
    return [
      ...scanSkills({ ...project, ...bare }, { config: { extraSkillDirs: [] }, cwd: r.cwd }),
      ...mcp,
    ];
  } catch {
    return [];
  }
}

// Global (personal) entries stay primary: an untrusted repo must not shadow them. A project
// entry with the same kind and name becomes a duplicate of the global one.
export function withProject(idx, projectEntries) {
  if (!projectEntries.length) return idx;
  const key = (e) => `${e.kind}\0${e.name.toLowerCase()}`;
  const globalPrimary = new Map();
  for (const e of idx.entries) if (!e.duplicateOf && !globalPrimary.has(key(e))) globalPrimary.set(key(e), e);
  const globalPaths = new Set(idx.entries.map((e) => e.path).filter(Boolean));
  const proj = projectEntries
    .filter((e) => !(e.kind === 'skill' && e.path && globalPaths.has(e.path)))
    .map((e) => {
      const g = globalPrimary.get(key(e));
      if (!g) return e;
      return e.duplicateOf ? { ...e, duplicateOf: g.id } : { ...e, id: `${e.id}@project`, duplicateOf: g.id };
    });
  // Ids must be unique over the whole result; global entries claim theirs first.
  const taken = new Set(idx.entries.map((e) => e.id));
  const projUnique = proj.map((e) => {
    let id = e.id;
    for (let n = 2; taken.has(id); n++) id = `${e.id}#${n}`;
    taken.add(id);
    return id === e.id ? e : { ...e, id };
  });
  return { ...idx, entries: [...idx.entries, ...projUnique] };
}
