// HTTPS GET for the updater, restricted to an allowlist of GitHub hosts, https only, no credentials
// or ports in URLs, at most three redirects (each re-checked), a total deadline and a byte cap.
import { VERSION } from '../version.mjs';

// Hosts a request or redirect may reach. A redirect may land on any path of these hosts:
// that is acceptable because integrity never rests on where the bytes came from, only on
// the Ed25519 signature checked before anything is installed.
export const ALLOWED_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'api.github.com'];
export const USER_AGENT = `UreQuartermaster/${VERSION}`;
// The 3 s limit applies to the API check, the only request that can happen on a user's command
// path. Downloads run only in the detached background child or in an explicit `qm update`, under
// their own longer deadline.
export const CHECK_TIMEOUT_MS = 3000;
const MAX_REDIRECTS = 3;

function checkUrl(href) {
  let u;
  try { u = new URL(href); } catch { throw new Error('Refusing a malformed URL'); }
  if (u.protocol !== 'https:') throw new Error(`Refusing a non-https URL (${u.protocol})`);
  if (u.username || u.password || u.port) throw new Error('Refusing a URL with credentials or a port');
  if (!ALLOWED_HOSTS.includes(u.hostname)) throw new Error(`Refusing host ${u.hostname}: not in the allowlist`);
  return u;
}

function requestOnce(get, u, maxBytes, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    let req;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => {
      finish(reject, new Error('Request timed out'));
      try { req && req.destroy(); } catch {}
    }, Math.max(1, ms));
    try {
      req = get(u.href, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, timeout: Math.max(1, ms), agent: false }, (res) => {
        const status = res.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          return finish(resolve, { status, location: res.headers && res.headers.location });
        }
        if (status !== 200) {
          res.resume();
          return finish(reject, Object.assign(new Error(`HTTP ${status}`), { status }));
        }
        const declared = Number(res.headers && res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          try { res.destroy(); } catch {}
          return finish(reject, new Error('Response too large'));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            try { res.destroy(); } catch {}
            finish(reject, new Error('Response too large'));
          } else chunks.push(c);
        });
        res.on('end', () => finish(resolve, { status, body: Buffer.concat(chunks) }));
        res.on('error', (e) => finish(reject, e));
        res.on('aborted', () => finish(reject, new Error('Response aborted')));
      });
      req.on('error', (e) => finish(reject, e));
      req.on('timeout', () => { finish(reject, new Error('Request timed out')); try { req.destroy(); } catch {} });
    } catch (e) { finish(reject, e); }
  });
}

/**
 * GET over https from allowlisted hosts only, following at most 3 redirects (each one
 * re-checked), with a total deadline and a byte cap. Resolves to the body Buffer.
 */
export async function httpsGet(url, { maxBytes, timeoutMs = CHECK_TIMEOUT_MS, maxRedirects = MAX_REDIRECTS } = {}, deps = {}) {
  let u = checkUrl(url);
  const get = deps.get || (await import('node:https')).get;
  const deadline = Date.now() + timeoutMs;
  for (let hop = 0; ; hop++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('Request timed out');
    const r = await requestOnce(get, u, maxBytes, left);
    if (r.body) return r.body;
    if (hop >= maxRedirects) throw new Error('Too many redirects');
    if (typeof r.location !== 'string' || !r.location) throw new Error('Redirect without a location');
    let next;
    try { next = new URL(r.location, u).href; } catch { throw new Error('Refusing a malformed redirect'); }
    u = checkUrl(next);
  }
}
