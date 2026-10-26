// Splits the agents' locations into global (personal, indexed and saved) and project-scoped
// (derived from cwd, scanned live and never saved). The split never treats "anything inside cwd"
// as project: cwd may be the home folder or one of its ancestors.
import fs from 'node:fs';
import path from 'node:path';
import { agentLocations } from '../core/paths.mjs';

function canon(platform, file) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let f = p.resolve(file);
  try { f = fs.realpathSync(f); } catch { /* not there yet: compare the resolved path */ }
  return f;
}

// Project-scoped locations are only the ones derived from cwd: skill dirs tagged
// 'project' (unless they are the same folder as a global one, e.g. cwd == home),
// <cwd>/.mcp.json, <cwd>/.cursor/mcp.json and the projects[...] block of .claude.json.
// Never "anything inside cwd": cwd may be home or one of its ancestors.
export function splitLocations(r) {
  const loc = agentLocations(r);
  const p = r.platform === 'win32' ? path.win32 : path.posix;
  const projectFiles = new Set([p.join(r.cwd, '.mcp.json'), p.join(r.cwd, '.cursor', 'mcp.json')]);
  // Files that are global whatever cwd is (cwd == home makes ~/.cursor/mcp.json look like a project file).
  const sentinel = p.join(r.cwd, '\u0000no-such-dir');
  const probe = agentLocations({ ...r, cwd: sentinel });
  const probeProject = new Set([p.join(sentinel, '.mcp.json'), p.join(sentinel, '.cursor', 'mcp.json')]);
  const globalFiles = new Set(probe.mcpConfigs
    .filter((m) => !String(m.pick).startsWith('projects[') && !probeProject.has(m.file)).map((m) => m.file));
  const globalDirs = new Set(loc.skillDirs.filter((s) => s.source !== 'project').map((s) => canon(r.platform, s.dir)));
  const isProjectMcp = (m) => String(m.pick).startsWith('projects[') || (projectFiles.has(m.file) && !globalFiles.has(m.file));
  const isProjectSkill = (s) => s.source === 'project' && !globalDirs.has(canon(r.platform, s.dir));
  const global = {
    ...loc,
    skillDirs: loc.skillDirs.filter((s) => !isProjectSkill(s)),
    mcpConfigs: loc.mcpConfigs.filter((m) => !isProjectMcp(m)),
  };
  const project = {
    skillDirs: loc.skillDirs.filter(isProjectSkill),
    mcpConfigs: loc.mcpConfigs.filter(isProjectMcp),
  };
  return { global, project, claudeJson: loc.mcpConfigs.find((m) => m.pick === 'mcpServers' && m.agent === 'claude')?.file, projectMcpFile: p.join(r.cwd, '.mcp.json') };
}
