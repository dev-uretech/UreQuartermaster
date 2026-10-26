// Redaction of secrets in MCP server command lines: flags, NAME=value pairs, URLs, headers, JSON
// fragments and random-looking tokens become «redacted». It is a second line of defence: the index
// descriptions are built from an allowlist (describe.mjs) and keep only tokens this leaves untouched.
// Nothing here may log, store or return the original value of something it hides.

export const REDACTED = '«redacted»';
const R = REDACTED;

// Names (flags, KEY=, query params, header names, JSON keys) that announce a secret value.
// Split into words (snake, kebab, camelCase) so "monkey" or "author" do not match.
const SECRET_WORD_PART = /(token|secret|passw(or)?d|passphrase|passcode|apikey|credential|bearer|privatekey|privkey|accesskey|cookie)/;
const SECRET_WORDS = new Set(['key', 'keys', 'auth', 'pwd', 'pw', 'pass', 'pat', 'oauth', 'authorization', 'authentication', 'sig', 'signature', 'jwt', 'sas', 'session']);

export function isSecretName(name) {
  const parts = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
  return parts.some((p) => p && (SECRET_WORDS.has(p) || SECRET_WORD_PART.test(p)));
}

// Well-known token formats (OpenAI/Stripe, GitHub, Slack, Google, GitLab, JWT, AWS, npm, Hugging Face, Shopify, SendGrid).
const KNOWN_PREFIX = /^(?:(?:sk|rk|pk)[-_][A-Za-z0-9]|gh[pousr]_|github_pat_|xox[a-z]-|xapp-|AIza|glpat-|eyJ[A-Za-z0-9_-]{8,}\.|ya29\.|AKIA[0-9A-Z]{12}|npm_|hf_|shpat_|SG\.)/;

// One segment (no / \ @ : ? & # = , ; quotes or brackets) that looks like a random token.
function isSecretLike(seg) {
  if (seg.length < 16 || !/^[A-Za-z0-9_\-+.~]+$/.test(seg)) return false;
  if (KNOWN_PREFIX.test(seg)) return true;
  if (seg.length < 32) return false;
  if (!/[-_.~]/.test(seg)) return true; // 32+ characters in one run: not a word or a package name
  const letters = (seg.match(/[A-Za-z]/g) || []).length;
  const digits = (seg.match(/[0-9]/g) || []).length;
  if (digits >= 6 && letters >= 4 && digits / seg.length >= 0.2) return true; // UUID-like and similar
  return seg.split(/[-_.~]/).some((p) => p.length >= 20 && /[0-9]/.test(p) && /[A-Za-z]/.test(p));
}

// URL path segment: 20+ chars mixing upper case, lower case and digits (webhook keys and similar).
const isPathSecret = (seg) => seg.length >= 20 && /^[A-Za-z0-9_\-+.~%]+$/.test(seg) && /[A-Z]/.test(seg) && /[a-z]/.test(seg) && /[0-9]/.test(seg);

