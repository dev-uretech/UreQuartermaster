// The skills CLI's lock file (~/.agents/.skill-lock.json). Park removes a skill's entry and unpark puts
// it back at the same position; the file is rewritten with its own indentation, line endings, BOM and
// final newline, so a park/unpark round trip leaves it byte-identical. A malformed file is left alone.
import fs from 'node:fs';
import { writeFileAtomic } from '../core/files.mjs';

export function readLock(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const bom = raw.startsWith('﻿');
    const text = bom ? raw.slice(1) : raw;
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !doc.skills || typeof doc.skills !== 'object' || Array.isArray(doc.skills)) return null;
    const indent = (/^\{\r?\n([ \t]+)"/.exec(text) || [])[1] || 2;
    return { doc, bom, indent, eol: /\r\n/.test(text) ? '\r\n' : '\n', finalNewline: /\n$/.test(text) };
  } catch { return null; }
}

export function writeLock(file, lock) {
  let text = JSON.stringify(lock.doc, null, lock.indent);
  if (lock.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  writeFileAtomic(file, (lock.bom ? '\uFEFF' : '') + text + (lock.finalNewline ? lock.eol : ''));
}
