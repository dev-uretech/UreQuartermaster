import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSkillFile } from '../skills/urequartermaster/scripts/lib/scan/frontmatter.mjs';

const fx = (n) => readFileSync(fileURLToPath(new URL(`./fixtures/skills/${n}/SKILL.md`, import.meta.url)), 'utf8');

test('parses simple frontmatter', () => {
  const r = parseSkillFile(fx('simple'), 'simple-dir');
  assert.equal(r.ok, true);
  assert.equal(r.name, 'simple');
  assert.equal(r.description, 'A simple skill');
});

test('folded and literal descriptions', () => {
  const r = parseSkillFile(fx('folded'), 'x');
  assert.equal(r.description, 'First line second line');
  const lit = parseSkillFile('---\nname: lit\ndescription: |\n  One\n  Two\n\n  Three\nother: 1\n---\nbody', 'x');
  assert.equal(lit.description, 'One Two Three');
  assert.equal(lit.name, 'lit');
});

test('strips BOM and CRLF', () => {
  const r = parseSkillFile('\uFEFF---\r\nname: crlf\r\ndescription: >\r\n  a\r\n  b\r\n---\r\n# H\r\n', 'x');
  assert.equal(r.ok, true);
  assert.equal(r.name, 'crlf');
  assert.equal(r.description, 'a b');
  assert.deepEqual(r.headings, ['H']);
});

test('missing frontmatter falls back to dir name', () => {
  const r = parseSkillFile(fx('nofm'), 'nofm-dir');
  assert.equal(r.ok, false);
  assert.equal(r.name, 'nofm-dir');
  assert.equal(r.description, 'Does things without frontmatter. Second line same paragraph.');
  const long = parseSkillFile('x'.repeat(1500), 'd');
  assert.equal(long.description.length, 1024);
});

test('malformed frontmatter does not throw', () => {
  const r = parseSkillFile('---\nname: broken\nno closing fence\n', 'dir');
  assert.equal(r.ok, false);
  assert.equal(r.name, 'dir');
  assert.doesNotThrow(() => parseSkillFile('', 'dir'));
  assert.equal(r.description, '');
  assert.equal(parseSkillFile('---\nname: b\n\nProse here.\n', 'dir').description, 'Prose here.');
  assert.equal(parseSkillFile('', 'dir').name, 'dir');
  assert.equal(parseSkillFile(undefined, 'dir').name, 'dir');
});

test('missing name in frontmatter uses dir name', () => {
  const r = parseSkillFile('---\ndescription: only desc\n---\nbody', 'dir');
  assert.equal(r.name, 'dir');
  assert.equal(r.description, 'only desc');
});

test('quoted values', () => {
  const r = parseSkillFile(`---\nname: "dq"\ndescription: 'it''s single'\n---\n`, 'x');
  assert.equal(r.name, 'dq');
  assert.equal(r.description, "it's single");
});

test('collects headings', () => {
  const lines = ['---', 'name: h', '---', '# One', '## Two', '### Three', '#### Four', '#NoSpace', '```', '# in code', '```'];
  assert.deepEqual(parseSkillFile(lines.join('\n'), 'x').headings, ['One', 'Two', 'Three']);
  const many = Array.from({ length: 50 }, (_, i) => `## H${i}`).join('\n');
  assert.equal(parseSkillFile(many, 'x').headings.length, 30);
});

test('closing hashes need leading whitespace', () => {
  assert.deepEqual(parseSkillFile('# Learn C#\n## Title ##\n### Plain', 'x').headings, ['Learn C#', 'Title', 'Plain']);
});

test('description on following indented lines', () => {
  const r = parseSkillFile('---\nname: n\ndescription:\n  Long text\n  more\nmetadata:\n  name: nested\n---\n', 'x');
  assert.equal(r.description, 'Long text more');
  assert.equal(r.name, 'n');
});

test('hostile long heading-like line parses fast', () => {
  const line = '# ' + 'a'.repeat(25000) + ' '.repeat(25000) + '#x';
  const t0 = performance.now();
  const r = parseSkillFile(line + '\n' + line, 'x');
  assert.ok(performance.now() - t0 < 100);
  assert.ok(r.headings[0].length <= 1000);
});

test('descriptions keep up to 1024 characters (the Agent Skills limit), also on one line', () => {
  const tail = ' Use when the user asks for a page speed audit.';
  const d = `${'Audits websites. '.repeat(70)}`.slice(0, 1024 - tail.length) + tail;
  assert.equal(d.length, 1024);
  assert.equal(parseSkillFile(`---\nname: seo\ndescription: ${d}\n---\n`, 'seo').description, d);
  assert.equal(parseSkillFile(`---\nname: seo\ndescription: ${d}${'x'.repeat(500)}\n---\n`, 'seo').description, d);
});