// Base64 with "/" would be cut into pieces by the segment split: check the whole token first.
function isBase64Secret(t) {
  if (t.length < 32 || t.startsWith('/') || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return false;
  return t.split('/').some((p) => p.length >= 12 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p));
}

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// A whitespace-free piece: URL userinfo, URL path, secret query/fragment params, random-looking segments.
function redactPiece(t) {
  if (!t || t === R) return t;
  if (isBase64Secret(t)) return R;
  // Userinfo runs to the last "@" before the path, so a password may contain "@".
  t = t.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#\s]*)@/g, `$1${R}@`);
  t = t.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s]*)(\/[^?#\s]*)/g, (_, base, p) => base + p.split('/').map((seg) => (isPathSecret(seg) ? R : seg)).join('/'));
  t = t.replace(/([?&;#])([^=&#\s?;]+)=([^&#\s;]*)/g, (all, sep, k, v) => (v && isSecretName(safeDecode(k)) ? `${sep}${k}=${R}` : all));
  return t.split(/([/\\@:?&#=,;'"()<>[\]{}|*!$`])/).map((seg) => (isSecretLike(seg) ? R : seg)).join('');
}

// "user:password" -> "user:«redacted»"
const userValue = (v) => { const i = v.indexOf(':'); return i < 0 ? redactPiece(v) : `${v.slice(0, i + 1)}${R}`; };

// Header-shaped "Name: value" with a secret name -> "Name: «redacted»", else null.
function headerValue(v) {
  const h = /^(\s*)([A-Za-z0-9_-]+)(\s*:\s*)(\S[\s\S]*)$/.exec(v);
  return h && !h[4].startsWith('//') && isSecretName(h[2]) ? `${h[1]}${h[2]}${h[3]}${R}` : null;
}

const FLAG = /^-{1,2}[A-Za-z][\w.-]*$/;
// After a secret flag, only these count as "the next flag" (so --password -dashpw is a value).
const LIKELY_FLAG = /^(?:--[A-Za-z][\w.-]*|-[A-Za-z])$/;
const FLAG_VALUE = /^(-{1,2}[A-Za-z0-9][\w.-]*)=([\s\S]*)$/;
const USER_FLAGS = new Set(['-u', '--user']);
const ENV_FLAGS = new Set(['-e', '--env']); // docker-style: -e NAME value / --env NAME=value
// NAME=value, also PowerShell $env:NAME=value.
const KV = /^((?:\$[Ee][Nn][Vv]:)?([A-Za-z_][A-Za-z0-9_.-]*))=([\s\S]*)$/;
const NAME_ONLY = /^(?:\$[Ee][Nn][Vv]:)?([A-Za-z_][A-Za-z0-9_.-]*)$/;
// Database clients where -p means password (elsewhere -p is usually a port).
const DB_CLIENTS = new Set(['mysql', 'mysqldump', 'mariadb', 'mariadb-dump', 'psql', 'pg_dump', 'mongo', 'mongosh', 'mongodump', 'redis-cli']);
const commandName = (w) => w.split(/[/\\]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');

// Shell-like split that keeps quoted spans ('…', "…", `…`) inside one token and keeps the
// original text. Returns [token, space, token, ...] like s.split(/(\s+)/). An unclosed quote
// runs to the end of the string.
export function tokenize(s) {
  const out = [];
  let tok = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (/\s/.test(c)) {
      let j = i;
      while (j < n && /\s/.test(s[j])) j++;
      out.push(tok, s.slice(i, j));
      tok = '';
      i = j;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && s[j] !== c) j += s[j] === '\\' && c !== "'" ? 2 : 1;
      j = Math.min(j + 1, n);
      tok += s.slice(i, j);
      i = j;
    } else { tok += c; i++; }
  }
  out.push(tok);
  return out;
}

// One state machine for a whole command line: words inside one string and across args share it,
// so "--token X" is caught whether X is the next arg or the next word of the same string.
//   hide: hide the next value; user: next value is user:password; db: -p means password;
//   env: after -e/--env, a secret NAME hides the value after it; assign: after a secret NAME,
//   a lone "=" (PowerShell "$env:NAME = value") hides the value after it.
const newState = () => ({ hide: false, user: false, db: false, env: false, assign: false });

// The value of NAME=… / --flag=… is hidden: drop its quotes, keep trailing ; , )
const hiddenTail = (post) => post.replace(/["'`]/g, '');

function redactWord(w, st) {
  if (!w || w === R) return w;
  const q = /^(["'`(]*)([\s\S]*?)(["'`),;]*)$/.exec(w);
  const [pre, core, post] = [q[1], q[2], q[3]];
  if (st.hide) {
    const user = st.user;
    st.hide = false; st.user = false; st.env = false; st.assign = false;
    if (!LIKELY_FLAG.test(core)) return pre + (user ? userValue(core) : R) + post;
  }
  const { env, assign } = st;
  st.env = false; st.assign = false;
  if (assign && core === '=') { st.hide = true; return w; }
  // Secret NAME=… / --flag=… first: their value may be a quoted span with spaces.
  let m = FLAG_VALUE.exec(core);
  if (m && isSecretName(m[1])) {
    if (m[2] === '' && !post) { st.hide = true; return w; } // --token=   value
    return `${pre}${m[1]}=${R}${hiddenTail(post)}`;
  }
  m = KV.exec(core);
  if (m && isSecretName(m[2])) {
    if (m[3] === '' && !post) { st.hide = true; return w; } // NAME=   value
    return `${pre}${m[1]}=${R}${hiddenTail(post)}`;
  }
  if (/\s/.test(core)) {
    // A quoted span: redact its content as a command line of its own (same state).
    if (pre || post) return pre + redactString(core, st) + post;
    // Unbalanced quote inside a word: fall back to plain words.
    return core.split(/(\s+)/).map((t, i) => (i % 2 ? t : redactWord(t, st))).join('');
  }
  if (st.db && /^-p\S/.test(core)) return `${pre}-p${R}${post}`; // mysql -pSECRET
  if (FLAG.test(core)) {
    if (isSecretName(core) || (st.db && core === '-p')) st.hide = true;
    else if (USER_FLAGS.has(core)) { st.hide = true; st.user = true; }
    else if (ENV_FLAGS.has(core)) st.env = true;
    return w;
  }
  m = FLAG_VALUE.exec(core);
  if (m) {
    if (USER_FLAGS.has(m[1])) return `${pre}${m[1]}=${userValue(m[2])}${post}`;
    return `${pre}${m[1]}=${kvValue(m[2]) ?? headerValue(m[2]) ?? redactPiece(m[2])}${post}`;
  }
  m = NAME_ONLY.exec(core);
  if (m && isSecretName(m[1])) {
    if (env) st.hide = true; // --env API_KEY value
    else st.assign = true; // $env:API_KEY = value
    return w;
  }
  if (/^[A-Za-z0-9_-]+:$/.test(core) && isSecretName(core.slice(0, -1))) { st.hide = true; return w; } // "X-Api-Key: v"
  const h = headerValue(core);
  if (h) return pre + h + post;
  if (DB_CLIENTS.has(commandName(core))) st.db = true;
  return pre + redactPiece(core) + post;
}

// "API_KEY=v" with a secret name -> "API_KEY=«redacted»", else null.
function kvValue(v) {
  const m = KV.exec(v);
  return m && isSecretName(m[2]) ? `${m[1]}=${R}` : null;
}

// JSON or JS-like objects inside a string: "password": "x" / 'apiKey': 'x' / "pin": 1234 / "auth": true.
function redactJsonPairs(s) {
  s = s.replace(/(["'])((?:\\.|(?!\1)[^\\\n])*)\1(\s*:\s*)(["'])((?:\\.|(?!\4)[^\\\n])*)\4/g,
    (all, q1, k, sep, q2) => (isSecretName(k) ? `${q1}${k}${q1}${sep}${q2}${R}${q2}` : all));
  return s.replace(/(["'])((?:\\.|(?!\1)[^\\\n])*)\1(\s*:\s*)(-?[0-9][0-9A-Za-z.+-]*|true|false)/g,
    (all, q1, k, sep) => (isSecretName(k) ? `${q1}${k}${q1}${sep}${R}` : all));
}

const MAX_ARG = 2048; // longer strings are hidden whole: cheap, and nothing can slip through

function redactString(s, st) {
  if (s.length > MAX_ARG) return R;
  s = redactJsonPairs(s);
  // --flag=value as a whole string: the value may be a header or a command line of its own.
  const f = FLAG_VALUE.exec(s);
  if (f && /\s/.test(f[2])) {
    if (isSecretName(f[1])) return `${f[1]}=${R}`;
    if (USER_FLAGS.has(f[1])) return `${f[1]}=${userValue(f[2].trim())}`;
    return `${f[1]}=${kvValue(f[2]) ?? headerValue(f[2]) ?? redactString(f[2], st)}`;
  }
  // "Authorization: Bearer x", "X-API-Key: x" as a whole string: hide the whole value.
  const h = headerValue(s);
  if (h) return h;
  s = s.replace(/\b(bearer|basic|token|digest)(\s+)[^\s"',;]+/gi, (_, w, sp) => `${w}${sp}${R}`);
  return tokenize(s).map((t, i) => (i % 2 ? t : redactWord(t, st))).join('');
}

export function redactArgs(args) {
  if (!Array.isArray(args)) return [];
  const st = newState();
  const out = [];
  for (const a of args) {
    if (typeof a !== 'string' && typeof a !== 'number') continue;
    const s = String(a);
    if (st.hide && !LIKELY_FLAG.test(s)) {
      const user = st.user;
      st.hide = false; st.user = false; st.env = false; st.assign = false;
      out.push(user && s.length <= MAX_ARG ? userValue(s) : R);
      continue;
    }
    out.push(redactString(s, st));
  }
  return out;
}
