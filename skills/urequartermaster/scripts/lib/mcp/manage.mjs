// MCP servers on demand for Claude Code. Claude Code starts every stdio server in scope when a session starts,
// so servers configured at user scope run once per open session in every project. This module:
//   - inventories the servers (scope and transport only) and their real use from the transcripts;
//   - plans and applies moving rarely used stdio servers from user scope to the projects that use them, keeping
//     every removed definition in the parked store (core/mcp-store.mjs) so nothing is ever lost;
//   - enables a server for one project (removes it from the project's `disabledMcpServers`, the list the /mcp
//     toggle writes, or adds a local-scope copy from the store) and disables it again;
//   - restores a parked definition to user or local scope.
// Definitions are copied as they are; no field of a definition is ever returned for printing.
import path from 'node:path';
import { resolveOptions as resolve } from '../core/options.mjs';
import { agentLocations } from '../core/paths.mjs';
import { isObj, isDir } from '../core/files.mjs';
import { loadStore, saveStore, storePath, isSafeMcpName } from '../core/mcp-store.mjs';
import { readText, parseJsonLoose } from '../scan/mcp/jsonc.mjs';
import { pluginServerSources } from '../scan/mcp.mjs';
import {
  readClaudeJson, commitClaudeJson, mcpHash, transportOf, isLocalProcess,
  userServers, localServers, disabledIn, projectPaths,
} from './claude-config.mjs';
import { collectUsage, toolKey } from './usage.mjs';

export const DEFAULT_DAYS = 14;
export const DEFAULT_MIN_PROJECTS = 3;

function context(opts) {
  const r = resolve(opts);
  const loc = agentLocations(r);
  return { r, loc, file: loc.claudeJson };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Servers of <project>/.mcp.json (names and transports only are used). */
function projectFileServers(project) {
  const doc = parseJsonLoose(readText(path.join(project, '.mcp.json')));
  return doc && isObj(doc.mcpServers) ? doc.mcpServers : {};
}

/**
 * Every Claude Code MCP server qm can see, as rows { name, transport, scopes[] } where a scope is
 * 'user', 'local' (with project), 'project-file' (a project's .mcp.json), 'plugin' (with plugin) or 'parked'.
 * `extraProjects` adds folders (from the transcripts) whose .mcp.json is looked at.
 */
export function inventory(doc, { loc, dataDir, extraProjects = [] }) {
  const rows = new Map();
  const add = (name, def, scope) => {
    if (!rows.has(name)) rows.set(name, { name, transport: transportOf(def), scopes: [] });
    const row = rows.get(name);
    if (row.transport === 'unknown') row.transport = transportOf(def);
    row.scopes.push(scope);
  };
  for (const [n, d] of Object.entries(userServers(doc))) add(n, d, { scope: 'user' });
  const projects = new Set(projectPaths(doc));
  for (const p of projects) for (const [n, d] of Object.entries(localServers(doc, p))) add(n, d, { scope: 'local', project: p });
  for (const p of new Set([...projects, ...extraProjects])) {
    if (!path.isAbsolute(p)) continue;
    for (const [n, d] of Object.entries(projectFileServers(p))) add(n, d, { scope: 'project-file', project: p });
  }
  let plugins = [];
  try { plugins = pluginServerSources(loc); } catch { plugins = []; }
  for (const { plugin, servers } of plugins) {
    if (!isObj(servers)) continue;
    for (const [n, d] of Object.entries(servers)) add(`plugin:${plugin}:${n}`, d, { scope: 'plugin', plugin, key: `plugin_${toolKey(plugin)}_${toolKey(n)}` });
  }
  const store = loadStore(dataDir);
  for (const [n, s] of Object.entries(store.servers)) add(n, s.definition, { scope: 'parked' });
  for (const p of projects) {
    for (const n of disabledIn(doc, p)) if (rows.has(n)) rows.get(n).scopes.push({ scope: 'disabled', project: p });
  }
  return { rows: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)), store };
}

