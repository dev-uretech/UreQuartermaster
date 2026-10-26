// Claude Code plugins as installed on disk: installed_plugins.json (or the plugin cache when it is
// missing) and the enabled flags of settings.json. Only `enabledPlugins` is read from settings.json,
// which may hold secrets next to it. Nothing here throws on missing or malformed files.
import path from 'node:path';
import { isDir, listDir, readJsonObject } from '../core/files.mjs';

function cmpVersion(a, b) {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x - +y; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const splitKey = (key) => {
  const i = key.lastIndexOf('@');
  return i < 0 ? { plugin: key, marketplace: null } : { plugin: key.slice(0, i), marketplace: key.slice(i + 1) };
};

// Highest version folder of cache/<marketplace>/<plugin>/, or null.
export function cacheLatest(cache, marketplace, plugin) {
  const pDir = path.join(cache, marketplace, plugin);
  const versions = listDir(pDir).filter((v) => isDir(path.join(pDir, v.name))).map((v) => v.name).sort(cmpVersion);
  return versions.length ? path.join(pDir, versions[versions.length - 1]) : null;
}

// -> [{ plugin, key, installPaths: string[] }]; installPaths are tried in order, per plugin.
export function pluginInstalls(locations) {
  const installed = readJsonObject(locations.installedPluginsFile);
  const out = [];
  if (installed && installed.plugins && typeof installed.plugins === 'object') {
    for (const [key, list] of Object.entries(installed.plugins)) {
      const { plugin, marketplace } = splitKey(key);
      const paths = (Array.isArray(list) ? list : []).filter((e) => e && typeof e.installPath === 'string').map((e) => e.installPath);
      out.push({ plugin, key, marketplace, installPaths: paths });
    }
    return out;
  }
  for (const m of listDir(locations.pluginCache)) {
    const mDir = path.join(locations.pluginCache, m.name);
    if (!isDir(mDir)) continue;
    for (const p of listDir(mDir)) {
      const latest = cacheLatest(locations.pluginCache, m.name, p.name);
      if (latest) out.push({ plugin: p.name, key: `${p.name}@${m.name}`, marketplace: m.name, installPaths: [latest] });
    }
  }
  return out;
}

export function enabledPlugins(file) {
  const s = readJsonObject(file);
  return s && s.enabledPlugins && typeof s.enabledPlugins === 'object' ? s.enabledPlugins : {};
}

// Claude Code plugins with their folder: first installPath that exists, else the
// highest cached version of that plugin, else null. Enabled only when exactly true.
// -> [{ key: '<plugin>@<marketplace>', plugin, marketplace, dir, enabled }]
export function listClaudePlugins(locations) {
  const enabled = enabledPlugins(locations.claudeSettingsFile);
  return pluginInstalls(locations).map(({ plugin, key, marketplace, installPaths }) => {
    let dir = installPaths.find((p) => isDir(p)) || null;
    if (!dir && marketplace) dir = cacheLatest(locations.pluginCache, marketplace, plugin);
    return { key, plugin, marketplace, dir, enabled: enabled[key] === true };
  });
}
