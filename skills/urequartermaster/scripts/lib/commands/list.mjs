// `qm list` (what is indexed, with filters) and `qm index` (rebuild now and print the counts).
import { buildIndex, saveIndex } from '../index/index.mjs';
import { dataDir } from '../core/paths.mjs';
import { clean } from '../core/text.mjs';
import { parseArgs, oneOf, oneLine, isProject, currentIndex, KINDS, STATES, PROJECT_FLAG } from './common.mjs';

export function cmdList(argv, out) {
  const { flags } = parseArgs(argv, { kind: 'value', state: 'value', all: 'bool' });
  const kind = oneOf(flags, 'kind', KINDS);
  const state = oneOf(flags, 'state', STATES);
  const idx = currentIndex();
  const rows = (idx ? idx.entries : []).filter((e) => (flags.all || !e.duplicateOf)
    && (!kind || e.kind === kind) && (!state || e.state === state));
  for (const e of rows) {
    out(`[${clean(e.kind)}] ${clean(e.name)} (${clean(e.state)}) — ${oneLine(e.description)}${e.duplicateOf ? ` [duplicate of ${clean(e.duplicateOf)}]` : ''}${isProject(e) ? ` ${PROJECT_FLAG}` : ''}`);
  }
  return 0;
}

export function cmdIndex(argv, out) {
  const { flags } = parseArgs(argv, { json: 'bool' });
  const idx = buildIndex({});
  saveIndex(dataDir(process.env), idx);
  const counts = { total: idx.entries.length };
  for (const k of KINDS) counts[k] = idx.entries.filter((e) => e.kind === k).length;
  if (flags.json) out(JSON.stringify(counts));
  else out(`Indexed ${counts.total} entries: ${KINDS.map((k) => `${counts[k]} ${k}`).join(', ')}`);
  return 0;
}
