// Where each agent keeps its skills, MCP config and instruction files.
// agentLocations() is pure: everything comes from its arguments, and the path
// flavour follows `platform`, so Windows paths can be tested on any OS.
import os from 'node:os';
import path from 'node:path';

/** UREQM_HOME when it is an absolute path (a relative one would follow the current folder), else ~/.urequartermaster. */
export function dataDir(env = process.env) {
  const h = env.UREQM_HOME;
  return typeof h === 'string' && h && path.isAbsolute(h) ? h : path.join(os.homedir(), '.urequartermaster');
}

export function agentLocations({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const j = (...a) => p.join(...a);

  const claudeDir = env.CLAUDE_CONFIG_DIR || j(home, '.claude');
  // Claude Code keeps .claude.json inside CLAUDE_CONFIG_DIR when set, else in ~.
  const claudeJson = env.CLAUDE_CONFIG_DIR ? j(env.CLAUDE_CONFIG_DIR, '.claude.json') : j(home, '.claude.json');
  const codexDir = env.CODEX_HOME || j(home, '.codex');
  const geminiDir = j(home, '.gemini');
  const copilotDir = j(home, '.copilot');
  const xdg = platform === 'linux' && env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : j(home, '.config');
  const opencodeDir = j(xdg, 'opencode'); // OpenCode uses ~/.config/opencode on every OS

  let vsUser;
  if (platform === 'win32') vsUser = j(env.APPDATA || j(home, 'AppData', 'Roaming'), 'Code', 'User');
  else if (platform === 'darwin') vsUser = j(home, 'Library', 'Application Support', 'Code', 'User');
  else vsUser = j(xdg, 'Code', 'User');

  const skillDirs = [
    { dir: j(claudeDir, 'skills'), source: 'claude' },
    { dir: j(home, '.agents', 'skills'), source: 'agents' },
    { dir: j(codexDir, 'skills'), source: 'codex' },
    { dir: j(geminiDir, 'skills'), source: 'gemini' },
    { dir: j(opencodeDir, 'skills'), source: 'opencode' },
    { dir: j(cwd, '.claude', 'skills'), source: 'project' },
    { dir: j(cwd, '.agents', 'skills'), source: 'project' },
  ];
  // Not included (path not verified against current docs): Cursor and Copilot skill folders.

  const mcpConfigs = [
    { file: claudeJson, format: 'json', agent: 'claude', pick: 'mcpServers' },
    { file: claudeJson, format: 'json', agent: 'claude', pick: `projects[${cwd}].mcpServers` },
    { file: j(cwd, '.mcp.json'), format: 'json', agent: 'claude', pick: 'mcpServers' },
    { file: j(codexDir, 'config.toml'), format: 'toml', agent: 'codex', pick: 'mcp_servers' },
    { file: j(geminiDir, 'settings.json'), format: 'json', agent: 'gemini', pick: 'mcpServers' },
    { file: j(home, '.cursor', 'mcp.json'), format: 'json', agent: 'cursor', pick: 'mcpServers' },
    { file: j(cwd, '.cursor', 'mcp.json'), format: 'json', agent: 'cursor', pick: 'mcpServers' },
    // VS Code user mcp.json: top-level key is "servers" in current VS Code releases.
    { file: j(vsUser, 'mcp.json'), format: 'json', agent: 'vscode', pick: 'servers' },
    { file: j(copilotDir, 'mcp-config.json'), format: 'json', agent: 'copilot', pick: 'mcpServers' },
    // OpenCode: servers live under "mcp" (different entry shape: command is an array).
    { file: j(opencodeDir, 'opencode.json'), format: 'json', agent: 'opencode', pick: 'mcp' },
  ];

  const instructionFiles = [
    { file: j(claudeDir, 'CLAUDE.md'), agent: 'claude' },
    { file: j(codexDir, 'AGENTS.md'), agent: 'codex' },
    { file: j(geminiDir, 'GEMINI.md'), agent: 'gemini' },
    { file: j(copilotDir, 'copilot-instructions.md'), agent: 'copilot' },
    { file: j(opencodeDir, 'AGENTS.md'), agent: 'opencode' },
  ];

  return {
    skillDirs,
    mcpConfigs,
    instructionFiles,
    pluginCache: j(claudeDir, 'plugins', 'cache'),
    installedPluginsFile: j(claudeDir, 'plugins', 'installed_plugins.json'),
    claudeSettingsFile: j(claudeDir, 'settings.json'), // enabledPlugins lives here
    skillsLockFile: j(home, '.agents', '.skill-lock.json'),
  };
}
