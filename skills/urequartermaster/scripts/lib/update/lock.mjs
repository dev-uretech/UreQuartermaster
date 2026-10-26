// The update lock (<dataDir>/update.lock): one update or rollback at a time. Taking over a stale lock
// is race-free: only one process can win the rename of the old file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LOCK_STALE_MS = 10 * 60 * 1000;
const FUTURE_SLACK_MS = 60 * 1000;

/**
 * Exclusive update lock: `wx` create. A stale lock (older than 10 min, or dated in the
 * future by over a minute) is taken over by renaming it to a unique name first: only one process can win
 * that rename. If what we renamed turns out to be fresh (another process took over in
 * between), it is put back without overwriting and we give up.
 * `opts.stat` exists so tests can interleave two takeovers.
 */
export function acquireLock(dir, { stat = fs.statSync } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'update.lock');
  const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  // A fresh file's mtime can be a few ms ahead of Date.now(); "future" means over a minute ahead.
  const isStale = (st) => { const age = Date.now() - st.mtimeMs; return age < -FUTURE_SLACK_MS || age > LOCK_STALE_MS; };
  const busy = () => new Error('Another update is in progress');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, token, { flag: 'wx' });
      return () => { try { if (fs.readFileSync(file, 'utf8') === token) fs.rmSync(file, { force: true }); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let st;
    try { st = stat(file); } catch { continue; } // vanished: try again
    if (!isStale(st)) throw busy();
    const grabbed = `${file}.stale-${token}`;
    try { fs.renameSync(file, grabbed); } catch { continue; } // someone else won the takeover
    let fresh = false;
    try { fresh = !isStale(fs.statSync(grabbed)); } catch {}
    if (fresh) {
      try { fs.linkSync(grabbed, file); } catch {} // no-overwrite restore of the other process's lock
      try { fs.rmSync(grabbed, { force: true }); } catch {}
      throw busy();
    }
    try { fs.rmSync(grabbed, { force: true }); } catch {}
  }
  throw busy();
}
