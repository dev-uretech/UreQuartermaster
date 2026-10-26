import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { dataDir, agentLocations, skillReaders } from '../skills/urequartermaster/scripts/lib/core/paths.mjs';

const homes = { win32: 'C:\\Users\\Ana Rossi', darwin: '/Users/ana', linux: '/home/ana' };
const cwds = { win32: 'C:\\work\\proj', darwin: '/Users/ana/proj', linux: '/home/ana/proj' };
const P = (pl) => (pl === 'win32' ? path.win32 : path.posix);

function locs(platform, env = {}) {
  return agentLocations({ home: homes[platform], platform, env, cwd: cwds[platform] });
}

test('dataDir honors UREQM_HOME and defaults to ~/.urequartermaster', () => {
  assert.equal(dataDir({ UREQM_HOME: '/x/y' }), '/x/y');
  assert.ok(dataDir({}).endsWith('.urequartermaster'));
});

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`agentLocations on ${platform}`, () => {
    const p = P(platform);
    const h = homes[platform];
    const cwd = cwds[platform];
    const l = locs(platform);
    const skill = (dir, source) => l.skillDirs.some((s) => s.dir === dir && s.source === source);
    assert.ok(skill(p.join(h, '.claude', 'skills'), 'claude'));
    assert.ok(skill(p.join(h, '.agents', 'skills'), 'agents'));
    assert.ok(skill(p.join(h, '.codex', 'skills'), 'codex'));
    assert.ok(skill(p.join(cwd, '.claude', 'skills'), 'project'));
    assert.ok(skill(p.join(cwd, '.agents', 'skills'), 'project'));

    const mcp = (file, pick) => l.mcpConfigs.some((m) => m.file === file && m.pick === pick);
    assert.ok(mcp(p.join(h, '.claude.json'), 'mcpServers'));
    assert.ok(mcp(p.join(h, '.claude.json'), `projects[${cwd}].mcpServers`));
    assert.ok(mcp(p.join(cwd, '.mcp.json'), 'mcpServers'));
    const codex = l.mcpConfigs.find((m) => m.file === p.join(h, '.codex', 'config.toml'));
    assert.equal(codex.format, 'toml');
    assert.equal(codex.pick, 'mcp_servers');
    assert.ok(mcp(p.join(h, '.gemini', 'settings.json'), 'mcpServers'));
    assert.ok(mcp(p.join(h, '.cursor', 'mcp.json'), 'mcpServers'));
    assert.ok(mcp(p.join(h, '.copilot', 'mcp-config.json'), 'mcpServers'));
    const vsDir = { win32: p.join(h, 'AppData', 'Roaming', 'Code', 'User'), darwin: p.join(h, 'Library', 'Application Support', 'Code', 'User'), linux: p.join(h, '.config', 'Code', 'User') }[platform];
    assert.ok(l.mcpConfigs.some((m) => m.file === p.join(vsDir, 'mcp.json') && m.agent === 'vscode'));

    const ins = (file) => l.instructionFiles.some((i) => i.file === file);
    assert.ok(ins(p.join(h, '.claude', 'CLAUDE.md')));
    assert.ok(ins(p.join(h, '.codex', 'AGENTS.md')));
    assert.ok(ins(p.join(h, '.gemini', 'GEMINI.md')));

    assert.equal(l.pluginCache, p.join(h, '.claude', 'plugins', 'cache'));
    assert.equal(l.installedPluginsFile, p.join(h, '.claude', 'plugins', 'installed_plugins.json'));
    assert.equal(l.claudeSettingsFile, p.join(h, '.claude', 'settings.json'));
    assert.equal(l.skillsLockFile, p.join(h, '.agents', '.skill-lock.json'));
  });
}

test('windows VS Code dir uses APPDATA when set', () => {
  const l = locs('win32', { APPDATA: 'D:\\Roam' });
  assert.ok(l.mcpConfigs.some((m) => m.file === 'D:\\Roam\\Code\\User\\mcp.json'));
});

test('CODEX_HOME overrides codex locations', () => {
  const l = locs('linux', { CODEX_HOME: '/opt/codex' });
  assert.ok(l.skillDirs.some((s) => s.dir === '/opt/codex/skills' && s.source === 'codex'));
  assert.ok(l.mcpConfigs.some((m) => m.file === '/opt/codex/config.toml'));
  assert.ok(l.instructionFiles.some((i) => i.file === '/opt/codex/AGENTS.md'));
  assert.ok(!l.skillDirs.some((s) => s.dir === '/home/ana/.codex/skills'));
});

