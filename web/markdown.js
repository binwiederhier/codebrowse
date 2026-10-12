'use strict';
// Markdown preview: a small GitHub-flavoured Markdown renderer (headings, lists, task lists, tables,
// blockquotes, fenced code, reference links, raw HTML) plus a DOM sanitizer for its output.
// Block elements carry data-line (0-based source line) so the editor and preview can scroll in sync.
// Raw HTML is passed through by renderMarkdownDoc and must go through sanitizeMarkdownHTML.

const MD_RE = {
  fence: /^( {0,3})(`{3,}|~{3,})(.*)$/,
  atx: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  quote: /^ {0,3}> ?/,
  list: /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/,
  html: /^ {0,3}(?:<\/?[A-Za-z][\w-]*(?:[\s/>]|$)|<!--)/,
  setext1: /^ {0,3}=+[ \t]*$/,
  setext2: /^ {0,3}-+[ \t]*$/,
  tableDelim: /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/,
  ref: /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/,
};

const mdEsc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// mdEscText escapes text but keeps entities like &copy; and &#169; intact.
const mdEscText = s => s.replace(/&(?!#?\w+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mdBlank = l => !l.trim();
const mdIndent = l => /^ */.exec(l)[0].length;
const mdRefKey = s => s.trim().replace(/\s+/g, ' ').toLowerCase();

// renderMarkdownDoc renders a Markdown document to HTML. opts.highlight(code, lang) returns the HTML
// for a fenced code block with a language; mermaid blocks are left as source for the diagram renderer.
function renderMarkdownDoc(src, opts = {}) {
  const lines = src.split('\n').map(l => l.replace(/\r$/, '').replace(/^\t+/, m => '    '.repeat(m.length)));
  const ctx = { refs: new Map(), slugs: new Map(), highlight: opts.highlight };
  const nodes = mdParseBlocks(lines, 0, ctx);
  return mdRenderBlocks(nodes, ctx, false);
}

// ---- blocks

// mdStartsBlock reports whether line interrupts a paragraph.
function mdStartsBlock(line) {
  if (MD_RE.atx.test(line) || MD_RE.fence.test(line) || MD_RE.hr.test(line) || MD_RE.quote.test(line) || MD_RE.html.test(line)) return true;
  const m = MD_RE.list.exec(line);
  return !!(m && m[4].trim() && (!/\d/.test(m[2]) || parseInt(m[2], 10) === 1));
}

const mdSplitRow = line => {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
};

function mdParseBlocks(lines, base, ctx) {
  const nodes = [], n = lines.length;
  let i = 0;
  const push = (node, start, end) => { node.line = base + start; node.start = start; node.end = end; nodes.push(node); };
  while (i < n) {
    const line = lines[i];
    if (mdBlank(line)) { i++; continue; }
    let m;

    // Fenced code
    if ((m = MD_RE.fence.exec(line)) && !(m[2][0] === '`' && m[3].includes('`'))) {
      const ind = m[1].length, fence = m[2], lang = m[3].trim().split(/\s+/)[0].replace(/^\{?\.?|\}$/g, '').toLowerCase();
      const body = [];
      let j = i + 1;
      const close = new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}[ \\t]*$');
      while (j < n && !close.test(lines[j])) { body.push(lines[j].slice(Math.min(ind, mdIndent(lines[j])))); j++; }
      push({ type: 'code', lang, text: body.join('\n') }, i, Math.min(j, n - 1));
      i = j + 1; continue;
    }

    // ATX heading
    if ((m = MD_RE.atx.exec(line))) { push({ type: 'heading', level: m[1].length, text: (m[2] || '').trim() }, i, i); i++; continue; }

    // Thematic break
    if (MD_RE.hr.test(line)) { push({ type: 'hr' }, i, i); i++; continue; }

    // Blockquote (with lazy continuation lines)
    if (MD_RE.quote.test(line)) {
      const q = [];
      let j = i;
      while (j < n) {
        const l = lines[j];
        if (MD_RE.quote.test(l)) q.push(l.replace(MD_RE.quote, ''));
        else if (!mdBlank(l) && q.length && !mdBlank(q[q.length - 1]) && !mdStartsBlock(l)) q.push(l);
        else break;
        j++;
      }
      push({ type: 'quote', children: mdParseBlocks(q, base + i, ctx) }, i, j - 1);
      i = j; continue;
    }

    // List
    if ((m = MD_RE.list.exec(line))) {
      const j = mdParseList(lines, i, base, ctx, push);
      if (j > i) { i = j; continue; }
    }

    // Indented code
    if (mdIndent(line) >= 4) {
      const body = [];
      let j = i;
      while (j < n && (mdBlank(lines[j]) || mdIndent(lines[j]) >= 4)) { body.push(lines[j].slice(4)); j++; }
      while (body.length && mdBlank(body[body.length - 1])) { body.pop(); j--; }
      push({ type: 'code', lang: '', text: body.join('\n') }, i, j - 1);
      i = j; continue;
    }

    // Raw HTML block: up to a blank line (or the end of a comment)
    if (MD_RE.html.test(line)) {
      let j = i;
      if (/^ {0,3}<!--/.test(line)) { while (j < n && !lines[j].includes('-->')) j++; j++; }
      else while (j < n && !mdBlank(lines[j])) j++;
      j = Math.min(j, n);
      push({ type: 'html', text: lines.slice(i, j).join('\n') }, i, j - 1);
      i = j; continue;
    }

    // Link reference definitions
    if ((m = MD_RE.ref.exec(line))) {
      const key = mdRefKey(m[1]);
      if (!ctx.refs.has(key)) ctx.refs.set(key, { href: m[2], title: m[3] || m[4] || m[5] || '' });
      i++; continue;
    }

    // Table: a header row followed by a delimiter row with the same number of cells
    if (line.includes('|') && i + 1 < n && MD_RE.tableDelim.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = mdSplitRow(line), delim = mdSplitRow(lines[i + 1]);
      if (head.length === delim.length) {
        const align = delim.map(d => d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? 'right' : d.startsWith(':') ? 'left' : '');
        const rows = [];
        let j = i + 2;
        while (j < n && !mdBlank(lines[j]) && lines[j].includes('|') && !mdStartsBlock(lines[j])) { rows.push(mdSplitRow(lines[j])); j++; }
        push({ type: 'table', head, align, rows }, i, j - 1);
        i = j; continue;
      }
    }

    // Paragraph, possibly a setext heading
    const para = [line];
    let j = i + 1, level = 0;
    while (j < n) {
      const l = lines[j];
      if (mdBlank(l)) break;
      if (MD_RE.setext1.test(l)) { level = 1; break; }
      if (MD_RE.setext2.test(l)) { level = 2; break; }
      if (mdStartsBlock(l)) break;
      para.push(l); j++;
    }
    const text = para.map(l => l.replace(/^ +/, '')).join('\n').replace(/\s+$/, '');
    if (level) { push({ type: 'heading', level, text }, i, j); i = j + 1; }
    else { push({ type: 'para', text }, i, j - 1); i = j; }
  }
  return nodes;
}

// mdParseList parses the list starting at lines[i] and returns the index after it.
function mdParseList(lines, i, base, ctx, push) {
  const n = lines.length, first = MD_RE.list.exec(lines[i]);
  const ordered = /\d/.test(first[2]), marker = first[2].slice(-1);
  const items = [], start = i;
  let loose = false;
  while (i < n) {
    const m = MD_RE.list.exec(lines[i]);
    if (!m || MD_RE.hr.test(lines[i]) || /\d/.test(m[2]) !== ordered || m[2].slice(-1) !== marker) break;
    const w = m[1].length + m[2].length;
    const ci = w + (m[3].length > 4 || !m[4] ? 1 : m[3].length);
    const body = [m[4]];
    let j = i + 1;
    while (j < n) {
      const l = lines[j];
      if (mdBlank(l)) body.push('');
      else if (mdIndent(l) >= ci) body.push(l.slice(ci));
      else if (!mdBlank(body[body.length - 1]) && !mdStartsBlock(l) && !MD_RE.list.test(l)) body.push(l.trim());
      else break;
      j++;
    }
    let trailing = 0;
    while (body.length > 1 && mdBlank(body[body.length - 1])) { body.pop(); trailing++; }
    let task = null;
    const tm = /^\[([ xX])\][ \t]+/.exec(body[0]);
    if (tm) { task = tm[1] !== ' ' ? 'checked' : 'open'; body[0] = body[0].slice(tm[0].length); }
    const children = mdParseBlocks(body, base + i, ctx);
    // A blank line between two blocks of an item makes the list loose
    for (let k = 1; k < children.length; k++) {
      for (let b = children[k - 1].end + 1; b < children[k].start; b++) if (mdBlank(body[b])) loose = true;
    }
    items.push({ children, task });
    i = j;
    const next = i < n ? MD_RE.list.exec(lines[i]) : null;
    if (trailing && next && /\d/.test(next[2]) === ordered && next[2].slice(-1) === marker) loose = true;
  }
  if (!items.length) return start;
  push({ type: 'list', ordered, num: ordered ? parseInt(first[2], 10) : 1, items, loose }, start, i - 1);
  return i;
}

// ---- rendering

function mdSlug(ctx, html) {
  const text = html.replace(/<[^>]*>/g, '').replace(/&[#\w]+;/g, '');
  let slug = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  const seen = ctx.slugs.get(slug);
  ctx.slugs.set(slug, seen == null ? 0 : seen + 1);
  if (seen != null) slug += '-' + (seen + 1);
  return slug;
}

function mdRenderBlocks(nodes, ctx, tight) {
  let out = '';
  for (const b of nodes) {
    const dl = ` data-line="${b.line}"`;
    switch (b.type) {
      case 'heading': {
        const h = mdInline(b.text, ctx);
        out += `<h${b.level}${dl} data-anchor="${mdEsc(mdSlug(ctx, h))}">${h}</h${b.level}>\n`;
        break;
      }
      case 'para':
        out += tight ? mdInline(b.text, ctx) : `<p${dl}>${mdInline(b.text, ctx)}</p>\n`;
        break;
      case 'code':
        if (b.lang === 'mermaid') out += `<div class="mermaid-block"${dl}><pre class="mermaid-src">${mdEsc(b.text)}</pre></div>\n`;
        else if (b.lang && ctx.highlight) out += `<pre${dl} data-lang="${mdEsc(b.lang)}">${ctx.highlight(b.text, b.lang)}</pre>\n`;
        else out += `<pre${dl}${b.lang ? ` data-lang="${mdEsc(b.lang)}"` : ''}>${mdEsc(b.text)}</pre>\n`;
        break;
      case 'hr':
        out += `<hr${dl}>\n`;
        break;
      case 'quote':
        out += `<blockquote${dl}>\n${mdRenderBlocks(b.children, ctx, false)}</blockquote>\n`;
        break;
      case 'html':
        out += b.text + '\n';
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const tasks = b.items.some(it => it.task);
        out += `<${tag}${dl}${b.ordered && b.num !== 1 ? ` start="${b.num}"` : ''}${tasks ? ' class="tasks"' : ''}>\n`;
        for (const it of b.items) {
          const box = it.task ? `<input type="checkbox" disabled${it.task === 'checked' ? ' checked' : ''}> ` : '';
          out += `<li${it.task ? ' class="task"' : ''}>${box}${mdRenderBlocks(it.children, ctx, !b.loose)}</li>\n`;
        }
        out += `</${tag}>\n`;
        break;
      }
      case 'table': {
        const cell = (tag, c, k) => `<${tag}${b.align[k] ? ` align="${b.align[k]}"` : ''}>${mdInline(c, ctx)}</${tag}>`;
        out += `<table${dl}>\n<thead><tr>${b.head.map((c, k) => cell('th', c, k)).join('')}</tr></thead>\n`;
        if (b.rows.length) out += '<tbody>\n' + b.rows.map(r => '<tr>' + b.head.map((_, k) => cell('td', r[k] || '', k)).join('') + '</tr>\n').join('') + '</tbody>\n';
        out += '</table>\n';
        break;
      }
    }
  }
  return out;
}

// ---- inline

// mdInline renders inline Markdown. Constructs that must not be touched by later passes (code,
// links, raw tags, escapes) are swapped for \0N\0 placeholders and restored at the end.
function mdInline(text, ctx) {
  const ph = [];
  const hold = html => { ph.push(html); return '\0' + (ph.length - 1) + '\0'; };
  let s = mdInlineHold(text, ctx, hold);
  s = mdEscText(s);
  s = s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/\*(?=[^\s*])([\s\S]*?[^\s*])\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  for (let k = 0; k < 10 && s.includes('\0'); k++) s = s.replace(/\0(\d+)\0/g, (_, n) => ph[+n]);
  return s;
}

function mdInlineHold(s, ctx, hold) {
  const link = (href, title, inner) => `<a href="${mdEsc(href)}"${title ? ` title="${mdEsc(title)}"` : ''}>${inner}</a>`;
  const img = (src, title, alt) => `<img src="${mdEsc(src)}" alt="${mdEsc(alt.replace(/\0\d+\0/g, ''))}"${title ? ` title="${mdEsc(title)}"` : ''}>`;
  const label = '((?:[^\\[\\]]|\\[[^\\]]*\\])*)';
  return s
    // Code spans
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, t, c) => hold('<code>' + mdEsc(c.replace(/\n/g, ' ').replace(/^ (.*) $/, '$1')) + '</code>'))
    // Autolinks and raw inline HTML
    .replace(/<((?:https?|ftp|mailto):[^\s<>]+)>/g, (_, u) => hold(link(u, '', mdEsc(u))))
    .replace(/<([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>/g, (_, u) => hold(link('mailto:' + u, '', mdEsc(u))))
    .replace(/<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/g, m => hold(m))
    // Hard line breaks and backslash escapes
    .replace(/(?: {2,}|\\)\n/g, () => hold('<br>'))
    .replace(/\\([!-/:-@[-`{-~])/g, (_, c) => hold(mdEsc(c)))
    // Inline links and images; a link's label may hold an image (badges)
    .replace(new RegExp('(!?)\\[' + label + '\\]\\(\\s*(<[^>]*>|(?:[^\\s()]|\\([^\\s()]*\\))*)(?:\\s+("[^"]*"|\'[^\']*\'|\\([^)]*\\)))?\\s*\\)', 'g'), (_, bang, txt, href, title) => {
      href = href.replace(/^<(.*)>$/, '$1');
      title = title ? title.slice(1, -1) : '';
      return hold(bang ? img(href, title, txt) : link(href, title, mdInline(txt, ctx)));
    })
    // Reference links: [text][ref], [text][] and [ref]
    .replace(new RegExp('(!?)\\[' + label + '\\](?:\\[([^\\]]*)\\])?', 'g'), (m, bang, txt, ref) => {
      const r = ctx.refs.get(mdRefKey(ref || txt));
      if (!r) return m;
      return hold(bang ? img(r.href, r.title, txt) : link(r.href, r.title, mdInline(txt, ctx)));
    })
    // Bare URLs
    .replace(/(^|[\s(*_~])((?:https?:\/\/|www\.)[^\s<\0]*[^\s<\0.,:;"')\]!?*_~])/g, (_, pre, u) => pre + hold(link(u.startsWith('www.') ? 'http://' + u : u, '', mdEsc(u))));
}

// ---- sanitizer (browser only)

const MD_TAGS = new Set('A ABBR B BLOCKQUOTE BR CAPTION CENTER CITE CODE COL COLGROUP DD DEL DETAILS DFN DIV DL DT EM FIGCAPTION FIGURE H1 H2 H3 H4 H5 H6 HR I IMG INPUT INS KBD LI MARK OL P PICTURE PRE Q S SAMP SMALL SPAN STRIKE STRONG SUB SUMMARY SUP TABLE TBODY TD TFOOT TH THEAD TR TT U UL VAR'.split(' '));
const MD_DROP = new Set('SCRIPT STYLE IFRAME FRAME FRAMESET OBJECT EMBED APPLET FORM TEXTAREA SELECT BUTTON OPTION LINK META BASE TITLE NOSCRIPT TEMPLATE SVG MATH AUDIO VIDEO CANVAS SOURCE TRACK PORTAL'.split(' '));
const MD_ATTRS = new Set(['title', 'align', 'class', 'dir', 'lang', 'data-line', 'data-lang', 'data-anchor', 'href', 'src', 'alt', 'width', 'height', 'colspan', 'rowspan', 'start', 'open', 'checked', 'disabled', 'type', 'valign']);

// sanitizeMarkdownHTML parses html into an inert fragment and strips everything that could run
// script or restyle the page: only allowlisted tags and attributes survive, URLs must be safe.
function sanitizeMarkdownHTML(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walk = parent => {
    for (const el of [...parent.children]) {
      if (MD_DROP.has(el.tagName)) { el.remove(); continue; }
      walk(el);
      if (!MD_TAGS.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; }
      for (const a of [...el.attributes]) {
        const name = a.name.toLowerCase();
        if ((name === 'id' || name === 'name') && !el.hasAttribute('data-anchor')) el.setAttribute('data-anchor', a.value.toLowerCase());
        if (!MD_ATTRS.has(name)) { el.removeAttribute(a.name); continue; }
        const v = a.value.replace(/[\0-\x20]/g, '').toLowerCase();
        if ((name === 'href' || name === 'src') && /^(javascript|vbscript|data):/.test(v) && !(name === 'src' && v.startsWith('data:image/'))) el.removeAttribute(a.name);
      }
      if (el.tagName === 'INPUT') {
        if ((el.getAttribute('type') || '').toLowerCase() !== 'checkbox') { el.remove(); continue; }
        el.setAttribute('disabled', '');
      }
    }
  };
  walk(tpl.content);
  return tpl.content;
}

if (typeof module !== 'undefined') module.exports = { renderMarkdownDoc };
