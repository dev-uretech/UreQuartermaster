import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanPlugins } from '../skills/urequartermaster/scripts/lib/scan/plugins.mjs';
import { listClaudePlugins } from '../skills/urequartermaster/scripts/lib/scan/claude-plugins.mjs';

const write = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o)); };

function setup() {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qm-plug-')), 'home');
  const claude = path.join(home, '.claude');
  return {
    home,
    locations: {
      skillDirs: [],
      pluginCache: path.join(claude, 'plugins', 'cache'),
      installedPluginsFile: path.join(claude, 'plugins', 'installed_plugins.json'),
      claudeSettingsFile: path.join(claude, 'settings.json'),
    },
  };
}

test('listClaudePlugins: key, marketplace, resolved dir, enabled; cache fallback for stale path', () => {
  const s = setup();
  const c = s.locations.pluginCache;
  const a = path.join(c, 'mk', 'alpha', '2.0.0');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(path.join(c, 'mk', 'beta', '1.2.0'), { recursive: true });
  fs.mkdirSync(path.join(c, 'mk', 'beta', '1.10.0'), { recursive: true });
  write(s.locations.installedPluginsFile, { plugins: {
    'alpha@mk': [{ installPath: a }],
    'beta@mk': [{ installPath: path.join(c, 'mk', 'beta', 'gone') }],
    'ghost@mk': [{ installPath: path.join(c, 'nowhere') }],
  } });
  write(s.locations.claudeSettingsFile, { enabledPlugins: { 'alpha@mk': true, 'beta@mk': 'yes' } });
  assert.deepEqual(listClaudePlugins(s.locations), [
    { key: 'alpha@mk', plugin: 'alpha', marketplace: 'mk', dir: a, enabled: true },
    { key: 'beta@mk', plugin: 'beta', marketplace: 'mk', dir: path.join(c, 'mk', 'beta', '1.10.0'), enabled: false },
    { key: 'ghost@mk', plugin: 'ghost', marketplace: 'mk', dir: null, enabled: false },
  ]);
});

test('scanPlugins: one entry per plugin, description from manifest, state and usage', () => {
  const s = setup();
  const c = s.locations.pluginCache;
  const on = path.join(c, 'official', 'toolkit', '5.0.0');
  const off = path.join(c, 'official', 'github', '1.0.0');
  write(path.join(on, '.claude-plugin', 'plugin.json'), { name: 'toolkit', description: 'Core skills library', version: '5.0.0' });
  write(path.join(off, '.claude-plugin', 'plugin.json'), '{ not json');
  write(s.locations.installedPluginsFile, { plugins: { 'toolkit@official': [{ installPath: on }], 'github@official': [{ installPath: off }] } });
  write(s.locations.claudeSettingsFile, { env: { GITHUB_TOKEN: 'never-me-123' }, enabledPlugins: { 'toolkit@official': true } });
  const out = scanPlugins(s.locations);
  assert.deepEqual(out, [
    {
      id: 'plugin:toolkit', kind: 'plugin', name: 'toolkit', description: 'Core skills library', headings: [],
      path: path.join(on, '.claude-plugin', 'plugin.json'), source: 'claude', state: 'installed',
      usage: 'Plugin toolkit: skills appear as toolkit:<skill>',
    },
    {
      id: 'plugin:github', kind: 'plugin', name: 'github', description: 'Claude Code plugin github (official)', headings: [],
      path: path.join(off, '.claude-plugin', 'plugin.json'), source: 'claude', state: 'plugin-disabled', usage: 'claude plugin enable github@official',
    },
  ]);
  assert.ok(!JSON.stringify(out).includes('never-me-123'));
});

test('scanPlugins: cache-only discovery, non-string manifest description, nothing installed', () => {
  const s = setup();
  assert.deepEqual(scanPlugins(s.locations), []);
  const d = path.join(s.locations.pluginCache, 'mk', 'solo', '0.1.0');
  write(path.join(d, '.claude-plugin', 'plugin.json'), { description: { evil: true } });
  const out = scanPlugins(s.locations);
  assert.deepEqual(out.map((e) => [e.id, e.state, e.description]), [['plugin:solo', 'plugin-disabled', 'Claude Code plugin solo (mk)']]);
});

test('scanPlugins: same plugin name in two marketplaces -> distinct ids, later one marked duplicateOf', () => {
  const s = setup();
  const a = path.join(s.locations.pluginCache, 'm1', 'tool', '1.0.0');
  const b = path.join(s.locations.pluginCache, 'm2', 'tool', '1.0.0');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  write(s.locations.installedPluginsFile, { plugins: { 'tool@m1': [{ installPath: a }], 'tool@m2': [{ installPath: b }] } });
  const out = scanPlugins(s.locations);
  assert.deepEqual(out.map((e) => [e.id, e.duplicateOf]), [['plugin:tool', undefined], ['plugin:tool@m2', 'plugin:tool']]);
});

test('scanPlugins: a disabled plugin with an unsafe key gets no command line', () => {
  const s = setup();
  const off = path.join(s.locations.pluginCache, 'mk', 'bad', '1.0.0');
  write(path.join(off, '.claude-plugin', 'plugin.json'), { name: 'bad', description: 'x' });
  write(s.locations.installedPluginsFile, { plugins: { 'bad@m$(id)': [{ installPath: off }] } });
  write(s.locations.claudeSettingsFile, { enabledPlugins: {} });
  const out = scanPlugins(s.locations);
  assert.equal(out.length, 1);
  assert.equal(out[0].usage, 'disabled plugin');
});
