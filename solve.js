// Fast drop-in for makefun-site 1.0.0 (MIT, derived from the reference in the kit).
// Same output byte for byte; faster by:
//  - bulk HTML escaping (plain runs escaped at once, never per character)
//  - per-build caches for slugify / longDate / link resolution
//  - fused Markdown lex+render with hand-written line classifiers (no regex per line)
//  - fast word counting, front-matter parsing without splitting the whole body
//  - templates compiled once per build to JS functions (interpreter fallback)
//  - cards computed once per page and reused by pageOf / tagOf / index pages
// No dependencies, no WASM, no native code. All caches live inside one run() call.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

// ---------------------------------------------------------------- text
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
export function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDateCached(ctx, date) {
  let v = ctx.longCache.get(date);
  if (v === undefined) {
    const y = date.slice(0, 4), m = date.slice(5, 7), d = date.slice(8, 10);
    v = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    ctx.longCache.set(date, v);
  }
  return v;
}

function slugify(ctx, text) {
  const cached = ctx.slugCache.get(text);
  if (cached !== undefined) return cached;
  let plain;
  if (/[^\x00-\x7F]/.test(text)) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  else plain = text;
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain.charCodeAt(i);
    let keep = -1;
    if (ch >= 65 && ch <= 90) keep = ch + 32;
    else if ((ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57)) keep = ch;
    if (keep === -1) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  const res = out === '' ? 'untitled' : out;
  ctx.slugCache.set(text, res);
  return res;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function isWS(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xA0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 ||
    c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
}

function wordsOf(text) {
  let n = 0, inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || (c >= 9 && c <= 13) || c === 0xA0 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 ||
      c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  if (nl === -1) return { error: 'the front matter is not closed' };
  // Find the closing line: a line that is exactly '---'.
  let closeIdx = -1, afterClose = -1;
  let from = nl;
  while (true) {
    const idx = text.indexOf('\n---', from);
    if (idx === -1) break;
    const after = idx + 4;
    if (after === text.length || text[after] === '\n') { closeIdx = idx; afterClose = after; break; }
    from = idx + 1;
  }
  if (closeIdx === -1) return { error: 'the front matter is not closed' };
  const fmText = text.slice(nl + 1, closeIdx);
  const lines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (line === '' || /^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = afterClose === text.length ? '' : text.slice(afterClose + 1);
  return { data, body };
}

// ---------------------------------------------------------------- markdown
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function findUnescaped(s, what, from) {
  // what is '**' or ']'
  if (what.length === 1) {
    const ch = what;
    for (let j = from; j < s.length; j++) {
      if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
      if (s[j] === ch) return j;
    }
    return -1;
  }
  for (let j = from; j <= s.length - 2; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s[j] === '*' && s[j + 1] === '*') return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

function inline(s, env) {
  const out = [];
  let plain = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    // Jump over plain text to the next special character (native indexOf scans).
    let j = n;
    let k = s.indexOf('\\', i); if (k !== -1 && k < j) j = k;
    k = s.indexOf('`', i); if (k !== -1 && k < j) j = k;
    k = s.indexOf('*', i); if (k !== -1 && k < j) j = k;
    k = s.indexOf('[', i); if (k !== -1 && k < j) j = k;
    if (j > i) { plain += s.slice(i, j); i = j; }
    if (i >= n) break;
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      plain += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const jj = s.indexOf('`', i + 1);
      if (jj > i + 1) {
        if (plain) { out.push(escapeHtml(plain)); plain = ''; }
        out.push('<code>', escapeHtml(s.slice(i + 1, jj)), '</code>');
        i = jj + 1;
      } else { plain += '`'; i++; }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const jj = findUnescaped(s, '**', i + 2);
        if (jj > i + 2) {
          if (plain) { out.push(escapeHtml(plain)); plain = ''; }
          out.push('<strong>', inline(s.slice(i + 2, jj), env), '</strong>');
          i = jj + 2;
        } else { plain += '**'; i += 2; }
        continue;
      }
      const jj = findSingleStar(s, i + 1);
      if (jj > i + 1) {
        if (plain) { out.push(escapeHtml(plain)); plain = ''; }
        out.push('<em>', inline(s.slice(i + 1, jj), env), '</em>');
        i = jj + 1;
      } else { plain += '*'; i++; }
      continue;
    }
    if (c === '[') {
      const kk = findUnescaped(s, ']', i + 1);
      const m = kk !== -1 && s[kk + 1] === '(' ? s.indexOf(')', kk + 2) : -1;
      const target = m === -1 ? '' : s.slice(kk + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        if (plain) { out.push(escapeHtml(plain)); plain = ''; }
        out.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(i + 1, kk), env), '</a>');
        i = m + 1;
        continue;
      }
      plain += '[';
      i++;
      continue;
    }
    // A backslash before a non-escapable character: the backslash itself.
    plain += c;
    i++;
  }
  if (plain) out.push(escapeHtml(plain));
  return out.join('');
}

