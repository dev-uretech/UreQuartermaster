// One-line description of an MCP server for the index, from an allowlist: only tokens that are safe
// by construction (command basename, package or image names, script basenames, URL scheme and host).
// Flags, values, env-like pairs, JSON, quoted strings, paths and URL paths/queries are left out
// entirely (not redacted), so a secret without any recognisable shape cannot slip in. The redaction
// runs once over the whole command line and a token is kept only if it comes out unchanged at its
// position; values of flags are never kept.
import { redactArgs, tokenize } from './redact.mjs';

const MAX_DESCRIPTION = 400;
const SAFE_COMMAND = /^[A-Za-z0-9._+-]{1,64}$/;
const VERSION_TAG = '(?:latest|next|beta|canary|[0-9][a-z0-9._-]*)';
const SCOPED_PKG = new RegExp(`^@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*(?:@${VERSION_TAG})?$`); // @scope/name@1.2.3
const NAME_VERSION = new RegExp(`^[a-z0-9][a-z0-9._-]*@${VERSION_TAG}$`); // name@latest
const BARE_NAME = /^[a-z0-9][a-z0-9._-]*$/; // kept only when one of its words is "mcp"
const IMAGE = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::[0-9]+)?\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+(?::[a-z0-9][a-z0-9._-]*)?$/; // ghcr.io/org/img:tag, org/img
const IMAGE_COMMANDS = new Set(['docker', 'podman', 'nerdctl']);
const SCRIPT = /\.(?:m?js|cjs|py|ts)$/;
const SAFE_FILE = /^[A-Za-z0-9._-]{1,100}$/;

const unquote = (t) => t.replace(/^["'`]+|["'`]+$/g, '');
const baseName = (p) => p.split(/[\\/]/).pop();

// Positional context. A token right after any flag is that flag's value, so it is never a
// candidate, whatever it looks like (`--api-key mcp-x`, `--token @me/x`). Only these flags are
// known to take no value. After a code flag (-c, -e, --eval, -Command) nothing is a candidate;
// for docker/podman/nerdctl (where -c and -e mean other things) the two tokens after it are skipped.
const BOOLEAN_FLAGS = new Set(['-y', '--yes', '-q', '--quiet', '--rm', '-i', '-t', '-it', '-d', '--silent', '--no-install', '--prefer-offline']);
const CODE_FLAGS = new Set(['-c', '-e', '--eval', '-command']);
const isFlagWord = (w) => w.startsWith('-') || /^\/[^/\\]*$/.test(w); // -x, --x, Windows /x
const lastWord = (s) => { const w = s.trim().split(/\s+/); return w[w.length - 1] || ''; };

function safeArg(a, imageOk) {
  if (a.length < 2 || a.length > 100) return null;
  if (SCOPED_PKG.test(a) || NAME_VERSION.test(a)) return a;
  if (BARE_NAME.test(a) && a.split(/[-_.]/).includes('mcp')) return a;
  if (imageOk && IMAGE.test(a)) return a;
  if (SCRIPT.test(a)) { const b = baseName(a); return SAFE_FILE.test(b) ? b : null; }
  return null;
}

export function describe(server) {
  const parts = [];
  if (server.command) {
    // One sequence: command words, then args. The redaction runs once over it with its state
    // carried across tokens; a token is a candidate only if it comes out byte-identical there.
    const words = tokenize(server.command).filter((t, i) => i % 2 === 0 && t);
    const seq = [...words, ...server.args];
    const red = redactArgs(seq);
    const cmd = baseName(unquote(seq[0] || ''));
    if (red[0] === seq[0] && SAFE_COMMAND.test(cmd)) parts.push(cmd);
    const imageOk = IMAGE_COMMANDS.has(cmd.toLowerCase().replace(/\.exe$/, ''));
    let skip = 0; // tokens still to drop after a code flag
    for (let i = 1; i < seq.length; i++) {
      const prev = lastWord(seq[i - 1]);
      // For docker & co. -e is --env: its value is a flag value like any other.
      if (CODE_FLAGS.has(prev.toLowerCase()) && !(imageOk && prev === '-e')) {
        if (!imageOk) break; // the code and whatever follows belong to the code
        skip = 2; // the code and the token after it
      }
      if (skip > 0) { skip--; continue; }
      if (isFlagWord(prev) && !BOOLEAN_FLAGS.has(prev)) continue; // a flag's value
      if (red[i] !== seq[i]) continue;
      const t = safeArg(unquote(seq[i]), imageOk);
      if (t && !parts.includes(t)) parts.push(t);
    }
  } else if (server.url) {
    try {
      const u = new URL(server.url);
      if (/^(?:https?|wss?):$/.test(u.protocol) && u.host) {
        const origin = `${u.protocol}//${u.host}`;
        if (redactArgs([origin])[0] === origin) parts.push(origin);
      }
    } catch { /* not a URL: nothing from it */ }
  }
  const d = `${server.type} MCP server${parts.length ? `: ${parts.join(' ')}` : ''}`;
  return d.length > MAX_DESCRIPTION ? `${d.slice(0, MAX_DESCRIPTION - 1)}…` : d;
}

