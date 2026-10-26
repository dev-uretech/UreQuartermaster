// Minimal SKILL.md reader: a hand-written YAML subset (top-level scalar keys,
// folded/literal block scalars, quoted values; nested keys are ignored).
// It never throws: a broken or missing frontmatter falls back to the folder name.

const MAX_DESCRIPTION = 1024; // the Agent Skills limit: the "Use when" tail at the end matters most for matching
const MAX_HEADINGS = 30;
const MAX_HEADING = 1000;
const MAX_LINE = 2000; // every line is cut before any regex runs: keeps parsing linear on hostile files

function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

const join = (lines) => lines.map((l) => l.trim()).filter(Boolean).join(' ');

// Reads top-level `key: value` pairs. Indented lines belong to the previous key.
function parseYaml(lines) {
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_.-]+)[ \t]*:(?:[ \t]+(.*))?$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    const raw = (m[2] ?? '').trim();
    const cont = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^[ \t]/.test(lines[i + 1]))) {
      cont.push(lines[++i]);
    }
    if (/^[>|][+-]?\d*$/.test(raw)) {
      out[key] = join(cont);
    } else if (raw === '') {
      // Plain scalar on the following lines, unless it is a nested mapping or list.
      const nested = cont.some((l) => /^\s*(?:-(?:\s|$)|[A-Za-z0-9_.-]+\s*:(?:\s|$))/.test(l));
      if (!nested) out[key] = join(cont);
    } else if (raw[0] === '"' || raw[0] === "'") {
      out[key] = unquote(raw);
    } else {
      out[key] = join([raw, ...cont]);
    }
  }
  return out;
}

function splitFrontmatter(lines) {
  if (lines[0].trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return { fm: lines.slice(1, i), body: lines.slice(i + 1) };
    }
  }
  return { unclosed: lines.slice(1) };
}

// A closing run of '#' counts only when preceded by whitespace ("Learn C#" keeps its '#').
function stripClosingHashes(t) {
  let j = t.length;
  while (j > 0 && t[j - 1] === '#') j--;
  if (j < t.length && (j === 0 || t[j - 1] === ' ' || t[j - 1] === '\t')) return t.slice(0, j).trim();
  return t;
}

function headingsOf(bodyLines) {
  const headings = [];
  let fence = null;
  for (const line of bodyLines) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^#{1,3}[ \t]+(.*)$/.exec(line);
    if (h) {
      const text = stripClosingHashes(h[1].trim());
      if (!text) continue;
      headings.push(text.slice(0, MAX_HEADING));
      if (headings.length >= MAX_HEADINGS) break;
    }
  }
  return headings;
}

function firstParagraph(bodyLines) {
  const para = [];
  for (const line of bodyLines) {
    const t = line.trim();
    if (!t) {
      if (para.length) break;
      continue;
    }
    if (/^#{1,6}[ \t]/.test(t)) {
      if (para.length) break;
      continue;
    }
    para.push(t);
  }
  return para.join(' ').slice(0, MAX_DESCRIPTION);
}

export function parseSkillFile(text, dirName) {
  const src = typeof text === 'string' ? text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') : '';
  const lines = src.split('\n').map((l) => l.slice(0, MAX_LINE));
  const parts = splitFrontmatter(lines);
  let bodyLines = lines;
  if (parts?.unclosed) {
    // Unclosed fence: the YAML-looking lines up to the first blank line are not prose.
    const blank = parts.unclosed.findIndex((l) => l.trim() === '');
    bodyLines = blank < 0 ? [] : parts.unclosed.slice(blank + 1);
  } else if (parts) {
    bodyLines = parts.body;
  }
  const headings = headingsOf(bodyLines);
  if (!parts || parts.unclosed) {
    return { name: dirName, description: firstParagraph(bodyLines), headings, ok: false };
  }
  const data = parseYaml(parts.fm);
  const name = data.name ? data.name : dirName;
  const description = (data.description ?? '').slice(0, MAX_DESCRIPTION);
  return { name, description, headings, ok: Boolean(data.name) };
}