// Line classifiers (same semantics as the reference regexes, no regex per line).
function isBlank(line) {
  for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b) { const c = line.charCodeAt(a); if (c === 32 || c === 9) a++; else break; }
  while (b > a) { const c = line.charCodeAt(b - 1); if (c === 32 || c === 9) b--; else break; }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}
function restSpacesOnly(line, from) {
  for (let i = from; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}
// fence open: returns lang string, or null
function fenceOpen(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  if (!restSpacesOnly(line, i)) return null;
  return line.slice(3, i);
}
function fenceClose(line) {
  return line.length >= 3 && line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && restSpacesOnly(line, 3);
}
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let i = n;
  while (i < line.length) { const cc = line.charCodeAt(i); if (cc === 32 || cc === 9) i++; else break; }
  let b = line.length;
  while (b > i) { const cc = line.charCodeAt(b - 1); if (cc === 32 || cc === 9) b--; else break; }
  if (b === i) return null;
  return { depth: n, text: line.slice(i, b) };
}
function isHR(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0), b = line.charCodeAt(1), cc = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && cc === 45) || (a === 42 && b === 42 && cc === 42))) return false;
  return restSpacesOnly(line, 3);
}
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 45 || c === 42) return isHR(line);
  return false;
}
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isWS(line.charCodeAt(i));
}

function renderMarkdown(ctx, src, env) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    if (c0 === -1 || c0 === 32 || c0 === 9) {
      // Blank line, or a paragraph line opening on a space/tab (no block starts there).
      if (isBlank(line)) { i++; continue; }
      // fall through to paragraph
    } else if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < L && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        let code = '';
        for (let k = 0; k < body.length; k++) code += escapeHtml(body[k]) + '\n';
        blocks.push(`<pre><code${cls}>${code}</code></pre>`);
        continue;
      }
      // fall through to paragraph
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(ctx, heading.text), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
      // fall through to paragraph
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(line)) { blocks.push('<hr>'); i++; continue; }
      // may still be a list (handled below) or a paragraph
    } else if (c0 === 62) { // '>'
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        body.push(l);
      }
      const kept = [];
      for (let k = 0; k < body.length; k++) { const t = trimLine(body[k]); if (t !== '') kept.push(t); }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    // list? (only lines opening on '-', '*', or a digit can start one)
    if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      let isOrdered = false, start = 1, rest = null;
      if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) { rest = line.slice(2); }
      else if (c0 >= 48 && c0 <= 57) {
        let d = 0;
        while (d < 9 && d < line.length) { const cc = line.charCodeAt(d); if (cc >= 48 && cc <= 57) d++; else break; }
        if (d > 0 && d < line.length && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
          isOrdered = true; start = Number(line.slice(0, d)); rest = line.slice(d + 2);
        }
      }
      if (rest !== null) {
        const items = [];
        let cur = null;
        while (i < L) {
          const ln = lines[i];
          let r = null;
          const cc0 = ln.charCodeAt(0);
          if (isOrdered) {
            let d = 0;
            while (d < 9 && d < ln.length) { const cc = ln.charCodeAt(d); if (cc >= 48 && cc <= 57) d++; else break; }
            if (d > 0 && d < ln.length && ln.charCodeAt(d) === 46 && ln.charCodeAt(d + 1) === 32) r = ln.slice(d + 2);
          } else if ((cc0 === 45 || cc0 === 42) && ln.charCodeAt(1) === 32) { r = ln.slice(2); }
          if (r !== null) {
            cur = [trimLine(r)];
            items.push(cur);
            i++;
          } else if (cur !== null && isContinued(ln)) {
            cur.push(trimLine(ln));
            i++;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
        let inner = '';
        for (let k = 0; k < items.length; k++) inner += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
        blocks.push(`${open}\n${inner}</${tag}>`);
        continue;
      }
    }
    // paragraph
    const body = [trimLine(line)];
    i++;
    while (i < L && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}
// Interpreter fallback (used only if a template fails to compile).
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text': out += n.text; break;
      case 'var': out += escapeHtml(textOf(lookup(scope, n.path))); break;
      case 'raw': out += textOf(lookup(scope, n.path)); break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        xs.forEach((x, k) => {
          const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        });
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < 8) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// Compile a parsed template to a function (sc, R, dp) => string.
function compileTemplate(nodes) {
  let uid = 0;
  const parts = ['let out=[];\n'];
  function lookupCode(scVar, path) {
    const v = `_v${uid++}`;
    const s = `_s${uid++}`;
    let code = `let ${v};{let ${s}=${scVar};while(${s}!==null&&!Object.hasOwn(${s}.vars,${JSON.stringify(path[0])}))${s}=${s}.parent;${v}=${s}===null?undefined:${s}.vars[${JSON.stringify(path[0])}];`;
    for (let k = 1; k < path.length; k++) {
      code += `if(${v}!==null&&typeof ${v}==="object"&&Object.hasOwn(${v},${JSON.stringify(path[k])}))${v}=${v}[${JSON.stringify(path[k])}];else ${v}=undefined;`;
    }
    code += '}';
    return { code, v };
  }
  function gen(list, scVar) {
    for (const n of list) {
      if (n.kind === 'text') { parts.push(`out.push(${JSON.stringify(n.text)});\n`); continue; }
      if (n.kind === 'var' || n.kind === 'raw') {
        const { code, v } = lookupCode(scVar, n.path);
        parts.push(code);
        parts.push(n.kind === 'var' ? `out.push(R.esc(R.tx(${v})));\n` : `out.push(R.tx(${v}));\n`);
        continue;
      }
      if (n.kind === 'if') {
        const { code, v } = lookupCode(scVar, n.path);
        parts.push(code);
        const tv = `_t${uid++}`;
        parts.push(`let ${tv}=Array.isArray(${v})?${v}.length>0:(${v}!==undefined&&${v}!==null&&${v}!==false&&${v}!==""&&${v}!==0);\n`);
        parts.push(`if(${tv}!==${n.not}){\n`);
        gen(n.then, scVar);
        parts.push('}');
        if (n.else !== null) { parts.push('else{\n'); gen(n.else, scVar); parts.push('}'); }
        parts.push('\n');
        continue;
      }
      if (n.kind === 'for') {
        const { code, v } = lookupCode(scVar, n.path);
        const xs = v;
        const k = `_k${uid++}`, len = `_n${uid++}`, sc2 = `_c${uid++}`;
        parts.push(code);
        parts.push(`if(Array.isArray(${xs})){const ${len}=${xs}.length;for(let ${k}=0;${k}<${len};${k}++){const ${sc2}={vars:{[${JSON.stringify(n.name)}]:${xs}[${k}],loop:{index:${k}+1,first:${k}===0,last:${k}===${len}-1,length:${len}}},parent:${scVar}};\n`);
        gen(n.body, sc2);
        parts.push('}}\n');
        continue;
      }
      if (n.kind === 'include') {
        const f = `_f${uid++}`;
        parts.push(`if(dp<8){const ${f}=R.t.get(${JSON.stringify(n.name)});if(${f}!==undefined)out.push(${f}(${scVar},R,dp+1));}\n`);
        continue;
      }
    }
  }
  gen(nodes, 'sc');
  parts.push('return out.join("");');
  return new Function('sc', 'R', 'dp', parts.join(''));
}

