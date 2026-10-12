// Tests for web/markdown.js, the Markdown preview renderer. Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdownDoc } = require('../web/markdown.js');

const md = (src, opts) => renderMarkdownDoc(src, opts).replace(/ data-line="\d+"/g, '');

test('headings get anchors and source lines', () => {
  assert.strictEqual(renderMarkdownDoc('# Hello World\n\ntext'), '<h1 data-line="0" data-anchor="hello-world">Hello World</h1>\n<p data-line="2">text</p>\n');
  assert.strictEqual(md('Title\n=====\nSub\n---'), '<h1 data-anchor="title">Title</h1>\n<h2 data-anchor="sub">Sub</h2>\n');
  assert.strictEqual(md('## Foo ##'), '<h2 data-anchor="foo">Foo</h2>\n');
});

test('duplicate heading anchors are numbered like GitHub', () => {
  assert.match(md('# A\n# A'), /data-anchor="a".*data-anchor="a-1"/s);
});

test('inline formatting', () => {
  assert.strictEqual(md('**b** *i* _i_ ~~s~~ `c<d>` snake_case_word'), '<p><strong>b</strong> <em>i</em> <em>i</em> <del>s</del> <code>c&lt;d&gt;</code> snake_case_word</p>\n');
  assert.strictEqual(md('a\\*b\\*'), '<p>a*b*</p>\n');
  assert.strictEqual(md('line one  \nline two'), '<p>line one<br>line two</p>\n');
});

test('links, images, autolinks and references', () => {
  assert.strictEqual(md('[x](docs/a.md "T")'), '<p><a href="docs/a.md" title="T">x</a></p>\n');
  assert.strictEqual(md('![alt](img.png)'), '<p><img src="img.png" alt="alt"></p>\n');
  assert.strictEqual(md('[![badge](b.svg)](https://ci)'), '<p><a href="https://ci"><img src="b.svg" alt="badge"></a></p>\n');
  assert.strictEqual(md('see https://example.com/a_b.'), '<p>see <a href="https://example.com/a_b">https://example.com/a_b</a>.</p>\n');
  assert.strictEqual(md('<https://x.org>'), '<p><a href="https://x.org">https://x.org</a></p>\n');
  assert.strictEqual(md('[a][r] and [r]\n\n[r]: http://r.io'), '<p><a href="http://r.io">a</a> and <a href="http://r.io">r</a></p>\n');
});

test('fenced code is highlighted via the callback, mermaid is left for the diagram renderer', () => {
  const opts = { highlight: (code, lang) => `[${lang}:${code}]` };
  assert.strictEqual(md('```go\nx := 1\n```', opts), '<pre data-lang="go">[go:x := 1]</pre>\n');
  assert.strictEqual(md('~~~\n<a>\n~~~'), '<pre>&lt;a&gt;</pre>\n');
  assert.strictEqual(md('```mermaid\ngraph TD\n  A-->B\n```'), '<div class="mermaid-block"><pre class="mermaid-src">graph TD\n  A--&gt;B</pre></div>\n');
  assert.strictEqual(md('    indented\n    code'), '<pre>indented\ncode</pre>\n');
});

test('lists: nested, ordered, tasks, loose', () => {
  assert.strictEqual(md('- a\n- b\n  - c\n- d'), '<ul>\n<li>a</li>\n<li>b<ul>\n<li>c</li>\n</ul>\n</li>\n<li>d</li>\n</ul>\n');
  assert.strictEqual(md('3. x\n4. y'), '<ol start="3">\n<li>x</li>\n<li>y</li>\n</ol>\n');
  assert.strictEqual(md('- [ ] todo\n- [x] done'), '<ul class="tasks">\n<li class="task"><input type="checkbox" disabled> todo</li>\n<li class="task"><input type="checkbox" disabled checked> done</li>\n</ul>\n');
  assert.strictEqual(md('- a\n\n- b'), '<ul>\n<li><p>a</p>\n</li>\n<li><p>b</p>\n</li>\n</ul>\n');
  assert.strictEqual(md('- item\n\n  ```\n  code\n  ```'), '<ul>\n<li><p>item</p>\n<pre>code</pre>\n</li>\n</ul>\n');
});

test('blockquotes, rules and tables', () => {
  assert.strictEqual(md('> quoted\n> **text**'), '<blockquote>\n<p>quoted\n<strong>text</strong></p>\n</blockquote>\n');
  assert.strictEqual(md('a\n\n---\n\nb'), '<p>a</p>\n<hr>\n<p>b</p>\n');
  assert.strictEqual(md('| A | B |\n|:--|--:|\n| 1 | `a\\|b` |'), '<table>\n<thead><tr><th align="left">A</th><th align="right">B</th></tr></thead>\n<tbody>\n<tr><td align="left">1</td><td align="right"><code>a|b</code></td></tr>\n</tbody>\n</table>\n');
});

test('raw HTML passes through for the DOM sanitizer', () => {
  assert.strictEqual(md('<p align="center">\n  <img src="x.png">\n</p>'), '<p align="center">\n  <img src="x.png">\n</p>\n');
  assert.strictEqual(md('a <kbd>Ctrl</kbd> b'), '<p>a <kbd>Ctrl</kbd> b</p>\n');
});
