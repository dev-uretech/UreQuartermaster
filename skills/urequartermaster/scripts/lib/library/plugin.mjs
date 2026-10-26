// `qm park --plugin`: disables a Claude Code plugin with `claude plugin disable`. The command is only
// printed unless the user passes --yes; when run, claude is resolved from PATH only (never the project
// folder), started without a shell, and for project/local installs only inside their recorded project.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { agentLocations } from '../core/paths.mjs';
import { resolveOptions as resolve } from '../core/options.mjs';
import { isDir, readJsonObject } from '../core/files.mjs';
import { findExe } from '../core/which.mjs';
import { listClaudePlugins } from '../scan/claude-plugins.mjs';

const CLAUDE_TIMEOUT_MS = 120_000;
const findClaude = (env, platform) => findExe('claude', env, platform);

// Scope of an install ('project', 'local'...) when no user-scope install exists, with its projectPath.
function pluginScope(file, key) {
  try {
    const doc = readJsonObject(file);
    const list = Array.isArray(doc?.plugins?.[key]) ? doc.plugins[key] : [];
    if (!list.length || list.some((e) => e && (e.scope === 'user' || e.scope === undefined))) return null;
    const e = list.find((x) => x && typeof x.scope === 'string' && /^[a-z]+$/.test(x.scope));
    return e ? { scope: e.scope, projectPath: typeof e.projectPath === 'string' ? e.projectPath : null } : null;
  } catch { return null; }
}

/**
 * `claude plugin disable <plugin>@<marketplace>`: printed by default, run only with opts.yes (no shell).
 * For project/local installs it runs in the install's projectPath, and not at all without one.
 * `opts._deps.spawn` is a test-only hook.
 * @returns {{command:string, ok:boolean, ran:boolean, cwd?:string, error?:string}}
 */
export function parkPlugin(pluginName, opts = {}) {
  const r = resolve(opts);
  const agent = opts.agent || 'claude';
  if (agent !== 'claude') throw new Error('Only the claude agent is supported: parking a plugin uses the "claude plugin" command.');
  const loc = agentLocations(r);
  const want = String(pluginName).toLowerCase();
  const found = listClaudePlugins(loc).filter((p) => p.plugin.toLowerCase() === want || p.key.toLowerCase() === want);
  if (!found.length) throw new Error(`No plugin named "${pluginName}" is installed for Claude Code.`);
  const pick = found.find((p) => p.enabled) || found[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]*$/.test(pick.key)) throw new Error(`Plugin key "${pick.key}" has unexpected characters: refusing to build a command.`);
  const sc = pluginScope(loc.installedPluginsFile, pick.key);
  const args = ['plugin', 'disable', pick.key, ...(sc ? ['--scope', sc.scope] : [])];
  const command = `claude ${args.join(' ')}`;
  const cwd = sc && sc.projectPath ? sc.projectPath : undefined;
  if (!opts.yes) return { command, ok: true, ran: false, ...(cwd ? { cwd } : {}) };
  if (sc && !(cwd && path.isAbsolute(cwd) && isDir(cwd))) {
    return { command, ok: false, ran: false, error: `this ${sc.scope}-scope install has no usable projectPath in installed_plugins.json: run the command from that project's folder` };
  }
  // Resolved from PATH only (absolute entries, .exe on Windows): never the project folder we run in.
  const exe = findClaude(r.env, r.platform);
  if (!exe) return { command, ok: false, ran: false, ...(cwd ? { cwd } : {}), error: 'claude was not found on PATH' };
  const spawn = opts._deps?.spawn || spawnSync;
  const res = spawn(exe, args, { shell: false, encoding: 'utf8', timeout: CLAUDE_TIMEOUT_MS, windowsHide: true, env: r.env, ...(cwd ? { cwd } : {}) });
  if (res.error) {
    // ENOENT: not on PATH. EINVAL: Windows will not start claude.cmd without a shell, and we never use one.
    const why = ['ENOENT', 'EINVAL'].includes(res.error.code) ? 'claude could not be started without a shell' : res.error.message;
    return { command, ok: false, ran: false, ...(cwd ? { cwd } : {}), error: why };
  }
  return { command, ok: res.status === 0, ran: true, ...(cwd ? { cwd } : {}), ...(res.status === 0 ? {} : { error: `${res.stderr || ''}`.trim().split(/\r?\n/).pop() || `exit code ${res.status}` }) };
}
