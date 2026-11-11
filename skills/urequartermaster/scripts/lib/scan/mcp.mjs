// MCP servers configured for each agent (and by enabled Claude Code plugins), without secrets.
// Only `type`, `command`, `args` and `url` (plus OpenCode's command array) are read from a server
// definition; `env`, `environment`, `headers`, auth/oauth/token fields are never copied. The
// description comes from mcp/describe.mjs. Unreadable or malformed files are skipped silently:
// no error message ever carries file content.
import fs from 'node:fs';
import path from 'node:path';
import { listClaudePlugins } from './claude-plugins.mjs';
import { isObj } from '../core/files.mjs';
import { readText, parseJsonLoose } from './mcp/jsonc.mjs';
import { parseTomlServers } from './mcp/toml.mjs';
import { describe } from './mcp/describe.mjs';
import { readJsonObject } from '../core/files.mjs';
import { isSafeMcpName } from '../core/mcp-store.mjs';

const MAX_TOML = 8 * 1024 * 1024; // config.toml is tiny; the subset parser is kept on a short leash

const str = (v) => typeof v === 'string';
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function pickServers(doc, pick) {
  const m = /^projects\[([\s\S]*)\]\.mcpServers$/.exec(pick);
  if (m) {
    if (!isObj(doc.projects)) return null;
    // Claude Code may store Windows project paths with forward slashes.
    for (const k of [m[1], m[1].replace(/\\/g, '/')]) {
      if (own(doc.projects, k) && isObj(doc.projects[k])) return doc.projects[k].mcpServers;
    }
    return null;
  }
  return own(doc, pick) ? doc[pick] : null;
}

// Only the four safe fields are looked at.
// Agents that honour `enabled: false` in their own config (Codex is filtered in parseTomlServers).
// Others (Claude, Gemini, Cursor, VS Code, Copilot) may ignore such a field: their servers stay listed.
const HONOURS_ENABLED = new Set(['opencode']);

export function normalize(def, agent) {
  if (!isObj(def)) return null;
  if (HONOURS_ENABLED.has(agent) && def.enabled === false) return null; // switched off in its config
  let command = null;
  let args = [];
  if (str(def.command)) command = def.command;
  else if (Array.isArray(def.command)) {
    const c = def.command.filter((x) => str(x) || typeof x === 'number').map(String);
    command = c.length ? c[0] : null;
    args = c.slice(1);
  }
  if (Array.isArray(def.args)) args = args.concat(def.args.filter((x) => str(x) || typeof x === 'number').map(String));
  const url = [def.url, def.httpUrl, def.serverUrl].find((u) => str(u) && u) || null;
  if (!command && !url) return null;
  const type = str(def.type) && /^[A-Za-z0-9_-]{1,32}$/.test(def.type) ? def.type : command ? 'stdio' : 'http';
  return { type, command, args, url };
}

export function pluginServerSources(locations) {
  const out = [];
  let plugins = [];
  try { plugins = listClaudePlugins(locations); } catch { plugins = []; }
  for (const p of plugins) {
    if (!p.enabled || !p.dir) continue;
    const mcpFile = path.join(p.dir, '.mcp.json');
    const doc = parseJsonLoose(readText(mcpFile));
    if (doc) out.push({ file: mcpFile, plugin: p.plugin, servers: isObj(doc.mcpServers) ? doc.mcpServers : doc });
    const manifestFile = path.join(p.dir, '.claude-plugin', 'plugin.json');
    const manifest = parseJsonLoose(readText(manifestFile));
    if (manifest && isObj(manifest.mcpServers)) out.push({ file: manifestFile, plugin: p.plugin, servers: manifest.mcpServers });
    else if (manifest && str(manifest.mcpServers)) {
      const f = path.resolve(p.dir, manifest.mcpServers);
      const rel = path.relative(path.resolve(p.dir), f);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && f !== mcpFile) {
        const d = parseJsonLoose(readText(f));
        if (d) out.push({ file: f, plugin: p.plugin, servers: isObj(d.mcpServers) ? d.mcpServers : d });
      }
    }
  }
  return out;
}

