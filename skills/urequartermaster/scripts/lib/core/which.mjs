// Finds executables on PATH, like `which`, without running anything and without a shell.
// Only absolute PATH entries count: an empty or relative entry would mean the current folder,
// where a repository could plant its own `git` or `claude`.
import fs from 'node:fs';
import path from 'node:path';

// Windows ships an unrelated convert.exe (FAT -> NTFS), so ImageMagick is `magick` only there.
const WINDOWS_SKIP = new Set(['convert']);
/** A command name that is safe to look up: no path separators, no option-like first character. */
export const SAFE_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * Reads an environment variable. Windows names are case-insensitive, and an env object built as
 * { ...process.env, PATH: x } holds both "Path" and "PATH": child_process keeps the first of such
 * keys in sorted order, so this does the same and the PATH searched is the PATH the program gets.
 */
export function envGet(env, name, win) {
  if (!env || typeof env !== 'object') return undefined;
  if (!win) return env[name];
  const k = Object.keys(env).filter((x) => x.toUpperCase() === name).sort()[0];
  return k === undefined ? undefined : env[k];
}

/** Returns command -> absolute path of the first runnable match on PATH (PATHEXT on Windows), or null. */
export function makeResolver(env, platform) {
  const win = platform === 'win32';
  const raw = envGet(env, 'PATH', win);
  const dirs = (typeof raw === 'string' ? raw : '')
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d && path.isAbsolute(d)); // empty or relative entries would mean the current folder
  const extRaw = envGet(env, 'PATHEXT', win);
  const exts = (typeof extRaw === 'string' && extRaw ? extRaw : '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim()).filter((e) => e.startsWith('.'));

  const isRunnable = (file) => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      if (!win) fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch { return false; }
  };

  return (command) => {
    if (!SAFE_COMMAND_NAME.test(command) || (win && WINDOWS_SKIP.has(command))) return null;
    for (const d of dirs) {
      const names = win ? exts.flatMap((e) => [command + e.toLowerCase(), command + e.toUpperCase()]) : [command];
      for (const n of names) {
        const f = path.join(d, n);
        if (isRunnable(f)) return f;
      }
    }
    return null;
  };
}

/**
 * Absolute path of a program qm itself runs (git, claude). On Windows only a real .exe counts:
 * a .bat or .cmd cannot be started without a shell, and qm never uses one.
 */
export function findExe(name, env, platform) {
  const rest = Object.fromEntries(Object.entries(env || {}).filter(([k]) => k.toUpperCase() !== 'PATHEXT'));
  return makeResolver({ ...rest, PATHEXT: '.EXE' }, platform)(name);
}