// ---------------------------------------------------------------- build
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export function run(input) {
  const ctx = { slugCache: new Map(), longCache: new Map() };
  const report = [];
  const compiled = new Map();
  const allNodes = new Map();
  const templateNames = new Set();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      templateNames.add(name);
      allNodes.set(name, nodes);
      try { compiled.set(name, compileTemplate(nodes)); }
      catch { compiled.set(name, (sc, R2, dp) => renderNodes(nodes, sc, { templates: allNodes }, dp)); }
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const R = { t: compiled, esc: escapeHtml, tx: textOf };

  // 1. sources
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templateNames.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // 3. permalinks
  const bySource = new Map();
  const taken = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(ctx, s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. markdown
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const linkCache = new Map();
    const env = {
      link: (target) => {
        if (linkCache.has(target)) {
          const hit = linkCache.get(target);
          if (hit === null) broken.add(`broken-link ${s.path} -> ${target}`);
          return hit === null ? target : hit;
        }
        let result = null;
        let ok = false;
        const c0 = target.charCodeAt(0);
        if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
          // scheme? [A-Za-z][A-Za-z0-9+.-]*:
          let j = 1;
          while (j < target.length) {
            const cc = target.charCodeAt(j);
            if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 43 || cc === 45 || cc === 46) j++;
            else break;
          }
          if (j < target.length && target.charCodeAt(j) === 58) ok = true;
        }
        if (ok || target.startsWith('/') || target.startsWith('#')) {
          linkCache.set(target, target);
          return target;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) { result = `${bySource.get(path).url}${frag}`; linkCache.set(target, result); return result; }
        if (path !== null && staticPaths.has(path)) { result = `${base}/${path}${frag}`; linkCache.set(target, result); return result; }
        linkCache.set(target, null);
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(ctx, s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. collections
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(ctx, name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(ctx, name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) if (!s.post) s.tagRefs = ownTags(s).map((name) => {
    const slug = slugify(ctx, name);
    return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
  });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // cards / pages
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDateCached(ctx, s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDateCached(ctx, s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const s of kept) s.card = cardOf(s);
  const cards = new Map(posts.map((p) => [p, p.card]));

  // 7. layouts
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    return fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, R, 0);
  };
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. report
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
