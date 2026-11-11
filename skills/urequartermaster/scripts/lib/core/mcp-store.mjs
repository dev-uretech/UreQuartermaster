// The parked MCP store (<dataDir>/parked-mcp.json): every MCP server definition qm took off Claude Code's user
// scope, kept whole so it can be restored or enabled again, plus the projects where `qm mcp enable` added a copy.
// The definitions can hold credentials (env, headers), so the file is written with mode 0600 and its content is
// never printed: callers show names, scopes and transports only. Loading never throws.
import fs from 'node:fs';
import path from 'node:path';
import { isObj, readJsonObject } from './files.mjs';

export const STORE_FILE = 'parked-mcp.json';
export const STORE_VERSION = 1;

/** Server names qm puts on a command line (`qm mcp enable <name>`): shell-inert, never an option. */
export const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const isSafeMcpName = (n) => typeof n === 'string' && MCP_NAME_RE.test(n);

export const storePath = (dataDir) => path.join(dataDir, STORE_FILE);

/**
 * @typedef {{ definition: object, from: 'user'|'local', fromProject?: string, parkedAt: string }} ParkedServer
 * @typedef {{ version: 1, servers: Record<string, ParkedServer>, enabled: Record<string, string[]> }} Store
 */

/** @returns {Store} An empty store when the file is missing, corrupt or of another version. */
export function loadStore(dataDir) {
  const empty = { version: STORE_VERSION, servers: {}, enabled: {} };
  const raw = readJsonObject(storePath(dataDir));
  if (!raw || raw.version !== STORE_VERSION) return empty;
  const servers = {};
  if (isObj(raw.servers)) {
    for (const [name, s] of Object.entries(raw.servers)) {
      if (!isObj(s) || !isObj(s.definition)) continue;
      servers[name] = {
        definition: s.definition,
        from: s.from === 'local' ? 'local' : 'user',
        ...(typeof s.fromProject === 'string' ? { fromProject: s.fromProject } : {}),
        parkedAt: typeof s.parkedAt === 'string' ? s.parkedAt : '',
      };
    }
  }
  const enabled = {};
  if (isObj(raw.enabled)) {
    for (const [name, list] of Object.entries(raw.enabled)) {
      if (!Array.isArray(list)) continue;
      const l = [...new Set(list.filter((x) => typeof x === 'string' && x))];
      if (l.length) enabled[name] = l;
    }
  }
  return { version: STORE_VERSION, servers, enabled };
}

/** Writes `text` to `file` through a 0600 temporary file and one rename; the result is 0600 too. */
export function writePrivateAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try { fs.chmodSync(tmp, 0o600); } catch { /* Windows: modes are not POSIX */ }
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

export function saveStore(dataDir, store) {
  const clean = { version: STORE_VERSION, servers: store.servers || {}, enabled: {} };
  for (const [k, v] of Object.entries(store.enabled || {})) if (Array.isArray(v) && v.length) clean.enabled[k] = v;
  writePrivateAtomic(storePath(dataDir), `${JSON.stringify(clean, null, 2)}\n`);
}
