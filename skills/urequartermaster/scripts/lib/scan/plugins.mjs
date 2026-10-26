// Claude Code plugins: one entry per installed plugin, described by its manifest.
// Only `description` is read from .claude-plugin/plugin.json.
import fs from 'node:fs';
import path from 'node:path';
import { listClaudePlugins } from './claude-plugins.mjs';
import { isSafeName } from './trust.mjs';
import { readJsonObject } from '../core/files.mjs';

// "name@marketplace" from installed_plugins.json goes into a command line: each part must be shell-inert
const isSafePluginKey = (k) => typeof k === 'string' && k.split('@').length <= 2 && k.split('@').every(isSafeName);

const MAX_DESCRIPTION = 500;

function manifestDescription(file) {
  const v = readJsonObject(file);
  const d = v && typeof v.description === 'string' ? v.description.trim() : '';
  return d ? d.replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION) : null;
}

export function scanPlugins(locations) {
  let plugins;
  try { plugins = listClaudePlugins(locations); } catch { return []; }
  const seen = new Set();
  return plugins.map(({ key, plugin, marketplace, dir, enabled }) => {
    const manifest = dir ? path.join(dir, '.claude-plugin', 'plugin.json') : null;
    const hasManifest = manifest !== null && fs.existsSync(manifest);
    const description = (hasManifest && manifestDescription(manifest))
      || (marketplace ? `Claude Code plugin ${plugin} (${marketplace})` : `Claude Code plugin ${plugin}`);
    const base = `plugin:${plugin}`;
    const dup = seen.has(base);
    seen.add(base);
    const entry = {
      id: dup ? `${base}@${marketplace || key}` : base,
      kind: 'plugin',
      name: plugin,
      description,
      headings: [],
      path: hasManifest ? manifest : dir,
      source: 'claude',
      state: enabled ? 'installed' : 'plugin-disabled',
      usage: enabled ? `Plugin ${plugin}: skills appear as ${plugin}:<skill>` : isSafePluginKey(key) ? `claude plugin enable ${key}` : 'disabled plugin',
    };
    return dup ? { ...entry, duplicateOf: base } : entry;
  });
}
