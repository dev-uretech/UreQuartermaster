// BM25 search over index entries: three fields (name, description, headings), several queries.
const STOP = new Set(`
a an the and or of to in on for with is are be it this that as at by from
il lo la i gli le un uno una di del della dei delle da in con su per tra fra e ed o che
el los las unos unas de del al y en con por para es son un
le les des du de la et ou un une dans sur pour avec est sont au aux
der die das den dem des ein eine einer und oder von zu im mit fur ist sind auf
o os as um uma uns umas do da dos das no na nos nas em com por para e ou meu minha seu sua nao
`.split(/\s+/).filter(Boolean));

const W = { name: 3, description: 2, headings: 1 };
const K1 = 1.2;
const B = 0.75;
const BOOST_PER_EXTRA_QUERY = 0.1;

function stem(w) {
  if (w.length > 4 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = /(ss|x|ch|sh|zz)es$/.test(w) ? w.slice(0, -2) : w.slice(0, -1);
  // A final "e" is dropped too, so "caches"/"cache" and "databases"/"database" meet on one token.
  return w.length > 4 && w.endsWith('e') ? w.slice(0, -1) : w;
}

/** Lowercase, accents removed, split on non-alphanumerics, stopwords dropped, simple plurals cut. */
export function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !STOP.has(t))
    .map(stem);
}

function termFreq(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

// Tokenizing thousands of entries is the main cost, so it is cached per entry object.
const docCache = new WeakMap();
function docOf(e) {
  let d = docCache.get(e);
  if (!d) {
    const name = tokenize(e.name);
    const description = tokenize(e.description);
    const headings = tokenize(Array.isArray(e.headings) ? e.headings.join(' ') : '');
    d = {
      name: { tf: termFreq(name), len: name.length },
      description: { tf: termFreq(description), len: description.length },
      headings: { tf: termFreq(headings), len: headings.length },
    };
    docCache.set(e, d);
  }
  return d;
}

/**
 * @param {import('./index.mjs').Entry[]} entries
 * @param {string[]} queries
 * @returns {{ entry: import('./index.mjs').Entry, score: number }[]}
 *  score of an entry = best query score + 0.1 per query that matches it.
 */
export function search(entries, queries, { limit = 8, kinds } = {}) {
  const pool = entries.filter((e) => !e.duplicateOf && (!kinds || kinds.includes(e.kind)));
  const qs = (queries || []).map((q) => [...new Set(tokenize(q))]).filter((q) => q.length);
  if (!pool.length || !qs.length) return [];
  const docs = pool.map(docOf);

  const fields = Object.keys(W);
  const stats = {};
  for (const f of fields) {
    let total = 0;
    for (const d of docs) total += d[f].len;
    stats[f] = { avg: total / docs.length || 1, df: new Map() };
  }
  const terms = new Set(qs.flat());
  for (const f of fields) {
    for (const d of docs) for (const t of terms) if (d[f].tf.has(t)) stats[f].df.set(t, (stats[f].df.get(t) || 0) + 1);
  }
  const n = docs.length;
  const idf = (f, t) => {
    const df = stats[f].df.get(t) || 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  };

  const out = [];
  for (let i = 0; i < n; i++) {
    let best = 0;
    let hits = 0;
    for (const q of qs) {
      let s = 0;
      for (const f of fields) {
        const { tf, len } = docs[i][f];
        for (const t of q) {
          const c = tf.get(t);
          if (!c) continue;
          s += W[f] * idf(f, t) * (c * (K1 + 1)) / (c + K1 * (1 - B + B * len / stats[f].avg));
        }
      }
      if (s > 0) { hits++; if (s > best) best = s; }
    }
    if (hits) out.push({ entry: pool[i], score: best + BOOST_PER_EXTRA_QUERY * hits });
  }
  out.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name) || (a.entry.id < b.entry.id ? -1 : 1));
  return out.slice(0, limit);
}
