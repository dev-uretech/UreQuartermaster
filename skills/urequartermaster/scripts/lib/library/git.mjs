// Runs git for the library. git is resolved to an absolute path from PATH only and never through a
// shell; it runs from the temp folder with hooks, symlinks, the ext protocol and submodules off, and
// never prompts for credentials. Errors carry only git's last stderr line.
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { findExe } from '../core/which.mjs';

const GIT_TIMEOUT_MS = 120_000;

function gitBase(platform) {
  const nul = platform === 'win32' ? 'NUL' : '/dev/null';
  return ['-c', 'core.symlinks=false', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=user', '-c', `core.hooksPath=${nul}`,
    '-c', 'core.fsmonitor=false', '-c', 'transfer.fsckObjects=true', '-c', 'submodule.recurse=false'];
}

export function runGit(r, args) {
  // Absolute path from PATH only (never the current folder, never .BAT/.CMD on Windows), run
  // from the temp folder: a git.exe planted in the user's project must not be the one that runs.
  const exe = findExe('git', r.env, r.platform);
  if (!exe) return { ok: false, out: '', err: 'git is not installed or not on PATH' };
  const res = spawnSync(exe, [...gitBase(r.platform), ...args], {
    shell: false,
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    env: { ...r.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' },
  });
  if (res.error) {
    const why = res.error.code === 'ENOENT' ? 'git is not installed or not on PATH'
      : res.error.code === 'ETIMEDOUT' ? `timed out after ${GIT_TIMEOUT_MS / 1000} s` : res.error.message;
    return { ok: false, out: '', err: why };
  }
  const err = `${res.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || `exit code ${res.status}`;
  return { ok: res.status === 0, out: `${res.stdout || ''}`.trim(), err };
}
