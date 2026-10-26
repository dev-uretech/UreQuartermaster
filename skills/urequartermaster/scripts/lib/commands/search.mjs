// `qm search`: BM25 over the index with one or more queries; text (headed by the third-party notice)
// or --json. Every printed field is cleaned; project hits are flagged as untrusted.
import { search } from '../index/search.mjs';
import { clean } from '../core/text.mjs';
import { UsageError, parseArgs, oneOf, oneLine, isProject, currentIndex, KINDS, THIRD_PARTY, PROJECT_FLAG } from './common.mjs';

export function cmdSearch(argv, out) {
  const { pos, flags } = parseArgs(argv, { limit: 'value', kind: 'value', json: 'bool' });
  if (!pos.length) throw new UsageError('search needs at least one query');
  let limit = 8;
  if (flags.limit !== undefined) {
    if (!/^[1-9]\d{0,3}$/.test(flags.limit)) throw new UsageError('--limit must be a positive integer');
    limit = Number(flags.limit);
  }
  const kind = oneOf(flags, 'kind', KINDS);
  const idx = currentIndex();
  const res = search(idx ? idx.entries : [], pos, { limit, kinds: kind ? [kind] : undefined });
  if (flags.json) {
    out(JSON.stringify(res.map(({ entry: { trustRoot, ...entry }, score }) => ({ ...entry, score: Number(score.toFixed(4)) })), null, 2));
    return 0;
  }
  if (!res.length) { out('No local tool matches your queries. Try other words, or run: qm list'); return 0; }
  out(THIRD_PARTY);
  for (const { entry: e } of res) {
    out(`[${clean(e.kind)}] ${clean(e.name)} (${clean(e.state)}) — ${oneLine(e.description)}${isProject(e) ? ` ${PROJECT_FLAG}` : ''}`);
    out(`use: ${clean(e.usage)}`);
  }
  return 0;
}