test('CLAUDE_CONFIG_DIR moves skills, plugins, settings and .claude.json', () => {
  const l = locs('linux', { CLAUDE_CONFIG_DIR: '/cfg/claude' });
  assert.ok(l.skillDirs.some((s) => s.dir === '/cfg/claude/skills' && s.source === 'claude'));
  assert.ok(l.mcpConfigs.some((m) => m.file === '/cfg/claude/.claude.json'));
  assert.equal(l.pluginCache, '/cfg/claude/plugins/cache');
  assert.equal(l.installedPluginsFile, '/cfg/claude/plugins/installed_plugins.json');
  assert.equal(l.claudeSettingsFile, '/cfg/claude/settings.json');
  assert.ok(l.instructionFiles.some((i) => i.file === '/cfg/claude/CLAUDE.md'));
});

test('XDG_CONFIG_HOME is honored on linux only', () => {
  const lin = locs('linux', { XDG_CONFIG_HOME: '/xdg' });
  assert.ok(lin.mcpConfigs.some((m) => m.file === '/xdg/Code/User/mcp.json'));
  assert.ok(lin.skillDirs.some((s) => s.dir === '/xdg/opencode/skills' && s.source === 'opencode'));
  const mac = locs('darwin', { XDG_CONFIG_HOME: '/xdg' });
  assert.ok(!mac.mcpConfigs.some((m) => m.file.startsWith('/xdg')));
});

test('every location is absolute and entries are unique', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const l = locs(platform);
    const abs = P(platform).isAbsolute;
    for (const s of l.skillDirs) assert.ok(abs(s.dir), s.dir);
    for (const m of l.mcpConfigs) assert.ok(abs(m.file), m.file);
    const keys = l.skillDirs.map((s) => s.dir);
    assert.equal(new Set(keys).size, keys.length);
  }
});

test('a relative UREQM_HOME is ignored: data never lands in whatever folder the agent is in', () => {
  const def = dataDir({});
  for (const v of ['data', './data', '..', '']) assert.equal(dataDir({ UREQM_HOME: v }), def, JSON.stringify(v));
});

function readers(platform, env = {}) {
  return Object.fromEntries(skillReaders({ home: homes[platform], platform, env, cwd: cwds[platform] }).map((r) => [r.agent, r]));
}

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`skillReaders on ${platform}: which folders each agent reads`, () => {
    const p = P(platform);
    const h = homes[platform];
    const cwd = cwds[platform];
    const r = readers(platform);
    const dirs = (a) => r[a].dirs.map((d) => d.dir);
    // Claude Code: its own folder, the project's .claude/skills and its plugins; never ~/.agents or ~/.codex.
    assert.deepEqual(dirs('claude'), [p.join(h, '.claude', 'skills'), p.join(cwd, '.claude', 'skills')]);
    assert.equal(r.claude.plugins, true);
    assert.equal(r.claude.home, p.join(h, '.claude'));
    // Codex: ~/.agents/skills, the legacy CODEX_HOME/skills and the project's .agents/skills.
    assert.deepEqual(dirs('codex'), [p.join(h, '.agents', 'skills'), p.join(h, '.codex', 'skills'), p.join(cwd, '.agents', 'skills')]);
    assert.equal(r.codex.plugins, false);
    assert.deepEqual(dirs('gemini'), [p.join(h, '.gemini', 'skills')]);
    assert.ok(dirs('opencode').includes(p.join(h, '.claude', 'skills')) && dirs('opencode').includes(p.join(h, '.agents', 'skills')));
    for (const a of Object.values(r)) {
      assert.ok(a.label && P(platform).isAbsolute(a.home));
      for (const d of a.dirs) {
        assert.ok(P(platform).isAbsolute(d.dir), d.dir);
        assert.equal(d.source === 'project', d.dir.startsWith(cwd), d.dir);
      }
    }
  });
}

test('skillReaders follow CLAUDE_CONFIG_DIR and CODEX_HOME (Windows paths)', () => {
  const r = readers('win32', { CLAUDE_CONFIG_DIR: 'D:\\cfg\\claude', CODEX_HOME: 'D:\\codex' });
  assert.equal(r.claude.dirs[0].dir, 'D:\\cfg\\claude\\skills');
  assert.equal(r.claude.home, 'D:\\cfg\\claude');
  assert.ok(r.codex.dirs.some((d) => d.dir === 'D:\\codex\\skills'));
  assert.equal(r.codex.home, 'D:\\codex');
  assert.ok(!r.claude.dirs.some((d) => /\\\.agents\\/.test(d.dir)));
});
