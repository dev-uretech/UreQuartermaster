// Fingerprint of what the index was built from, to tell when it is stale without rescanning.
// Never throws: on any error it returns a fingerprint that matches nothing, forcing a rebuild.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveOptions as resolve } from '../core/options.mjs';
import { enabledPlugins } from '../scan/claude-plugins.mjs';
import { mcpFingerprint } from '../scan/mcp.mjs';
import { splitLocations } from './locations.mjs';

function mtimeOf(p) {
  try { return String(fs.statSync(p).mtimeMs); } catch { return 'missing'; }
}

function childDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => path.join(dir, d.name));
  } catch { return []; }
}

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

/**
 * "<paths>.<mcp>", two SHA-256: sorted "path|mtimeMs" of the watched global skill paths (with
 * `enabledPlugins` of Claude's settings.json), and the MCP servers as they would be indexed.
 * The MCP part is by content, not mtime: Claude Code saves ~/.claude.json on almost every tool
 * call. With `mcpMaxBytes`, an MCP file larger than that is not parsed and the MCP part is '*'
 * (unchecked). Never throws.
 */
export function computeFingerprint(opts = {}) {
  try {
    const r = resolve(opts);
    const loc = splitLocations(r).global;
    const watched = new Set();
    const addTree = (dir) => {
      watched.add(dir);
      for (const c of childDirs(dir)) { watched.add(c); watched.add(path.join(c, 'SKILL.md')); }
    };
    for (const s of loc.skillDirs) addTree(s.dir);
    watched.add(loc.installedPluginsFile);
    addTree(path.join(r.dataDir, 'library'));
    watched.add(path.join(r.dataDir, 'config.json'));
    const lines = [...watched].sort().map((p) => `${p}|${mtimeOf(p)}`);
    lines.push(`enabledPlugins|${JSON.stringify(enabledPlugins(loc.claudeSettingsFile))}`);
    const mcp = mcpFingerprint(loc.mcpConfigs, { maxBytes: opts.mcpMaxBytes ?? Infinity });
    return `${sha(lines.join('\n'))}.${mcp === null ? '*' : sha(mcp)}`;
  } catch {
    return `${sha('error')}.${sha('error')}`;
  }
}

/** True when `current` (maybe with an unchecked '*' MCP part) matches the stored fingerprint. */
export function sameFingerprint(stored, current) {
  if (stored === current) return true;
  const [sp, sm] = String(stored).split('.');
  const [cp, cm] = String(current).split('.');
  return sp === cp && sm !== undefined && cm === '*';
}