export function scanMcp(locations, config) {
  const descriptions = config && isObj(config.mcpDescriptions) ? config.mcpDescriptions : {};
  const found = []; // { name, source, file, server }
  const docs = new Map(); // a file listed twice (.claude.json) is read once

  for (const c of (locations && Array.isArray(locations.mcpConfigs) ? locations.mcpConfigs : [])) {
    if (!c || !str(c.file)) continue;
    let servers = null;
    try {
      if (c.format === 'toml') {
        if (!docs.has(c.file)) docs.set(c.file, parseTomlServers(readText(c.file, MAX_TOML)));
        servers = docs.get(c.file);
      } else {
        if (!docs.has(c.file)) docs.set(c.file, parseJsonLoose(readText(c.file)));
        const doc = docs.get(c.file);
        servers = doc ? pickServers(doc, String(c.pick)) : null;
      }
    } catch { servers = null; }
    if (!isObj(servers)) continue;
    for (const [name, def] of Object.entries(servers)) found.push({ name, source: String(c.agent), file: c.file, def });
  }

  for (const { file, plugin, servers } of pluginServerSources(locations || {})) {
    for (const [name, def] of Object.entries(servers)) {
      found.push({ name: `plugin:${plugin}:${name}`, source: `plugin:${plugin}`, file, def, tools: `mcp__plugin_${plugin}_${name}__…` });
    }
  }

  const out = [];
  const kept = new Map();
  const describeOf = (name, server) => {
    const custom = own(descriptions, name) && str(descriptions[name]) && descriptions[name].trim() ? descriptions[name].trim() : null;
    return custom || describe(server);
  };
  const dupCount = new Map();
  for (const { name, source, file, def, tools } of found) {
    const server = normalize(def, source);
    if (!server) continue;
    const entry = {
      id: `mcp:${name}`, kind: 'mcp', name, description: describeOf(name, server), headings: [],
      path: file, source, state: 'installed', usage: `MCP server ${name}${tools ? ` (Claude Code tools: ${tools})` : ''}`,
    };
    const first = kept.get(name);
    if (first) {
      const base = `${first.id}@${source}`;
      const k = (dupCount.get(base) || 0) + 1;
      dupCount.set(base, k);
      out.push({ ...entry, id: k === 1 ? base : `${base}#${k}`, duplicateOf: first.id });
    } else { kept.set(name, entry); out.push(entry); }
  }
  for (const o of offServers(locations && locations.mcpOff, docs)) {
    if (kept.has(o.name)) continue;
    const server = normalize(o.def, 'claude');
    if (!server) continue;
    kept.set(o.name, true);
    out.push({
      id: `mcp:${o.name}`, kind: 'mcp', name: o.name, description: describeOf(o.name, server), headings: [],
      path: o.file, source: 'claude', state: o.state,
      usage: `qm mcp enable ${o.name} (adds it to the current project in Claude Code; it starts from the next session)`,
    });
  }
  return out;
}

/**
 * Claude Code servers that exist but do not run here: parked by qm (in the parked store) or configured only in
 * other projects' local scope ('off'). Names that are not shell-inert are left out (the agent would put them on a
 * command line). `mcpOff` is { claudeJson, storeFile }; null or missing files give nothing.
 */
function offServers(mcpOff, docs = new Map()) {
  if (!mcpOff || !str(mcpOff.claudeJson)) return [];
  const out = new Map();
  const store = str(mcpOff.storeFile) ? readJsonObject(mcpOff.storeFile) : null;
  if (store && store.version === 1 && isObj(store.servers)) {
    for (const [n, s] of Object.entries(store.servers)) if (isObj(s) && isObj(s.definition)) out.set(n, { name: n, def: s.definition, state: 'parked', file: mcpOff.storeFile });
  }
  if (!docs.has(mcpOff.claudeJson)) docs.set(mcpOff.claudeJson, parseJsonLoose(readText(mcpOff.claudeJson)));
  const doc = docs.get(mcpOff.claudeJson);
  if (doc && isObj(doc.projects)) {
    for (const e of Object.values(doc.projects)) {
      if (!isObj(e) || !isObj(e.mcpServers)) continue;
      for (const [n, d] of Object.entries(e.mcpServers)) if (!out.has(n)) out.set(n, { name: n, def: d, state: 'off', file: mcpOff.claudeJson });
    }
  }
  return [...out.values()].filter((x) => isSafeMcpName(x.name));
}

/**
 * What scanMcp would index from these config files, as one string: used by the index
 * fingerprint instead of their mtime, because agents rewrite some of them all the time
 * (Claude Code saves ~/.claude.json on almost every tool call). Only allowlisted, redacted
 * fields are in it, never env, headers or raw args. Plugin servers are not included.
 * null when a file is larger than `maxBytes`.
 */
export function mcpFingerprint(mcpConfigs, { maxBytes = Infinity, mcpOff = null } = {}) {
  try {
    // A caller with a time budget (the hook) gives up on files too large to parse quickly.
    const files = [...mcpConfigs.map((c) => c.file), ...(mcpOff ? [mcpOff.claudeJson, mcpOff.storeFile] : [])];
    for (const f of files) {
      let size = 0;
      try { size = fs.statSync(f).size; } catch { size = 0; }
      if (size > maxBytes) return null;
    }
    const loc = { mcpConfigs, mcpOff, installedPluginsFile: null, pluginCache: null, claudeSettingsFile: null };
    return JSON.stringify(scanMcp(loc, null).map((e) => [e.id, e.source, e.path, e.description, e.state]));
  } catch {
    return 'error';
  }
}