/** Usage report: inventory plus calls per project over the last `days` days. */
export function mcpUsage(opts = {}) {
  const { r, loc, file } = context(opts);
  const days = opts.days ?? DEFAULT_DAYS;
  const { doc } = readClaudeJson(file);
  const first = inventory(doc, { loc, dataDir: r.dataDir });
  const keys = new Map();
  for (const row of first.rows) {
    const plug = row.scopes.find((s) => s.scope === 'plugin');
    keys.set(plug ? plug.key : toolKey(row.name), row.name);
  }
  const since = r.now - days * 86400e3;
  const u = collectUsage({ projectsDir: loc.claudeTranscripts, since, keys });
  const usedProjects = new Set();
  for (const m of u.usage.values()) for (const p of m.keys()) usedProjects.add(p);
  const inv = inventory(doc, { loc, dataDir: r.dataDir, extraProjects: [...usedProjects] });
  const rows = inv.rows.map((row) => {
    const per = u.usage.get(row.name) || new Map();
    const projects = [...per.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([project, calls]) => ({ project, calls }));
    return { ...row, calls: projects.reduce((s, x) => s + x.calls, 0), projects };
  });
  const unknown = [...u.unknown.entries()].map(([name, m]) => ({ name, calls: [...m.values()].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  return { days, transcripts: u.files, rows, unknown, file, doc };
}

/**
 * The plan for the user-scope servers: 'keep' (remote, or used in at least `minProjects` projects), 'move'
 * (stdio, used in fewer projects: a local-scope copy in each, removed from user scope) or 'park' (stdio, not
 * used: removed from user scope). Moved and parked definitions both go to the parked store first.
 */
export function mcpPlan(opts = {}) {
  const minProjects = opts.minProjects ?? DEFAULT_MIN_PROJECTS;
  const rep = mcpUsage(opts);
  const users = userServers(rep.doc);
  const actions = [];
  for (const row of rep.rows) {
    if (!row.scopes.some((s) => s.scope === 'user')) continue;
    const def = users[row.name];
    const projects = row.projects.filter((x) => path.isAbsolute(x.project) && isDir(x.project));
    if (!isLocalProcess(def)) { actions.push({ action: 'keep', name: row.name, transport: row.transport, reason: 'remote: no local process' }); continue; }
    if (projects.length >= minProjects) { actions.push({ action: 'keep', name: row.name, transport: row.transport, reason: `used in ${projects.length} projects` }); continue; }
    if (!isSafeMcpName(row.name)) { actions.push({ action: 'keep', name: row.name, transport: row.transport, reason: 'name with unusual characters: move it by hand' }); continue; }
    if (!projects.length) { actions.push({ action: 'park', name: row.name, transport: row.transport, calls: row.calls }); continue; }
    actions.push({ action: 'move', name: row.name, transport: row.transport, projects });
  }
  const before = Object.values(users).filter(isLocalProcess).length;
  const after = before - actions.filter((a) => a.action !== 'keep').length;
  return { ...rep, minProjects, actions, stdioUserBefore: before, stdioUserAfter: after, hash: mcpHash(rep.doc) };
}

/** Applies a plan made by mcpPlan: store first, then ~/.claude.json (refused if its MCP part changed). */
export function mcpApply(opts = {}) {
  const { r } = context(opts);
  const plan = mcpPlan(opts);
  const changes = plan.actions.filter((a) => a.action !== 'keep');
  if (!changes.length) return { ...plan, backup: null, store: null };
  const users = userServers(plan.doc);
  const store = loadStore(r.dataDir);
  const stamp = new Date(r.now).toISOString();
  for (const a of changes) {
    const prev = store.servers[a.name];
    if (prev && !same(prev.definition, users[a.name])) throw new Error(`the parked store already holds a different "${a.name}": restore or rename it first (nothing was changed)`);
    store.servers[a.name] = { definition: users[a.name], from: 'user', parkedAt: stamp };
  }
  saveStore(r.dataDir, store); // never lose a definition: the copy exists before the config changes
  const backup = commitClaudeJson(plan.file, {
    dataDir: r.dataDir,
    expectedHash: plan.hash,
    mutate: (doc) => {
      for (const a of changes) {
        const def = doc.mcpServers[a.name];
        if (a.action === 'move') {
          for (const { project } of a.projects) {
            if (!isObj(doc.projects)) doc.projects = {};
            if (!isObj(doc.projects[project])) doc.projects[project] = {};
            const e = doc.projects[project];
            if (!isObj(e.mcpServers)) e.mcpServers = {};
            if (!Object.hasOwn(e.mcpServers, a.name)) e.mcpServers[a.name] = def;
          }
        }
        delete doc.mcpServers[a.name];
      }
    },
  });
  return { ...plan, backup, store: storePath(r.dataDir) };
}

// Where a definition for `name` can be copied from: the store, else another project's local scope.
function findDefinition(doc, store, name, project) {
  if (store.servers[name]) return { def: store.servers[name].definition, from: 'parked store' };
  for (const p of projectPaths(doc)) {
    if (p === project) continue;
    const l = localServers(doc, p);
    if (Object.hasOwn(l, name)) return { def: l[name], from: 'another project' };
  }
  return null;
}

function activeScopes(doc, loc, name, project) {
  const s = [];
  if (Object.hasOwn(userServers(doc), name)) s.push('user');
  if (Object.hasOwn(localServers(doc, project), name)) s.push('local');
  if (Object.hasOwn(projectFileServers(project), name)) s.push('project-file');
  if (name.startsWith('plugin:')) {
    let plugins = [];
    try { plugins = pluginServerSources(loc); } catch { plugins = []; }
    const [, plugin, server] = name.split(':');
    if (plugins.some((x) => x.plugin === plugin && isObj(x.servers) && Object.hasOwn(x.servers, server))) s.push('plugin');
  }
  return s;
}

function checkName(name) {
  if (typeof name !== 'string' || !(isSafeMcpName(name) || /^plugin:[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))) {
    throw new Error('not a valid MCP server name');
  }
}

function projectOf(r, project) {
  const p = path.resolve(r.cwd, project ?? '.');
  if (!isDir(p)) throw new Error(`${p} is not a folder`);
  return p;
}

/**
 * Enables `name` for `project` (default: the current folder), effective from the next Claude Code session there.
 * Removes it from the project's disabledMcpServers; if no definition applies to the project, adds a local-scope
 * copy from the parked store or another project and records it as enabled on demand.
 * @returns {{ name, project, changed: boolean, how: string, backup: string|null }}
 */
export function mcpEnable(name, opts = {}) {
  checkName(name);
  const { r, loc, file } = context(opts);
  const project = projectOf(r, opts.project);
  const cur = readClaudeJson(file);
  const store = loadStore(r.dataDir);
  const disabled = disabledIn(cur.doc, project).includes(name);
  const active = activeScopes(cur.doc, loc, name, project);
  if (active.length && !disabled) return { name, project, changed: false, how: `already enabled (${active.join(', ')} scope)`, backup: null };
  let copy = null;
  if (!active.length) {
    if (!isSafeMcpName(name)) throw new Error(`no definition of "${name}" applies to ${project}`);
    copy = findDefinition(cur.doc, store, name, project);
    if (!copy) throw new Error(`no MCP server named "${name}" is configured, parked or used in another project`);
  }
  const backup = commitClaudeJson(file, {
    dataDir: r.dataDir,
    expectedHash: mcpHash(cur.doc),
    mutate: (doc) => {
      if (!isObj(doc.projects)) doc.projects = {};
      if (!isObj(doc.projects[project])) doc.projects[project] = {};
      const e = doc.projects[project];
      if (Array.isArray(e.disabledMcpServers)) e.disabledMcpServers = e.disabledMcpServers.filter((x) => x !== name);
      if (copy) {
        if (!isObj(e.mcpServers)) e.mcpServers = {};
        e.mcpServers[name] = copy.def;
      }
    },
  });
  if (copy) {
    const s = loadStore(r.dataDir);
    s.enabled[name] = [...new Set([...(s.enabled[name] || []), project])];
    saveStore(r.dataDir, s);
  }
  const how = copy ? `added to this project's local scope (copy from the ${copy.from})` : `removed from this project's disabled list (${active.join(', ')} scope)`;
  return { name, project, changed: true, how, backup };
}

/**
 * Disables `name` for `project`. A copy that `qm mcp enable` added is removed again (the definition stays in the
 * parked store, saved there first if needed); any other server is added to the project's disabledMcpServers, the
 * same list the /mcp toggle writes, so its definition is untouched.
 */
export function mcpDisable(name, opts = {}) {
  checkName(name);
  const { r, loc, file } = context(opts);
  const project = projectOf(r, opts.project);
  const cur = readClaudeJson(file);
  const store = loadStore(r.dataDir);
  const local = localServers(cur.doc, project);
  const onDemand = (store.enabled[name] || []).includes(project) && Object.hasOwn(local, name);
  const active = activeScopes(cur.doc, loc, name, project);
  if (!active.length) return { name, project, changed: false, how: 'not enabled for this project', backup: null };
  if (!onDemand && disabledIn(cur.doc, project).includes(name)) return { name, project, changed: false, how: 'already disabled for this project', backup: null };
  if (onDemand) {
    const kept = store.servers[name] && same(store.servers[name].definition, local[name]);
    if (!kept && !store.servers[name]) {
      store.servers[name] = { definition: local[name], from: 'local', fromProject: project, parkedAt: new Date(r.now).toISOString() };
      saveStore(r.dataDir, store);
    } else if (!kept) {
      throw new Error(`the copy of "${name}" in this project differs from the parked one: disable it with /mcp, or remove it by hand`);
    }
  }
  const backup = commitClaudeJson(file, {
    dataDir: r.dataDir,
    expectedHash: mcpHash(cur.doc),
    mutate: (doc) => {
      if (!isObj(doc.projects)) doc.projects = {};
      if (!isObj(doc.projects[project])) doc.projects[project] = {};
      const e = doc.projects[project];
      if (onDemand) delete e.mcpServers[name];
      const still = onDemand ? active.filter((s) => s !== 'local') : active;
      if (still.length) {
        const list = Array.isArray(e.disabledMcpServers) ? e.disabledMcpServers : [];
        if (!list.includes(name)) e.disabledMcpServers = [...list, name];
      }
    },
  });
  if (onDemand) {
    const s = loadStore(r.dataDir);
    s.enabled[name] = (s.enabled[name] || []).filter((p) => p !== project);
    saveStore(r.dataDir, s);
  }
  const how = onDemand ? 'removed the on-demand copy from this project (the definition stays parked)' : 'added to this project\'s disabled list (definition untouched)';
  return { name, project, changed: true, how, backup };
}

/**
 * Puts a parked definition back: at user scope (`user: true`), in a project's local scope (`project`), or where it
 * came from. Refuses when the target already holds a different definition. The store entry is dropped only
 * after ~/.claude.json was written.
 */
export function mcpRestore(name, opts = {}) {
  checkName(name);
  const { r, file } = context(opts);
  const store = loadStore(r.dataDir);
  const parked = store.servers[name];
  if (!parked) throw new Error(`"${name}" is not in the parked store`);
  let target;
  if (opts.user) target = { scope: 'user' };
  else if (opts.project !== undefined) target = { scope: 'local', project: projectOf(r, opts.project) };
  else target = parked.from === 'local' && parked.fromProject ? { scope: 'local', project: parked.fromProject } : { scope: 'user' };
  const cur = readClaudeJson(file);
  const existing = target.scope === 'user' ? userServers(cur.doc) : localServers(cur.doc, target.project);
  let backup = null;
  if (Object.hasOwn(existing, name)) {
    if (!same(existing[name], parked.definition)) throw new Error(`a different "${name}" is already configured there: nothing was changed`);
  } else {
    backup = commitClaudeJson(file, {
      dataDir: r.dataDir,
      expectedHash: mcpHash(cur.doc),
      mutate: (doc) => {
        let servers;
        if (target.scope === 'user') {
          if (!isObj(doc.mcpServers)) doc.mcpServers = {};
          servers = doc.mcpServers;
        } else {
          if (!isObj(doc.projects)) doc.projects = {};
          if (!isObj(doc.projects[target.project])) doc.projects[target.project] = {};
          const e = doc.projects[target.project];
          if (!isObj(e.mcpServers)) e.mcpServers = {};
          servers = e.mcpServers;
          if (Array.isArray(e.disabledMcpServers)) e.disabledMcpServers = e.disabledMcpServers.filter((x) => x !== name);
        }
        servers[name] = parked.definition;
      },
    });
  }
  const s = loadStore(r.dataDir);
  delete s.servers[name];
  delete s.enabled[name];
  saveStore(r.dataDir, s);
  return { name, target, backup };
}
