import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, search } from '../skills/urequartermaster/scripts/lib/index/search.mjs';

const E = (o) => ({ id: `${o.kind || 'skill'}:${o.name}`, kind: 'skill', description: '', headings: [], path: null, source: 'claude', state: 'installed', usage: '', ...o });

test('tokenize lowercases, strips accents, splits on non-alphanumerics and hyphens', () => {
  assert.deepEqual(tokenize('Créer vidéo'), ['creer', 'video']);
  assert.deepEqual(tokenize('seo-audit_tool.v2'), ['seo', 'audit', 'tool', 'v2']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

test('tokenize drops stopwords of en/it/es/fr/de/pt', () => {
  assert.deepEqual(tokenize('the video and the audio'), ['video', 'audio']);
  assert.deepEqual(tokenize('il video della sera'), ['video', 'sera']);
  assert.deepEqual(tokenize('el video de la casa'), ['video', 'casa']);
  assert.deepEqual(tokenize('le video de la maison'), ['video', 'maison']);
  assert.deepEqual(tokenize('das Video und der Ton'), ['video', 'ton']);
  assert.deepEqual(tokenize('o video do meu amigo'), ['video', 'amigo']);
});

test('tokenize strips simple English plurals on words longer than 4 letters', () => {
  assert.deepEqual(tokenize('videos'), ['video']);
  assert.deepEqual(tokenize('searches boxes'), ['search', 'box']);
  assert.deepEqual(tokenize('class tests'), ['class', 'test']);
  assert.deepEqual(tokenize('ads'), ['ads']);
});

test('tokenize maps plural and singular of common words to the same token', () => {
  for (const [a, b] of [['caches', 'cache'], ['databases', 'database'], ['releases', 'release'], ['sizes', 'size'], ['boxes', 'box'], ['searches', 'search']]) {
    assert.deepEqual(tokenize(a), tokenize(b), `${a} / ${b}`);
  }
});

const three = [
  E({ name: 'pdf-tools', description: 'Merge and split PDF files' }),
  E({ name: 'seo-audit', description: 'Run a technical check of a website' }),
  E({ name: 'writer', description: 'Write a seo audit report for clients', headings: ['Audit steps'] }),
];

test('search puts the entry named like the query first', () => {
  const r = search(three, ['seo audit']);
  assert.equal(r[0].entry.name, 'seo-audit');
  assert.ok(r.every((x) => x.score > 0));
  assert.ok(!r.some((x) => x.entry.name === 'pdf-tools'));
});

test('search weights name above description above headings', () => {
  const es = [
    E({ name: 'a1', description: 'x', headings: ['zebra'] }),
    E({ name: 'a2', description: 'zebra', headings: [] }),
    E({ name: 'zebra', description: 'x', headings: [] }),
  ];
  const r = search(es, ['zebra']).map((x) => x.entry.name);
  assert.deepEqual(r, ['zebra', 'a2', 'a1']);
});

test('multi-query: max across queries plus 0.1 per query that matches', () => {
  const es = [E({ name: 'alpha', description: 'one' }), E({ name: 'beta', description: 'two' })];
  const single = search(es, ['alpha'])[0].score - 0.1; // raw best score
  const both = search(es, ['alpha', 'alpha'])[0].score;
  assert.ok(Math.abs(both - (single + 0.2)) < 1e-9);
  const mixed = search(es, ['alpha', 'nomatch'])[0].score;
  assert.ok(Math.abs(mixed - (single + 0.1)) < 1e-9);
});

test('search honours limit and kinds, and skips duplicates', () => {
  const es = [
    E({ name: 'tool-a', kind: 'skill' }), E({ name: 'tool-b', kind: 'mcp' }),
    E({ name: 'tool-c', kind: 'cli' }), E({ name: 'tool-d', kind: 'cli', duplicateOf: 'cli:tool-c' }),
  ];
  assert.equal(search(es, ['tool'], { limit: 2 }).length, 2);
  assert.deepEqual(search(es, ['tool'], { kinds: ['cli'] }).map((x) => x.entry.name), ['tool-c']);
  assert.ok(!search(es, ['tool']).some((x) => x.entry.name === 'tool-d'));
});

test('search with empty queries or no match returns []', () => {
  assert.deepEqual(search(three, []), []);
  assert.deepEqual(search(three, ['the']), []);
  assert.deepEqual(search(three, ['qqqq']), []);
});

test('performance: 5000 entries, 6 queries under 300 ms', () => {
  const words = ['video', 'audio', 'image', 'pdf', 'seo', 'report', 'deploy', 'test', 'data', 'mail', 'chart', 'crm'];
  const es = Array.from({ length: 5000 }, (_, i) => E({
    name: `skill-${words[i % 12]}-${i}`,
    description: `Handles ${words[(i * 7) % 12]} and ${words[(i * 5) % 12]} tasks number ${i} for agents that need them`,
    headings: [words[(i * 3) % 12], 'Usage', 'Examples'],
  }));
  const qs = ['seo audit', 'create video', 'pdf merge', 'deploy server', 'mail report', 'crm data'];
  const t = process.hrtime.bigint();
  const r = search(es, qs, { limit: 8 });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(r.length, 8);
  assert.ok(ms < 300, `took ${ms} ms`);
});
