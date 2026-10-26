// The index: one JSON file (index.json) with every global skill, MCP server, plugin and CLI found.
// It is rebuilt when it is missing, of another version, older than maxIndexAgeHours, or when the
// fingerprint of what it was built from changed. The current project's entries are added on read
// (ensureIndex) and never saved. The hook reads it with loadIndex/isStale and never rebuilds it.
import fs from 'node:fs';
import path from 'node:path';
import { resolveOptions as resolve } from '../core/options.mjs';
import { writeFileAtomic } from '../core/files.mjs';
import { loadConfig } from '../core/config.mjs';
import { scanSkills } from '../scan/skills.mjs';
import { scanMcp } from '../scan/mcp.mjs';
import { scanPlugins } from '../scan/plugins.mjs';
import { scanCli } from '../scan/cli-tools.mjs';
import { splitLocations } from './locations.mjs';
import { computeFingerprint, sameFingerprint } from './fingerprint.mjs';
import { scanProject, withProject } from './project.mjs';

/** @typedef {{
 *  id: string,            // "<kind>:<name>" or "<kind>:<plugin>:<name>" on conflict
 *  kind: 'skill'|'mcp'|'plugin'|'cli',
 *  name: string, description: string, headings: string[],
 *  path: string|null,     // SKILL.md, config file or executable
 *  source: string,        // e.g. 'claude', 'agents', 'codex', 'plugin:<name>', 'library:<collection>', 'project'
 *  state: 'installed'|'library'|'plugin-disabled'|'available',
 *  usage: string,         // how to use it: "Skill tool: <name>", "qm load <name>", "MCP server <name>", "<command> --help"
 *  duplicateOf?: string   // id of the entry this one shadows; kept in the index for doctor, skipped by search
 * }} Entry */

/** @typedef {{ version: 2, builtAt: string, fingerprint: string, entries: Entry[] }} Index */

const INDEX_FILE = 'index.json';
// 2: skill names are validated at scan time; an older index may hold unsafe names and is rebuilt.
export const INDEX_VERSION = 2;

/** @returns {Index} Global entries only; project entries come from scanProject. */
export function buildIndex(opts = {}) {
  const r = resolve(opts);
  // Fingerprint first: a change landing mid-scan then makes the index stale, not silently missing.
  const fingerprint = computeFingerprint(r);
  const loc = splitLocations(r).global;
  const config = loadConfig(r.dataDir);
  const entries = [
    ...scanSkills(loc, { dataDir: r.dataDir, config }),
    ...scanMcp(loc, config),
    ...scanPlugins(loc),
    ...scanCli(config, r.env, { platform: r.platform }),
  ];
  return { version: INDEX_VERSION, builtAt: new Date().toISOString(), fingerprint, entries };
}

export function saveIndex(dir, idx) {
  writeFileAtomic(path.join(dir, INDEX_FILE), JSON.stringify(idx));
}

/** @returns {Index|null} null when missing, corrupt or of another version. */
export function loadIndex(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8'));
    if (!v || v.version !== INDEX_VERSION || typeof v.builtAt !== 'string'
      || typeof v.fingerprint !== 'string' || !Array.isArray(v.entries)) return null;
    return v;
  } catch {
    return null;
  }
}

export function isStale(idx, opts = {}) {
  if (!idx) return true;
  const r = resolve(opts);
  const built = Date.parse(idx.builtAt);
  if (Number.isNaN(built)) return true;
  const maxAge = loadConfig(r.dataDir).maxIndexAgeHours * 3600e3;
  if (r.now - built > maxAge) return true;
  return !sameFingerprint(idx.fingerprint, computeFingerprint({ ...r, mcpMaxBytes: opts.mcpMaxBytes }));
}

export function ensureIndex(opts = {}, { allowRebuild = true } = {}) {
  const r = resolve(opts);
  let idx = loadIndex(r.dataDir);
  if ((!idx || isStale(idx, r)) && allowRebuild) {
    idx = buildIndex(r);
    try { saveIndex(r.dataDir, idx); } catch { /* read-only data dir: still serve it */ }
  }
  const project = scanProject(r);
  if (idx) return withProject(idx, project);
  if (!project.length) return null;
  return { version: INDEX_VERSION, builtAt: null, fingerprint: null, entries: project };
}
