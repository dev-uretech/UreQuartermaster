// Shared fixtures for the bundle/update tests (no tests in here).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

export function fakeSkill(dir, version = '1.0.0') {
  write(path.join(dir, 'SKILL.md'), `---\nname: urequartermaster\n---\n# v${version}\n`);
  write(path.join(dir, 'scripts', 'qm.mjs'), `console.log('${version}');\n`);
  write(path.join(dir, 'scripts', 'lib', 'version.mjs'), `export const VERSION = '${version}';\n`);
  write(path.join(dir, 'references', 'notes with space é.md'), 'ref\n');
  write(path.join(dir, 'assets', 'bin.dat'), Buffer.from([0, 1, 2, 255, 254]));
  return dir;
}

/** Stable hash of a directory tree: relative paths, types and contents. */
export function hashTree(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(p);
      if (st.isDirectory()) { h.update(`D ${r}\n`); walk(p, r); }
      else { h.update(`F ${r} ${st.size}\n`); h.update(fs.readFileSync(p)); }
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

