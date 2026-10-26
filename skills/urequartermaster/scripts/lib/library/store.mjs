// Where the library lives on disk: <dataDir>/library/<collection> and <dataDir>/library/_parked/<skill>.
// The library folder and the parked folder must not be symbolic links. Every change to the library
// ends with an index rebuild, so search sees it at once.
import fs from 'node:fs';
import path from 'node:path';
import { safe, lstat } from '../core/files.mjs';
import { buildIndex, saveIndex } from '../index/index.mjs';

const PARKED = '_parked';

export function rebuild(r) {
  const idx = buildIndex(r);
  saveIndex(r.dataDir, idx);
  return idx;
}

export function ensureLibrary(r) {
  const lib = path.join(r.dataDir, 'library');
  if (lstat(lib)?.isSymbolicLink()) throw new Error(`${lib} is a symbolic link: refusing to use it.`);
  fs.mkdirSync(lib, { recursive: true });
  // Leftovers of an interrupted clone.
  for (const n of safe(() => fs.readdirSync(lib), [])) {
    if (!n.startsWith('.tmp-')) continue;
    const p = path.join(lib, n);
    const st = lstat(p);
    if (st && Date.now() - st.mtimeMs > 3600_000) safe(() => fs.rmSync(p, { recursive: true, force: true }), null);
  }
  return lib;
}

export function parkedPath(r, name) {
  return path.join(r.dataDir, 'library', PARKED, name);
}

export function prepareParkedRoot(r) {
  const lib = ensureLibrary(r);
  const pk = path.join(lib, PARKED);
  if (lstat(pk)?.isSymbolicLink()) throw new Error(`${pk} is a symbolic link: refusing to use it.`);
  fs.mkdirSync(pk, { recursive: true });
}
