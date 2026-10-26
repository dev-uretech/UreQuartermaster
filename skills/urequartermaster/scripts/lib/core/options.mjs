// The environment a command runs in: home, platform, env, cwd, data folder and clock.
// Every field can be overridden, so tests run against fake homes without touching the real one.
import os from 'node:os';
import { dataDir as defaultDataDir } from './paths.mjs';

export function resolveOptions(opts = {}) {
  const env = opts.env || process.env;
  return {
    home: opts.home || os.homedir(),
    platform: opts.platform || process.platform,
    env,
    cwd: opts.cwd || process.cwd(),
    dataDir: opts.dataDir || defaultDataDir(env),
    now: typeof opts.now === 'number' ? opts.now : Date.now(),
  };
}
