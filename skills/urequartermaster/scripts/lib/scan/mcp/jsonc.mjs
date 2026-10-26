// Tolerant reading of agent JSON config files: size-capped, BOM stripped, and with the comments
// and trailing commas VS Code and others accept. Unreadable or malformed files are null, never an
// error that could carry their content.
import fs from 'node:fs';
import { isObj } from '../../core/files.mjs';

const MAX_JSON = 64 * 1024 * 1024; // ~/.claude.json can be large (history); JSON.parse is linear

function stripJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      out += text.slice(start, i);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else { out += c; i++; }
  }
  // Trailing commas, outside strings.
  let res = '';
  i = 0;
  while (i < out.length) {
    const c = out[i];
    if (c === '"') {
      const start = i++;
      while (i < out.length && out[i] !== '"') i += out[i] === '\\' ? 2 : 1;
      i++;
      res += out.slice(start, i);
    } else if (c === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] !== '}' && out[j] !== ']') res += c;
      i++;
    } else { res += c; i++; }
  }
  return res;
}

export function readText(file, max = MAX_JSON) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch {
    return null;
  }
}

export function parseJsonLoose(text) {
  if (text === null) return null;
  let v = null;
  try { v = JSON.parse(text); } catch {
    try { v = JSON.parse(stripJsonc(text)); } catch { v = null; }
  }
  return isObj(v) ? v : null;
}
