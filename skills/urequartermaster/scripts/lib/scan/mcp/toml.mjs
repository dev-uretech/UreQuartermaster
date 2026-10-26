// TOML subset for Codex's config.toml: only mcp_servers.<name>.{command,args,url} are kept
// (and `enabled`, so that disabled servers can be left out). Every other value is parsed only to
// be skipped and never built into a string, so env tables and tokens never exist in memory as
// values. Errors never carry file content; a malformed statement drops only its own line.
import { isObj } from '../../core/files.mjs';

const str = (v) => typeof v === 'string';
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const SERVER_FIELDS = new Set(['command', 'args', 'url', 'enabled']);

class TomlError extends Error {}

function tomlReader(text) {
  let i = 0;
  const n = text.length;
  const fail = () => { throw new TomlError('toml'); }; // never carries content
  const peek = (k = 0) => text[i + k];
  const skipWs = () => { while (i < n && (text[i] === ' ' || text[i] === '\t')) i++; };
  const skipComment = () => { if (text[i] === '#') while (i < n && text[i] !== '\n') i++; };
  const skipWsNl = () => {
    for (;;) {
      skipWs(); skipComment();
      if (text[i] === '\n' || text[i] === '\r') { i++; continue; }
      return;
    }
  };
  const skipLine = () => { while (i < n && text[i] !== '\n') i++; if (i < n) i++; };
  const lineEnd = () => {
    skipWs(); skipComment();
    if (i >= n) return;
    if (text[i] === '\r') i++;
    if (text[i] !== '\n') fail();
    i++;
  };
  const expect = (c) => { if (text[i] !== c) fail(); i++; };
  // Closing quote searches stay linear: a single-line string ends on its own line, and once a
  // multi-line delimiter has no closer after position p it has none after any later position.
  const noCloser = {};
  const findMulti = (close) => {
    if (own(noCloser, close) && i >= noCloser[close]) fail();
    const end = text.indexOf(close, i);
    if (end < 0) { noCloser[close] = i; fail(); }
    return end;
  };

  const ESC = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  function basicString(keep, multi) {
    let s = '';
    if (multi) findMulti('"""');
    for (;;) {
      if (i >= n) fail();
      if (multi && text.startsWith('"""', i)) { i += 3; while (text[i] === '"') { if (keep) s += '"'; i++; } return keep ? s : undefined; }
      const c = text[i];
      if (!multi && c === '"') { i++; return keep ? s : undefined; }
      if (!multi && (c === '\n' || c === '\r')) fail();
      if (c === '\\') {
        const e = text[i + 1];
        if (multi && (e === '\n' || e === '\r' || e === ' ' || e === '\t')) { // line-ending backslash
          i++; while (i < n && /[\s]/.test(text[i])) i++; continue;
        }
        if (e === 'u' || e === 'U') {
          const len = e === 'u' ? 4 : 8;
          const hex = text.slice(i + 2, i + 2 + len);
          if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) fail();
          const cp = parseInt(hex, 16);
          if (cp > 0x10ffff) fail();
          if (keep) s += String.fromCodePoint(cp);
          i += 2 + len; continue;
        }
        if (!own(ESC, e)) fail();
        if (keep) s += ESC[e];
        i += 2; continue;
      }
      if (keep) s += c;
      i++;
    }
  }
  function literalString(keep, multi) {
    const close = multi ? "'''" : "'";
    let end;
    if (multi) end = findMulti(close);
    else {
      let j = i;
      while (j < n && text[j] !== "'" && text[j] !== '\n' && text[j] !== '\r') j++;
      if (text[j] !== "'") fail();
      end = j;
    }
    const body = text.slice(i, end); // bounded by the closing quote
    i = end + close.length;
    if (multi) while (text[i] === "'") i++;
    return keep ? body.replace(/^\r?\n/, '') : undefined;
  }
  function string(keep) {
    if (text.startsWith('"""', i)) { i += 3; if (text[i] === '\r') i++; if (text[i] === '\n') i++; return basicString(keep, true); }
    if (text.startsWith("'''", i)) { i += 3; return literalString(keep, true); }
    if (text[i] === '"') { i++; return basicString(keep, false); }
    if (text[i] === "'") { i++; return literalString(keep, false); }
    return fail();
  }
  function keySegment() {
    if (text[i] === '"' || text[i] === "'") {
      if (text.startsWith('"""', i) || text.startsWith("'''", i)) fail();
      return string(true);
    }
    const start = i;
    while (i < n && /[A-Za-z0-9_-]/.test(text[i])) i++;
    if (i === start) fail();
    return text.slice(start, i);
  }
  function key() {
    const parts = [];
    for (;;) {
      skipWs();
      parts.push(keySegment());
      skipWs();
      if (text[i] !== '.') return parts;
      i++;
    }
  }
  // mode: 'keep' (strings and arrays of strings), 'skip', 'server' (inline table of one
  // server: only SERVER_FIELDS kept), 'servers' (inline table of servers).
  function value(mode) {
    const c = text[i];
    if (c === '"' || c === "'") return string(mode === 'keep');
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        skipWsNl();
        if (text[i] === ']') { i++; return mode === 'keep' ? arr : undefined; }
        const v = value(mode === 'keep' ? 'keep' : 'skip');
        if (mode === 'keep') arr.push(v);
        skipWsNl();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return mode === 'keep' ? arr : undefined; }
        fail();
      }
    }
    if (c === '{') {
      i++;
      const obj = {};
      for (;;) {
        skipWsNl();
        if (text[i] === '}') { i++; break; }
        const k = key();
        skipWs(); expect('='); skipWs();
        if (mode === 'server' && k.length === 1 && SERVER_FIELDS.has(k[0])) obj[k[0]] = value('keep');
        else if (mode === 'servers' && k.length === 1) { const v = value('server'); if (isObj(v)) obj[k[0]] = v; }
        else if (mode === 'servers' && k.length === 2 && SERVER_FIELDS.has(k[1])) {
          const v = value('keep');
          const o = own(obj, k[0]) ? obj[k[0]] : (obj[k[0]] = {});
          o[k[1]] = v;
        } else value('skip');
        skipWsNl();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
        fail();
      }
      return mode === 'server' || mode === 'servers' ? obj : undefined;
    }
    const start = i; // booleans are kept (for `enabled`); numbers and dates are skipped
    while (i < n && /[A-Za-z0-9_+\-.:]/.test(text[i])) i++;
    if (i === start) fail();
    const tok = text.slice(start, i);
    return mode === 'keep' && (tok === 'true' || tok === 'false') ? tok === 'true' : undefined;
  }
  return { get i() { return i; }, set i(v) { i = v; }, n, peek, skipWs, skipWsNl, skipLine, lineEnd, expect, key, value };
}

export function parseTomlServers(text) {
  if (!str(text)) return {};
  const servers = new Map();
  const store = (name, field, v) => {
    let ok;
    if (field === 'args') ok = Array.isArray(v) ? v.filter(str) : null;
    else if (field === 'enabled') ok = typeof v === 'boolean' ? v : null;
    else ok = str(v) ? v : null;
    if (ok === null) return;
    if (!servers.has(name)) servers.set(name, {});
    servers.get(name)[field] = ok;
  };
  const storeServer = (name, obj) => { if (isObj(obj)) for (const f of SERVER_FIELDS) if (own(obj, f)) store(name, f, obj[f]); };

  const t = tomlReader(text);
  let table = []; // current [table] path; null while inside an ignored [[array]] or a broken header
  for (;;) {
    t.skipWsNl();
    if (t.i >= t.n) break;
    const start = t.i;
    try {
      if (t.peek() === '[') {
        if (t.peek(1) === '[') { table = null; t.skipLine(); continue; }
        table = null;
        t.i++;
        const k = t.key();
        t.skipWs(); t.expect(']'); t.lineEnd();
        table = k;
        continue;
      }
      const k = t.key();
      t.skipWs(); t.expect('='); t.skipWs();
      const full = table ? [...table, ...k] : null;
      if (full && full[0] === 'mcp_servers' && full.length === 3 && SERVER_FIELDS.has(full[2])) store(full[1], full[2], t.value('keep'));
      else if (full && full[0] === 'mcp_servers' && full.length === 2) storeServer(full[1], t.value('server'));
      else if (full && full[0] === 'mcp_servers' && full.length === 1) {
        const all = t.value('servers');
        if (isObj(all)) for (const [name, obj] of Object.entries(all)) storeServer(name, obj);
      } else t.value('skip');
      t.lineEnd();
    } catch {
      t.i = start; // malformed statement: drop its line and go on
      t.skipLine();
    }
  }
  const out = [];
  for (const [name, srv] of servers) {
    if (srv.enabled === false) continue; // disabled in config.toml: not usable, not listed
    delete srv.enabled;
    if (Object.keys(srv).length) out.push([name, srv]);
  }
  return Object.fromEntries(out);
}
