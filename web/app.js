'use strict';
// Codebrowse: read-only, IntelliJ-flavoured code browser backed by gopls.

const $ = (s, el = document) => el.querySelector(s);
const LH = 20;
const MAX_TABS = 20;

// ---------------------------------------------------------------- utilities

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const basename = p => p.slice(p.lastIndexOf('/') + 1);
const dirname = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const store = {
  get(k, d) { try { const v = localStorage.getItem('cb.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cb.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

async function api(path, params = {}, opts = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch('/api/' + path + (qs ? '?' + qs : ''), opts);
  if (res.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
  if (!res.ok) throw new Error((await res.text()).trim() || res.statusText);
  return res.json();
}

// scrollIntoView also scrolls overflow:hidden ancestors (the whole layout); only scroll the container.
function reveal(el, container, center) {
  if (!el || !container) return;
  const er = el.getBoundingClientRect(), cr = container.getBoundingClientRect();
  if (center) { if (er.top < cr.top || er.bottom > cr.bottom) container.scrollTop += er.top - cr.top - container.clientHeight / 2; return; }
  if (er.top < cr.top) container.scrollTop -= cr.top - er.top;
  else if (er.bottom > cr.bottom) container.scrollTop += er.bottom - cr.bottom;
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------------------------------------------------------------- icons

const ICON = {
  chev: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder: '<svg class="ic" viewBox="0 0 16 16"><path d="M1.5 3.5h4.3l1.5 1.5h7.2v8.5h-13z" fill="none" stroke="#AFB1B3" stroke-width="1.1" stroke-linejoin="round"/></svg>',
  folderIgn: '<svg class="ic" viewBox="0 0 16 16"><path d="M1.5 3.5h4.3l1.5 1.5h7.2v8.5h-13z" fill="none" stroke="#C9A26D" stroke-width="1.1" stroke-linejoin="round"/></svg>',
  module: '<svg class="ic" viewBox="0 0 16 16"><path d="M1.5 3.5h4.3l1.5 1.5h7.2v8.5h-13z" fill="none" stroke="#AFB1B3" stroke-width="1.1" stroke-linejoin="round"/><rect x="9" y="9" width="6" height="6" rx="1" fill="#3592C4"/></svg>',
  go: '<svg class="ic" viewBox="0 0 16 16"><path d="M3 1.5h7l3 3v10H3z" fill="#2A3B52" stroke="#4C9CE0" stroke-width="1"/><text x="8" y="12.2" text-anchor="middle" font-size="5.6" font-weight="700" fill="#7EC3FF" font-family="Inter,sans-serif">GO</text></svg>',
  gotest: '<svg class="ic" viewBox="0 0 16 16"><path d="M3 1.5h7l3 3v10H3z" fill="#2A3B52" stroke="#4C9CE0" stroke-width="1"/><text x="8" y="12.2" text-anchor="middle" font-size="5.6" font-weight="700" fill="#7EC3FF" font-family="Inter,sans-serif">GO</text><circle cx="12.5" cy="12.5" r="3" fill="#5FB865"/></svg>',
  md: '<svg class="ic" viewBox="0 0 16 16"><text x="8" y="11.5" text-anchor="middle" font-size="7.5" font-weight="700" fill="#548AF7" font-family="Inter,sans-serif">M↓</text></svg>',
  file: '<svg class="ic" viewBox="0 0 16 16"><path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="#AFB1B3" stroke-width="1"/></svg>',
  cfg: '<svg class="ic" viewBox="0 0 16 16"><path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="#AFB1B3" stroke-width="1"/><path d="M5.5 8h5M5.5 10.5h5" stroke="#E5C07B" stroke-width="1.1"/></svg>',
  code: '<svg class="ic" viewBox="0 0 16 16"><path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="#AFB1B3" stroke-width="1"/><path d="M6.5 7.5l-1.5 1.5 1.5 1.5M9.5 7.5l1.5 1.5-1.5 1.5" fill="none" stroke="#C77DBB" stroke-width="1.1"/></svg>',
  lock: '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="3.5" y="7" width="9" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
};

function fileIcon(name) {
  if (name.endsWith('_test.go')) return ICON.gotest;
  if (name.endsWith('.go')) return ICON.go;
  if (/\.(md|markdown)$/i.test(name)) return ICON.md;
  if (/^(go\.mod|go\.sum|go\.work|go\.work\.sum|Makefile|Dockerfile)$|\.(ya?ml|toml|json|ini|conf|cfg|env)$/i.test(name)) return ICON.cfg;
  if (/\.(ts|tsx|js|jsx|mjs|py|sh|bash|zsh|proto|sql|rs|c|h|cpp|java|css|html)$/i.test(name)) return ICON.code;
  return ICON.file;
}

function projectColor(name) {
  const colors = ['#C27D3E', '#3D8BCD', '#7A57D1', '#3D9A6A', '#C24E6A', '#A0862E', '#2E8C9A'];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return colors[h % colors.length];
}
const gitBadge = (branch, dirty) => branch ? `<span class="tbranch">${esc(branch)}</span>${dirty ? '<span class="tdirty" title="Uncommitted changes">★</span>' : ''}` : '';
const projectInitials = n => (n.replace(/[^A-Za-z0-9]/g, ' ').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2) || '?').toUpperCase();

// ---------------------------------------------------------------- lexers

const GO_KW = new Set('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'.split(' '));
const GO_CONST = new Set(['true', 'false', 'nil', 'iota']);
const GO_BT = new Set('bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any comparable'.split(' '));
const NUM_RE = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|[0-9][0-9_]*\.?[0-9_]*(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?)i?/;
const isIdStart = c => /[A-Za-z_À-￿]/.test(c);
const isIdPart = c => /[A-Za-z0-9_À-￿]/.test(c);

function lexGo(lines) {
  const out = [];
  let st = null;
  for (const line of lines) {
    const toks = [];
    const n = line.length;
    let i = 0, prev = '';
    while (i < n) {
      if (st === 'bc') { const e = line.indexOf('*/', i); if (e < 0) { toks.push([i, n, 'cm']); i = n; } else { toks.push([i, e + 2, 'cm']); i = e + 2; st = null; } continue; }
      if (st === 'raw') { const e = line.indexOf('`', i); if (e < 0) { toks.push([i, n, 'str']); i = n; } else { toks.push([i, e + 1, 'str']); i = e + 1; st = null; } continue; }
      const c = line[i];
      if (c === '/' && line[i + 1] === '/') { toks.push([i, n, 'cm']); break; }
      if (c === '/' && line[i + 1] === '*') { st = 'bc'; toks.push([i, i + 2, 'cm']); i += 2; continue; }
      if (c === '`') { st = 'raw'; toks.push([i, i + 1, 'str']); i++; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && line[j] !== c) { if (line[j] === '\\') j++; j++; }
        toks.push([i, Math.min(j + 1, n), 'str']); i = j + 1; continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(line[i + 1] || ''))) {
        const m = NUM_RE.exec(line.slice(i, i + 64)); const len = m ? m[0].length : 1;
        toks.push([i, i + len, 'num']); i += len; continue;
      }
      if (isIdStart(c)) {
        let j = i + 1;
        while (j < n && isIdPart(line[j])) j++;
        const w = line.slice(i, j);
        let cls;
        if (GO_KW.has(w)) cls = 'kw';
        else if (GO_CONST.has(w)) cls = 'kw tk';
        else if (GO_BT.has(w)) cls = 'bt tk';
        else {
          let k = j; while (line[k] === ' ') k++;
          cls = (line[k] === '(' || line[k] === '[' && prev === 'func' || prev === 'func') ? 'fn tk' : 'id tk';
        }
        toks.push([i, j, cls]); prev = w; i = j; continue;
      }
      if (c !== ' ' && c !== '\t') prev = c;
      i++;
    }
    out.push(toks);
  }
  return out;
}

const LANGS = {
  js: { line: '//', block: true, q: '"\'`', kw: 'async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof interface let new of return static super switch this throw try type typeof var void while with yield enum implements private public protected readonly as declare namespace abstract keyof never unknown true false null undefined' },
  py: { line: '#', q: '"\'', kw: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self' },
  sh: { line: '#', q: '"\'', kw: 'if then else elif fi for while do done case esac in function return local export set unset echo exit source' },
  yaml: { line: '#', q: '"\'', kw: 'true false null yes no on off', keys: /^(\s*-?\s*)([A-Za-z0-9_.\-/"']+)(\s*:)(\s|$)/ },
  toml: { line: '#', q: '"\'', kw: 'true false', keys: /^(\s*)([A-Za-z0-9_.\-"]+)(\s*=)/ },
  proto: { line: '//', block: true, q: '"', kw: 'syntax package import option message service rpc returns stream repeated optional required enum oneof map reserved extend true false bool string bytes int32 int64 uint32 uint64 sint32 sint64 fixed32 fixed64 double float' },
  json: { q: '"', kw: 'true false null', jsonKeys: true },
  sql: { line: '--', block: true, q: '\'"', kw: 'select from where and or not insert into values update set delete create table index alter drop add column primary key foreign references on join left right inner outer group by order having limit offset as null is in exists distinct case when then else end begin commit rollback default unique constraint if returning with union all text integer bigint boolean timestamp timestamptz uuid jsonb varchar', ci: true },
  c: { line: '//', block: true, q: '"\'', kw: 'auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace public private protected template typename using virtual bool true false nullptr new delete this' },
  rs: { line: '//', block: true, q: '"', kw: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while' },
  css: { line: null, block: true, q: '"\'', kw: '' },
  make: { line: '#', q: '"\'', kw: 'ifeq ifneq ifdef ifndef else endif include define endef export' },
  md: { md: true },
  text: {},
};

function langOf(path) {
  const b = basename(path).toLowerCase();
  if (b.endsWith('.go')) return 'go';
  if (/^(makefile|gnumakefile)$|\.mk$/.test(b)) return 'make';
  if (/^dockerfile/.test(b) || /\.(sh|bash|zsh|env)$/.test(b) || b === '.envrc') return 'sh';
  const ext = b.includes('.') ? b.slice(b.lastIndexOf('.') + 1) : '';
  const map = { ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', java: 'c', kt: 'c', swift: 'c', cs: 'c', py: 'py', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'toml', proto: 'proto', json: 'json', sql: 'sql', c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c', rs: 'rs', css: 'css', scss: 'css', md: 'md', markdown: 'md', mod: 'go.mod', work: 'go.mod', html: 'text' };
  return map[ext] || 'text';
}

function lexGeneric(lines, lang) {
  if (lang === 'go.mod') lang = 'gomod';
  const L = lang === 'gomod' ? { line: '//', q: '"', kw: 'module go require replace exclude use toolchain retract' } : (LANGS[lang] || {});
  const kw = new Set((L.kw || '').split(' ').filter(Boolean));
  const out = [];
  let inBlock = false, fence = false;
  for (const line of lines) {
    const toks = [];
    const n = line.length;
    if (L.md) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; toks.push([0, n, 'str']); }
      else if (fence) toks.push([0, n, 'str']);
      else if (/^#{1,6}\s/.test(line)) toks.push([0, n, 'mdh']);
      else { const re = /`[^`]+`|\[[^\]]*\]\([^)]*\)|\*\*[^*]+\*\*/g; let m; while ((m = re.exec(line))) toks.push([m.index, m.index + m[0].length, m[0][0] === '`' ? 'str' : m[0][0] === '[' ? 'fn' : 'kw']); }
      out.push(toks); continue;
    }
    let i = 0;
    if (L.keys && !inBlock) { const m = L.keys.exec(line); if (m) { toks.push([m[1].length, m[1].length + m[2].length, 'key']); i = m[1].length + m[2].length; } }
    while (i < n) {
      if (inBlock) { const e = line.indexOf('*/', i); if (e < 0) { toks.push([i, n, 'cm']); i = n; } else { toks.push([i, e + 2, 'cm']); i = e + 2; inBlock = false; } continue; }
      const c = line[i];
      if (L.line && line.startsWith(L.line, i) && (L.line !== '#' || i === 0 || /\s/.test(line[i - 1]))) { toks.push([i, n, 'cm']); break; }
      if (L.block && c === '/' && line[i + 1] === '*') { inBlock = true; continue; }
      if (L.q && L.q.includes(c)) {
        let j = i + 1;
        while (j < n && line[j] !== c) { if (line[j] === '\\') j++; j++; }
        let k = j + 1; while (line[k] === ' ') k++;
        toks.push([i, Math.min(j + 1, n), L.jsonKeys && line[k] === ':' ? 'key' : 'str']); i = j + 1; continue;
      }
      if (/[0-9]/.test(c) && (i === 0 || !isIdPart(line[i - 1]))) { const m = NUM_RE.exec(line.slice(i, i + 64)); const len = m ? m[0].length : 1; toks.push([i, i + len, 'num']); i += len; continue; }
      if (isIdStart(c)) {
        let j = i + 1; while (j < n && (isIdPart(line[j]) || line[j] === '-' && lang === 'css')) j++;
        const w = line.slice(i, j);
        if (kw.has(L.ci ? w.toLowerCase() : w)) toks.push([i, j, 'kw']);
        else if (line[j] === '(' && lang !== 'sh' && lang !== 'make') toks.push([i, j, 'fn']);
        i = j; continue;
      }
      i++;
    }
    out.push(toks);
  }
  return out;
}

// ---------------------------------------------------------------- state

const S = {
  projects: [],
  pid: null,
  files: new Map(),     // path -> file state
  tabs: [],             // paths
  active: null,         // path
  recent: [],           // paths, most recent first
  tree: new Map(),      // rel dir -> entries
  expanded: new Set(),
  treeSel: null,        // rel path
  treeVersion: -1,
  status: {},
};

const proj = () => S.projects.find(p => p.id === S.pid);
const relInProject = path => { const p = proj(); return p && path.startsWith(p.path + '/') ? path.slice(p.path.length + 1) : null; };

function saveSession() {
  if (!S.pid) return;
  store.set('project', S.pid);
  store.set('tabs.' + S.pid, S.tabs.map(path => { const f = S.files.get(path); return { path, line: f ? f.caret.line : 0, col: f ? f.caret.col : 0 }; }));
  store.set('active.' + S.pid, S.active);
  store.set('recent.' + S.pid, S.recent.slice(0, 50));
  store.set('expanded.' + S.pid, [...S.expanded]);
}

// ---------------------------------------------------------------- projects

async function loadProjects() {
  S.projects = await api('projects');
}

async function switchProject(pid, { restore = true, skipActive = false } = {}) {
  saveSession();
  document.querySelectorAll('#editorWrap .code-scroll').forEach(el => el.remove());
  S.files.clear(); S.tabs = []; S.active = null; S.tree.clear(); S.treeSel = null; S.treeVersion = -1; S.status = {};
  S.pid = pid;
  const p = proj();
  S.expanded = new Set(store.get('expanded.' + pid, []));
  S.recent = store.get('recent.' + pid, []);
  renderProjectWidgets();
  renderTabs(); showEmpty(); updateStatusBar();
  if (!p) { $('#tree').innerHTML = '<div class="tree-msg">No project yet. Use the project menu above to add a folder.</div>'; return; }
  store.set('project', pid);
  await refreshTree(true);
  pollStatus();
  if (restore) {
    const tabs = store.get('tabs.' + pid, []);
    const active = store.get('active.' + pid, null);
    for (const t of tabs) { S.tabs.push(t.path); S.files.set(t.path, null); }
    S.tabs = S.tabs.filter((v, i, a) => a.indexOf(v) === i);
    for (const k of [...S.files.keys()]) if (S.files.get(k) === null) S.files.delete(k);
    S.pendingCarets = Object.fromEntries(tabs.map(t => [t.path, t]));
    renderTabs();
    const target = active && S.tabs.includes(active) ? active : S.tabs[0];
    if (target && !skipActive) { const t = S.pendingCarets[target] || {}; openFile(target, { line: t.line, col: t.col, push: false, center: true }).catch(() => {}); }
  }
}

function renderProjectWidgets() {
  const p = proj();
  const name = p ? p.name : 'No project';
  $('#projBtnName').textContent = name;
  $('#tbProjName').textContent = name;
  const badge = $('#tbProjBadge');
  badge.textContent = p ? projectInitials(p.name) : '?';
  badge.style.background = p ? projectColor(p.name) : '#555';
  document.title = p ? `${name} – Codebrowse` : 'Codebrowse';
}

function openProjectMenu(anchor) {
  const p = proj();
  const items = S.projects.map(pr => ({
    html: `<span class="mcheck">${pr.id === S.pid ? '✓' : ''}</span><span class="pbadge" style="background:${projectColor(pr.name)}">${esc(projectInitials(pr.name))}</span><span>${esc(pr.name)}</span><span class="msub">${esc(pr.path)}</span>`,
    action: () => { if (pr.id !== S.pid) switchProject(pr.id); },
  }));
  if (items.length) items.push('sep');
  items.push({ html: '<span class="mcheck">+</span><span>Add Project…</span>', action: addProjectDialog });
  if (p) {
    items.push('sep');
    items.push({ html: `<span class="mcheck">${p.show_ignored ? '✓' : ''}</span><span>Show Ignored &amp; Generated Files</span>`, action: async () => {
      const r = await api('projects/settings', { project: p.id, show_ignored: p.show_ignored ? '0' : '1' }, { method: 'POST' });
      p.show_ignored = r.show_ignored; S.tree.clear(); refreshTree(true);
    } });
    items.push({ html: '<span class="mcheck">⟳</span><span>Reindex Project</span>', action: async () => { await api('projects/reindex', { project: p.id }, { method: 'POST' }); toast('Reindexing ' + p.name + '…'); setTimeout(() => refreshTree(true), 1500); } });
    items.push({ html: `<span class="mcheck"></span><span>${p.auto ? 'Hide' : 'Remove'} “${esc(p.name)}” from List</span>`, action: async () => {
      if (!confirm(`${p.auto ? 'Hide' : 'Remove'} project "${p.name}" from the list? Files on disk are not touched.`)) return;
      await api('projects', { project: p.id }, { method: 'DELETE' });
      store.set('tabs.' + p.id, []);
      await loadProjects();
      switchProject(S.projects[0] ? S.projects[0].id : null);
    } });
  }
  showMenu(anchor, items);
}

function showMenu(anchor, items) {
  const m = $('#menu');
  m.innerHTML = '';
  for (const it of items) {
    if (it === 'sep') { m.insertAdjacentHTML('beforeend', '<div class="msep"></div>'); continue; }
    const d = document.createElement('div');
    d.className = 'mi'; d.innerHTML = it.html;
    d.addEventListener('click', () => { hideMenu(); it.action(); });
    m.appendChild(d);
  }
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - 540)) + 'px';
  m.style.top = (r.bottom + 4) + 'px';
  m.classList.remove('hidden');
}
const hideMenu = () => $('#menu').classList.add('hidden');

function addProjectDialog() {
  const back = $('#modalBack');
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="form"><h2>Add Project</h2>
    <label>Folder</label><input class="path" spellcheck="false" placeholder="~/src/..." autocomplete="off">
    <div class="sugg hidden"></div>
    <label>Name</label><input class="name" spellcheck="false" placeholder="defaults to folder name">
    <div class="err"></div>
    <div class="row-btns"><button class="btn cancel">Cancel</button><button class="btn primary ok">Add &amp; Index</button></div></div>`;
  document.body.appendChild(m); back.classList.remove('hidden');
  const pathIn = $('.path', m), nameIn = $('.name', m), sugg = $('.sugg', m), err = $('.err', m);
  let suggestions = [], si = -1;
  const close = () => { m.remove(); back.classList.add('hidden'); back.onclick = null; };
  back.onclick = close;
  const renderSugg = () => {
    sugg.classList.toggle('hidden', !suggestions.length);
    sugg.innerHTML = suggestions.map((s, i) => `<div class="${i === si ? 'sel' : ''}">${esc(s)}</div>`).join('');
    [...sugg.children].forEach((d, i) => d.onclick = () => { pathIn.value = suggestions[i]; pathIn.focus(); complete(); });
  };
  let ct;
  const complete = () => { clearTimeout(ct); ct = setTimeout(async () => { try { suggestions = await api('complete', { path: pathIn.value }); si = -1; renderSugg(); } catch { /* ignore */ } }, 80); };
  pathIn.addEventListener('input', complete);
  pathIn.addEventListener('focus', complete);
  pathIn.addEventListener('keydown', e => {
    if (e.key === 'Tab' && suggestions.length) { e.preventDefault(); pathIn.value = suggestions[Math.max(si, 0)]; complete(); }
    else if (e.key === 'ArrowDown' && suggestions.length) { e.preventDefault(); si = (si + 1) % suggestions.length; renderSugg(); }
    else if (e.key === 'ArrowUp' && suggestions.length) { e.preventDefault(); si = (si - 1 + suggestions.length) % suggestions.length; renderSugg(); }
    else if (e.key === 'Enter' && si >= 0) { e.preventDefault(); pathIn.value = suggestions[si]; si = -1; complete(); }
    else if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  m.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  $('.cancel', m).onclick = close;
  $('.ok', m).onclick = submit;
  async function submit() {
    err.textContent = '';
    try {
      const pc = await api('projects', {}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: pathIn.value.replace(/\/+$/, '') || pathIn.value, name: nameIn.value }) });
      close();
      await loadProjects();
      switchProject(pc.id);
      toast('Indexing ' + pc.name + ' in the background…');
    } catch (e) { err.textContent = e.message; }
  }
  pathIn.value = '~/';
  pathIn.focus();
}

// ---------------------------------------------------------------- tree

async function fetchDir(rel) {
  const ents = await api('tree', { project: S.pid, dir: rel });
  S.tree.set(rel, ents);
  return ents;
}

async function refreshTree(force) {
  if (!S.pid) return;
  if (force) S.tree.clear();
  const dirs = ['', ...[...S.expanded].sort()];
  await Promise.all(dirs.map(d => fetchDir(d).catch(() => { S.expanded.delete(d); })));
  renderTree();
}

function renderTree() {
  const p = proj();
  const el = $('#tree');
  if (!p) return;
  const out = [];
  const rootOpen = !S.expanded.has('!root');
  out.push(`<div class="trow root ${rootOpen ? 'open' : ''} ${S.treeSel === '' ? 'sel' : ''}" data-p="" data-d="1" style="padding-left:6px"><span class="tw">${ICON.chev}</span>${ICON.folder}<span class="tn">${esc(p.name)}</span>${gitBadge(S.status.branch, S.status.dirty)}<span class="tpath">${esc(p.path.replace(/^\/home\/[^/]+/, '~'))}</span></div>`);
  const walk = (dir, depth) => {
    const ents = S.tree.get(dir);
    if (!ents) return;
    for (const e of ents) {
      const rel = dir ? dir + '/' + e.name : e.name;
      const pad = 6 + depth * 18;
      const cls = ['trow'];
      if (e.ignored) cls.push('ign');
      if (S.treeSel === rel) cls.push('sel');
      if (e.dir) {
        const open = S.expanded.has(rel) && S.tree.has(rel);
        if (open) cls.push('open');
        out.push(`<div class="${cls.join(' ')}" data-p="${esc(rel)}" data-d="1" style="padding-left:${pad}px" title="${e.reason ? esc(e.reason) : ''}"><span class="tw">${ICON.chev}</span>${e.ignored ? ICON.folderIgn : ICON.folder}<span class="tn">${esc(e.name)}</span>${gitBadge(e.branch, e.dirty)}</div>`);
        if (open) walk(rel, depth + 1);
      } else {
        if (e.name.endsWith('_test.go')) cls.push('test');
        out.push(`<div class="${cls.join(' ')}" data-p="${esc(rel)}" style="padding-left:${pad}px" title="${e.reason ? esc(e.reason) : ''}"><span class="tw"></span>${fileIcon(e.name)}<span class="tn">${esc(e.name)}</span></div>`);
      }
    }
  };
  if (rootOpen) walk('', 1);
  el.innerHTML = out.join('');
}

async function toggleDir(rel, open) {
  if (rel === '') {
    if (open === undefined) open = S.expanded.has('!root');
    if (open) S.expanded.delete('!root'); else S.expanded.add('!root');
    renderTree(); saveSession(); return;
  }
  if (open === undefined) open = !S.expanded.has(rel);
  if (open) {
    S.expanded.add(rel);
    if (!S.tree.has(rel)) await fetchDir(rel);
    // IntelliJ-style compaction: auto-expand single-child directory chains.
    let cur = rel;
    for (let i = 0; i < 10; i++) {
      const ents = S.tree.get(cur);
      if (!ents || ents.length !== 1 || !ents[0].dir) break;
      cur = cur + '/' + ents[0].name;
      S.expanded.add(cur);
      if (!S.tree.has(cur)) await fetchDir(cur);
    }
  } else S.expanded.delete(rel);
  renderTree(); saveSession();
}

function treeRows() { return [...$('#tree').querySelectorAll('.trow')]; }

function selectTreeRow(rel, scroll) {
  S.treeSel = rel;
  for (const r of treeRows()) r.classList.toggle('sel', r.dataset.p === rel);
  if (scroll) { const r = treeRows().find(r => r.dataset.p === rel); reveal(r, $('#tree'), scroll === 'center'); }
}

async function locateInTree() {
  const f = S.files.get(S.active);
  if (!f) return;
  const rel = relInProject(f.path);
  if (rel == null) { toast('File is outside the project'); return; }
  S.expanded.delete('!root');
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const d = parts.slice(0, i).join('/');
    S.expanded.add(d);
    if (!S.tree.has(d)) await fetchDir(d).catch(() => {});
  }
  renderTree();
  selectTreeRow(rel, 'center');
  $('#tree').focus();
  saveSession();
}

function initTree() {
  const el = $('#tree');
  el.addEventListener('click', e => {
    const row = e.target.closest('.trow'); if (!row) return;
    const rel = row.dataset.p;
    selectTreeRow(rel);
    if (row.dataset.d) toggleDir(rel);
    else openFile(proj().path + '/' + rel, { focus: false });
  });
  el.addEventListener('dblclick', e => {
    const row = e.target.closest('.trow'); if (!row || row.dataset.d) return;
    focusEditor();
  });
  el.addEventListener('keydown', e => {
    const rows = treeRows();
    let i = rows.findIndex(r => r.dataset.p === S.treeSel);
    const row = rows[i];
    const go = j => { j = Math.max(0, Math.min(rows.length - 1, j)); selectTreeRow(rows[j].dataset.p, true); };
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); go(i + 1); break;
      case 'ArrowUp': e.preventDefault(); go(i < 0 ? 0 : i - 1); break;
      case 'Home': e.preventDefault(); go(0); break;
      case 'End': e.preventDefault(); go(rows.length - 1); break;
      case 'PageDown': e.preventDefault(); go(i + 20); break;
      case 'PageUp': e.preventDefault(); go(i - 20); break;
      case 'ArrowRight':
        e.preventDefault();
        if (row && row.dataset.d) { if (!row.classList.contains('open')) toggleDir(row.dataset.p, true); else go(i + 1); }
        break;
      case 'ArrowLeft': {
        e.preventDefault();
        if (!row) break;
        if (row.dataset.d && row.classList.contains('open')) { toggleDir(row.dataset.p, false); break; }
        const parent = row.dataset.p.includes('/') ? dirname(row.dataset.p) : '';
        selectTreeRow(parent, true);
        break;
      }
      case 'Enter':
        e.preventDefault();
        if (!row) break;
        if (row.dataset.d) toggleDir(row.dataset.p);
        else openFile(proj().path + '/' + row.dataset.p);
        break;
    }
  });
  $('#btnLocate').addEventListener('click', locateInTree);
  $('#btnCollapse').addEventListener('click', () => { S.expanded.clear(); renderTree(); saveSession(); });
}

// ---------------------------------------------------------------- files / editor

function newFileState(data) {
  const lines = data.content.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
  const lang = data.binary ? 'text' : langOf(data.path);
  const f = {
    path: data.path, rel: data.rel, branch: data.branch, mtime: data.mtime, binary: data.binary,
    lines, lang, lex: null, sem: null, hints: null, symbols: [],
    caret: { line: 0, col: 0 }, wantCol: 0, hl: [], hlKey: '',
    el: null, inner: null, rowsEl: null, caretEl: null, stickyEl: null,
  };
  f.lex = data.binary ? lines.map(() => []) : (lang === 'go' ? lexGo(lines) : lexGeneric(lines, lang));
  f.indent = /^\t/m.test(data.content) ? 'Tab' : (/^ {2,}/m.test(data.content) ? '4 spaces' : 'Tab');
  return f;
}

const SEM_IDENT = new Set(['namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter', 'variable', 'property', 'enumMember', 'function', 'method', 'label', 'macro']);

function decodeSemantic(f, res) {
  if (!res || !res.data || !res.legend) return null;
  const types = res.legend.tokenTypes, mods = res.legend.tokenModifiers;
  const per = new Array(f.lines.length);
  let line = 0, ch = 0;
  const d = res.data;
  for (let i = 0; i + 4 < d.length; i += 5) {
    if (d[i]) { line += d[i]; ch = d[i + 1]; } else ch += d[i + 1];
    const t = types[d[i + 3]] || 'x';
    let cls = 's-' + t;
    const m = d[i + 4];
    if (m) for (let b = 0; b < mods.length; b++) if (m & (1 << b)) cls += ' m-' + mods[b];
    if (SEM_IDENT.has(t)) cls += ' tk';
    (per[line] || (per[line] = [])).push([ch, d[i + 2], cls]);
  }
  return per;
}

function lineHTML(f, i) {
  const text = f.lines[i];
  const n = text.length;
  if (n > 4000) return esc(text);
  const cls = new Array(n).fill('');
  const lex = f.lex[i];
  if (lex) for (const [s, e, c] of lex) for (let k = s; k < e && k < n; k++) cls[k] = c;
  const sem = f.sem && f.sem[i];
  if (sem) for (const [s, len, c] of sem) for (let k = s; k < s + len && k < n; k++) cls[k] = c;
  const hints = f.hints && f.hints[i];
  let out = '', j = 0, h = 0;
  while (true) {
    while (hints && h < hints.length && hints[h].char <= j) { out += `<span class="hint">${esc(hints[h].label)}</span>`; h++; }
    if (j >= n) break;
    const c = cls[j];
    const stop = hints && h < hints.length ? hints[h].char : Infinity;
    let k = j + 1;
    while (k < n && cls[k] === c && k < stop) k++;
    const t = esc(text.slice(j, k));
    out += c ? `<span class="${c}">${t}</span>` : t;
    j = k;
  }
  return out;
}

function rowHTML(f, i) {
  return `<div class="row" data-l="${i}"><span class="no">${i + 1}</span><span class="tx">${lineHTML(f, i)}</span></div>`;
}

function buildEditor(f) {
  const el = document.createElement('div');
  el.className = 'code-scroll';
  el.style.display = 'none';
  el.tabIndex = 0;
  el.style.setProperty('--gw', String(Math.max(3, String(f.lines.length).length)));
  el.innerHTML = '<div class="code-inner"><div class="sticky"><div class="sticky-rows"></div></div><div class="hls"></div><div class="rows"></div><div class="caret"></div></div>';
  f.el = el; f.inner = $('.code-inner', el); f.rowsEl = $('.rows', el); f.caretEl = $('.caret', el); f.stickyEl = $('.sticky-rows', el); f.hlsEl = $('.hls', el);
  if (f.binary) { f.rowsEl.innerHTML = `<div class="binary-msg">${esc(f.lines.join('\n'))}</div>`; }
  else renderRows(f);
  attachEditorEvents(f);
  $('#editorWrap').appendChild(el);
  return el;
}

function mergeRanges(rs) {
  const out = [];
  for (const r of [...rs].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else out.push([...r]);
  }
  return out;
}

function renderRows(f) {
  const parts = new Array(f.lines.length);
  for (let i = 0; i < f.lines.length; i++) parts[i] = rowHTML(f, i);
  f.rowsEl.innerHTML = parts.join('');
  f.rowEls = f.rowsEl.children;
  f.curRow = null;
  renderMarks(f);
  if (f.el && f.el.isConnected) { placeCaret(f, false); updateSticky(f); renderHighlights(f); }
}

const loading = new Map(); // path -> in-flight load, so concurrent opens share one editor

function loadFile(path) {
  if (loading.has(path)) return loading.get(path);
  const pid = S.pid;
  const pr = (async () => {
    const data = await api('file', { project: pid, path });
    if (pid !== S.pid) throw new Error('project changed');
    const existing = S.files.get(path);
    if (existing) return existing;
    const f = newFileState(data);
    buildEditor(f);
    S.files.set(path, f);
    if (f.lang === 'go' && !f.binary) loadSemantic(f);
    return f;
  })();
  loading.set(path, pr);
  pr.finally(() => loading.delete(path)).catch(() => {});
  return pr;
}

async function loadSemantic(f) {
  const params = { project: S.pid, path: f.path };
  const [sem, hints] = await Promise.allSettled([api('semantic', params), api('hints', params)]);
  if (S.files.get(f.path) !== f) return;
  let changed = false;
  if (sem.status === 'fulfilled' && sem.value && sem.value.data) { f.sem = decodeSemantic(f, sem.value); changed = true; }
  if (hints.status === 'fulfilled' && Array.isArray(hints.value)) {
    const per = [];
    for (const h of hints.value) (per[h.line] || (per[h.line] = [])).push(h);
    for (const l of per) if (l) l.sort((a, b) => a.char - b.char);
    f.hints = per; changed = true;
  }
  if (changed) renderRows(f);
  api('symbols', params).then(s => { f.symbols = s || []; updateSticky(f); updateCrumbs(); }).catch(() => {});
  f.semFailed = sem.status === 'rejected' || hints.status === 'rejected';
  if (f.semFailed && (f.semRetries = (f.semRetries || 0) + 1) <= 5) setTimeout(() => { if (S.files.get(f.path) === f) loadSemantic(f); }, 3000 * f.semRetries);
}

async function reloadIfChanged(f) {
  if (!f || f.checking) return;
  f.checking = true;
  try {
    const data = await api('file', { project: S.pid, path: f.path });
    if (data.mtime === f.mtime) return;
    const nf = newFileState(data);
    Object.assign(f, { lines: nf.lines, lex: nf.lex, mtime: nf.mtime, sem: null, hints: null, binary: nf.binary, indent: nf.indent });
    f.el.style.setProperty('--gw', String(Math.max(3, String(f.lines.length).length)));
    f.caret.line = Math.min(f.caret.line, f.lines.length - 1);
    renderRows(f);
    if (f.lang === 'go') loadSemantic(f);
  } catch { /* ignore */ } finally { f.checking = false; }
}

async function openFile(path, opts = {}) {
  const { line, col, push = true, focus = true, center = false, target = null } = opts;
  if (push) recordHistory(true);
  let f = S.files.get(path);
  if (!f) {
    try { f = await loadFile(path); }
    catch (e) {
      toast('Cannot open ' + basename(path) + ': ' + e.message);
      if (!S.files.get(path)) { S.tabs = S.tabs.filter(t => t !== path); renderTabs(); }
      throw e;
    }
  } else if (S.active !== path) reloadIfChanged(f);
  if (!S.tabs.includes(path)) {
    const ai = S.tabs.indexOf(S.active);
    S.tabs.splice(ai < 0 ? S.tabs.length : ai + 1, 0, path);
    while (S.tabs.length > MAX_TABS) { const victim = S.tabs.find(t => t !== path); closeTab(victim, true); }
  }
  activate(path);
  if (line != null) setCaret(f, line, col || 0, { scroll: center ? 'center' : 'auto' });
  else placeCaret(f, true);
  if (target) flashTarget(f, target);
  if (focus) focusEditor();
  S.recent = [path, ...S.recent.filter(p => p !== path)].slice(0, 50);
  if (push) recordHistory(false);
  saveSession();
  return f;
}

function activate(path) {
  S.active = path;
  const act = S.files.get(path);
  for (const el of document.querySelectorAll('#editorWrap .code-scroll')) el.style.display = act && el === act.el ? '' : 'none';
  showEmpty();
  renderTabs();
  updateStatusBar();
  const f = S.files.get(path);
  if (f) { updateCrumbs(); updateSticky(f); }
  const rel = relInProject(path);
  if (rel != null && treeRows().some(r => r.dataset.p === rel)) selectTreeRow(rel, true);
}

function showEmpty() { $('#empty').classList.toggle('hidden', !!S.active); }

function closeTab(path, quiet) {
  const i = S.tabs.indexOf(path);
  if (i < 0) return;
  S.tabs.splice(i, 1);
  const f = S.files.get(path);
  if (f) f.el.remove();
  S.files.delete(path);
  if (S.active === path) {
    S.active = null;
    const next = S.tabs[Math.min(i, S.tabs.length - 1)];
    if (next && !quiet) openFile(next, { push: false });
    else if (next) activate(next);
  }
  showEmpty(); renderTabs(); updateStatusBar(); updateCrumbs(); saveSession();
}

function renderTabs() {
  const el = $('#tabs');
  el.innerHTML = S.tabs.map(p => `<div class="tab ${p === S.active ? 'active' : ''}" data-p="${esc(p)}" title="${esc(p)}">${fileIcon(basename(p))}<span>${esc(basename(p))}</span><span class="tx-close"><svg viewBox="0 0 16 16" width="11" height="11"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></span></div>`).join('');
  const act = $('.tab.active', el);
  if (act) { const er = act.getBoundingClientRect(), cr = el.getBoundingClientRect(); if (er.left < cr.left) el.scrollLeft -= cr.left - er.left; else if (er.right > cr.right) el.scrollLeft += er.right - cr.right; }
}

function initTabs() {
  const el = $('#tabs');
  el.addEventListener('mousedown', e => {
    const tab = e.target.closest('.tab'); if (!tab) return;
    if (e.button === 1) { e.preventDefault(); closeTab(tab.dataset.p); return; }
    if (e.button !== 0) return;
    if (e.target.closest('.tx-close')) { closeTab(tab.dataset.p); return; }
    const f = S.files.get(tab.dataset.p);
    const t = S.pendingCarets && S.pendingCarets[tab.dataset.p];
    openFile(tab.dataset.p, f ? {} : { line: t ? t.line : 0, col: t ? t.col : 0, center: true }).catch(() => {});
  });
  el.addEventListener('wheel', e => { if (e.deltaY) { el.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
}

// ---- caret & positions

function rowEl(f, line) { return f.rowEls ? f.rowEls[line] : null; }

function* textNodes(tx) {
  const w = document.createTreeWalker(tx, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) { if (!n.parentNode.closest('.hint')) yield n; }
}

function domPos(f, line, col) {
  const row = rowEl(f, line);
  if (!row) return null;
  const tx = row.lastChild;
  let acc = 0, last = null;
  for (const t of textNodes(tx)) {
    if (col <= acc + t.length) return [t, col - acc];
    acc += t.length; last = t;
  }
  return last ? [last, last.length] : [tx, 0];
}

function colFromDom(row, node, offset) {
  const tx = row.lastChild;
  if (!tx.contains(node)) return 0;
  if (node.nodeType !== 3) {
    // Element + child index: count text before that child.
    const child = node.childNodes[offset];
    let acc = 0;
    for (const t of textNodes(tx)) { if (child && (child === t || child.contains(t))) return acc; acc += t.length; }
    return acc;
  }
  const inHint = node.parentNode.closest('.hint');
  let acc = 0;
  for (const t of textNodes(tx)) {
    if (t === node) return acc + offset;
    if (inHint && (node.parentNode.closest('.hint').compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING)) return acc;
    acc += t.length;
  }
  return acc;
}

function posFromPoint(f, x, y) {
  let node, offset;
  if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (!p) return null; node = p.offsetNode; offset = p.offset; }
  else if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (!r) return null; node = r.startContainer; offset = r.startOffset; }
  const el = node && (node.nodeType === 3 ? node.parentNode : node);
  let row = el && el.closest && el.closest('.row');
  if (!row || !f.rowsEl.contains(row)) {
    // Below the last line, or in padding: use the line under y.
    const top = f.rowsEl.getBoundingClientRect().top;
    const line = Math.max(0, Math.min(f.lines.length - 1, Math.floor((y - top) / LH)));
    return { line, col: f.lines[line].length };
  }
  const line = +row.dataset.l;
  if (row.firstChild.contains(node)) return { line, col: 0 };
  return { line, col: Math.min(colFromDom(row, node, offset), f.lines[line].length) };
}

function rectAt(f, line, col) {
  const dp = domPos(f, line, col);
  if (!dp) return null;
  const r = document.createRange();
  r.setStart(dp[0], dp[1]); r.setEnd(dp[0], dp[1]);
  let rect = r.getClientRects()[0] || r.getBoundingClientRect();
  if (!rect || (rect.left === 0 && rect.top === 0 && rect.width === 0)) rect = rowEl(f, line).lastChild.getBoundingClientRect();
  const base = f.inner.getBoundingClientRect();
  return { x: rect.left - base.left, y: line * LH + f.rowsEl.offsetTop };
}

function setCaret(f, line, col, { scroll = 'auto', keepWant = false } = {}) {
  line = Math.max(0, Math.min(f.lines.length - 1, line));
  col = Math.max(0, Math.min(f.lines[line].length, col));
  f.caret = { line, col };
  if (!keepWant) f.wantCol = col;
  placeCaret(f, scroll);
  updateStatusBar();
  updateCrumbs();
  scheduleHighlights(f);
  scheduleHistoryUpdate();
}

function placeCaret(f, scroll) {
  if (!f.rowEls || f.binary) return;
  const { line, col } = f.caret;
  const row = rowEl(f, line);
  if (f.curRow && f.curRow !== row) f.curRow.classList.remove('cur');
  if (row) { row.classList.add('cur'); f.curRow = row; }
  const r = rectAt(f, line, col);
  if (r) { f.caretEl.style.left = r.x + 'px'; f.caretEl.style.top = r.y + 'px'; f.caretEl.style.animation = 'none'; void f.caretEl.offsetWidth; f.caretEl.style.animation = ''; }
  if (scroll && r) scrollToCaret(f, r, scroll);
}

function scrollToCaret(f, r, mode) {
  const sc = f.el;
  const stickyH = f.stickyEl.offsetHeight;
  const top = r.y, view = sc.clientHeight;
  if (mode === 'center') {
    if (top < sc.scrollTop + stickyH + LH * 2 || top > sc.scrollTop + view - LH * 4) sc.scrollTop = top - view / 2 + LH;
  } else {
    if (top < sc.scrollTop + stickyH) sc.scrollTop = top - stickyH;
    else if (top + LH > sc.scrollTop + view) sc.scrollTop = top + LH - view;
  }
  const gutter = rowEl(f, 0) ? rowEl(f, 0).firstChild.offsetWidth : 60;
  if (r.x < sc.scrollLeft + gutter + 10) sc.scrollLeft = Math.max(0, r.x - gutter - 40);
  else if (r.x > sc.scrollLeft + sc.clientWidth - 30) sc.scrollLeft = r.x - sc.clientWidth + 80;
}

function wordAt(f, line, col) {
  const text = f.lines[line] || '';
  let s = col;
  if (!isIdPart(text[s] || '') && s > 0 && isIdPart(text[s - 1])) s--;
  if (!isIdPart(text[s] || '')) return null;
  let a = s, b = s;
  while (a > 0 && isIdPart(text[a - 1])) a--;
  while (b < text.length && isIdPart(text[b])) b++;
  return { line, start: a, end: b, word: text.slice(a, b) };
}

function flashTarget(f, t) {
  const row = rowEl(f, t.line);
  if (!row) return;
  const a = rectAt(f, t.line, t.char), b = rectAt(f, t.line, t.endChar || t.char);
  if (!a || !b) return;
  const box = document.createElement('div');
  box.className = 'hl-box target';
  Object.assign(box.style, { left: a.x + 'px', top: a.y + 'px', width: Math.max(8, b.x - a.x) + 'px' });
  f.hlsEl.appendChild(box);
  setTimeout(() => box.remove(), 1500);
}

// ---- document highlights (occurrences of the symbol under the caret)

let hlTimer;
function scheduleHighlights(f) {
  clearTimeout(hlTimer);
  hlTimer = setTimeout(() => loadHighlights(f), 180);
}

async function loadHighlights(f) {
  const w = wordAt(f, f.caret.line, f.caret.col);
  const key = w ? `${w.line}:${w.start}` : '';
  if (key === f.hlKey) return;
  f.hlKey = key;
  if (!w || f.lang !== 'go') { f.hl = []; renderHighlights(f); return; }
  try {
    const res = await api('highlights', { project: S.pid, path: f.path, line: w.line, char: w.start });
    if (f.hlKey !== key) return;
    f.hl = res || [];
  } catch { f.hl = []; }
  renderHighlights(f);
}

function renderHighlights(f) {
  if (!f.hlsEl) return;
  f.hlsEl.querySelectorAll('.hl-box:not(.target)').forEach(b => b.remove());
  if (!f.hl || f.hl.length > 500) return;
  const frag = document.createDocumentFragment();
  for (const h of f.hl) {
    const a = rectAt(f, h.line, h.char), b = rectAt(f, h.line, h.endChar);
    if (!a || !b) continue;
    const box = document.createElement('div');
    box.className = 'hl-box' + (h.kind === 3 ? ' write' : '');
    Object.assign(box.style, { left: a.x + 'px', top: a.y + 'px', width: Math.max(2, b.x - a.x) + 'px' });
    frag.appendChild(box);
  }
  f.hlsEl.appendChild(frag);
}

// ---- sticky lines & breadcrumbs

const CONTAINER_KINDS = new Set([5, 6, 9, 10, 11, 12, 23]); // class, method, constructor, enum, interface, function, struct

function enclosing(f, line) {
  return (f.symbols || []).filter(s => CONTAINER_KINDS.has(s.kind) && s.start <= line && s.end >= line).sort((a, b) => a.start - b.start);
}

function updateSticky(f) {
  if (!f || !f.stickyEl || f.binary) return;
  const top = Math.floor(f.el.scrollTop / LH);
  let syms = [];
  for (let k = 0; k < 4; k++) {
    const probe = top + syms.length;
    syms = enclosing(f, probe).filter(s => s.start < probe).slice(-3);
    if (syms.length <= k) break;
  }
  const key = syms.map(s => s.start).join(',');
  if (key === f.stickyKey) return;
  f.stickyKey = key;
  f.stickyEl.innerHTML = syms.map(s => rowHTML(f, s.start)).join('');
  f.stickyEl.style.display = syms.length ? '' : 'none';
}

function updateCrumbs() {
  const el = $('#crumbs');
  const f = S.files.get(S.active);
  if (!f) { el.innerHTML = ''; return; }
  const syms = enclosing(f, f.caret.line);
  if (!syms.length) { el.innerHTML = `<span class="c" style="color:var(--text-dimmer)">${esc(basename(f.path))}</span>`; return; }
  el.innerHTML = syms.map(s => {
    const detail = s.detail ? s.detail.replace(/^func/, '') : '';
    const label = (s.kind === 6 || s.kind === 12) && detail.startsWith('(') ? s.name + detail : s.name;
    return `<span class="c" data-l="${s.line}" data-ch="${s.char}">${esc(label)}</span>`;
  }).join('<span class="sep">›</span>');
}

// ---- editor events

let ctrlDown = false, linkEl = null, hoverTimer = null, hoverEl = null;

function setLink(el) {
  if (linkEl === el) return;
  if (linkEl) linkEl.classList.remove('link');
  linkEl = el;
  if (linkEl) linkEl.classList.add('link');
}

function spanPos(f, span) {
  const row = span.closest('.row');
  if (!row || !f.rowsEl.contains(row)) return null;
  const first = [...textNodes(span)][0];
  if (!first) return null;
  return { line: +row.dataset.l, col: colFromDom(row, first, 0) };
}

function attachEditorEvents(f) {
  const el = f.el;
  el.addEventListener('scroll', () => { requestAnimationFrame(() => updateSticky(f)); hidePopup(); });
  el.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    hidePopup();
    const sticky = e.target.closest('.sticky-rows .row');
    if (sticky) { e.preventDefault(); const l = +sticky.dataset.l; openFile(f.path, { line: l, col: 0, center: true }); return; }
    const gutter = e.target.closest('.rows .row .no');
    if (gutter) {
      // GitHub-style line selection: click a line number, shift+click to extend, ctrl+click to add.
      e.preventDefault();
      el.focus({ preventScroll: true });
      const l = +gutter.parentNode.dataset.l;
      let ranges;
      if (e.shiftKey && f.markAnchor != null) ranges = [[Math.min(f.markAnchor, l), Math.max(f.markAnchor, l)]];
      else if ((e.ctrlKey || e.metaKey) && f.marks) ranges = mergeRanges([...f.marks, [l, l]]);
      else { f.markAnchor = l; ranges = f.marks && f.marks.length === 1 && f.marks[0][0] === l && f.marks[0][1] === l ? null : [[l, l]]; }
      setCaret(f, l, 0, { scroll: false });
      setMarks(f, ranges);
      recordHistory(true);
      return;
    }
    const pos = posFromPoint(f, e.clientX, e.clientY);
    if (!pos) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      el.focus({ preventScroll: true });
      const tk = e.target.closest('.tk');
      const sp = tk && spanPos(f, tk);
      const at = sp || pos;
      setCaret(f, pos.line, pos.col, { scroll: false });
      goToDeclaration(f, at.line, at.col);
      return;
    }
    if (e.shiftKey) return;
    setCaret(f, pos.line, pos.col, { scroll: false });
  });
  el.addEventListener('mousemove', e => {
    const tk = e.target.closest('.rows .tk');
    if (e.ctrlKey || e.metaKey) { setLink(tk); }
    else setLink(null);
    if (tk !== hoverEl) {
      hoverEl = tk;
      clearTimeout(hoverTimer);
      if (tk && f.lang === 'go') hoverTimer = setTimeout(() => showHover(f, tk), e.ctrlKey ? 250 : 650);
      else if (!e.target.closest('#popup')) schedulePopupHide();
    }
  });
  el.addEventListener('mouseleave', () => { setLink(null); clearTimeout(hoverTimer); hoverEl = null; schedulePopupHide(); });
  el.addEventListener('keydown', e => editorKey(f, e));
  el.addEventListener('focus', () => placeCaret(f, false));
}

function editorKey(f, e) {
  if (e.altKey || f.binary) return;
  const { line, col } = f.caret;
  const page = Math.max(1, Math.floor(f.el.clientHeight / LH) - 2);
  const mod = e.ctrlKey || e.metaKey;
  let handled = true;
  switch (e.key) {
    case 'ArrowLeft':
      if (mod) { const t = f.lines[line]; let c = col; while (c > 0 && !isIdPart(t[c - 1])) c--; while (c > 0 && isIdPart(t[c - 1])) c--; setCaret(f, line, c); }
      else if (col > 0) setCaret(f, line, col - 1); else if (line > 0) setCaret(f, line - 1, f.lines[line - 1].length);
      break;
    case 'ArrowRight':
      if (mod) { const t = f.lines[line]; let c = col; while (c < t.length && !isIdPart(t[c])) c++; while (c < t.length && isIdPart(t[c])) c++; setCaret(f, line, c); }
      else if (col < f.lines[line].length) setCaret(f, line, col + 1); else if (line < f.lines.length - 1) setCaret(f, line + 1, 0);
      break;
    case 'ArrowUp': if (mod) { f.el.scrollTop -= LH; break; } setCaret(f, line - 1, f.wantCol, { keepWant: true }); break;
    case 'ArrowDown': if (mod) { f.el.scrollTop += LH; break; } setCaret(f, line + 1, f.wantCol, { keepWant: true }); break;
    case 'PageUp': f.el.scrollTop -= page * LH; setCaret(f, line - page, f.wantCol, { keepWant: true }); break;
    case 'PageDown': f.el.scrollTop += page * LH; setCaret(f, line + page, f.wantCol, { keepWant: true }); break;
    case 'Home':
      if (mod) setCaret(f, 0, 0);
      else { const ind = f.lines[line].match(/^\s*/)[0].length; setCaret(f, line, col === ind ? 0 : ind); }
      break;
    case 'End': if (mod) setCaret(f, f.lines.length - 1, f.lines[f.lines.length - 1].length); else setCaret(f, line, f.lines[line].length); break;
    default: handled = false;
  }
  if (handled) e.preventDefault();
}

function focusEditor() {
  const f = S.files.get(S.active);
  if (f) f.el.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- navigation history

let histTimer;
function currentState() {
  const f = S.files.get(S.active);
  if (!f) return null;
  return { pid: S.pid, path: f.path, line: f.caret.line, col: f.caret.col, top: f.el.scrollTop, marks: f.marks || null, tour: S.tour ? S.tour.raw : null, step: S.tour ? S.tour.step : null };
}
function stateHash(st) {
  const l = st.marks && st.marks.length ? formatRanges(st.marks) : String(st.line + 1);
  const q = { p: st.pid, f: st.path, l };
  if (st.tour) { q.tour = st.tour; q.step = st.step + 1; }
  return '#' + new URLSearchParams(q).toString();
}

// ---- deep links: #p=<project>&f=<path>&l=<lines>, lines like "42", "10-20" or "10-20,31,40-45"

function parseRanges(spec) {
  const out = [];
  for (const part of String(spec || '').split(',')) {
    const m = /^\s*L?(\d+)(?:\s*-\s*L?(\d+))?\s*$/i.exec(part);
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    out.push([Math.min(a, b) - 1, Math.max(a, b) - 1]);
  }
  return out; // author order: the first range is where a link or walkthrough step lands
}
const formatRanges = rs => rs.map(([a, b]) => a === b ? `${a + 1}` : `${a + 1}-${b + 1}`).join(',');

// resolveLink accepts an absolute path, or a path relative to the project (p may then be omitted
// when the path is absolute: the project containing it is picked).
function resolveLink(hp) {
  let pid = hp.get('p'), path = hp.get('f');
  const tour = hp.get('tour'), step = Math.max(0, (+hp.get('step') || 1) - 1);
  if (!path) return tour ? { tour, step } : (pid && S.projects.some(p => p.id === pid) ? { pid } : null);
  if (!pid || !S.projects.some(p => p.id === pid)) {
    const owner = S.projects.filter(p => path.startsWith(p.path + '/')).sort((a, b) => b.path.length - a.path.length)[0];
    pid = owner ? owner.id : (S.pid || (S.projects[0] && S.projects[0].id));
  }
  const pr = S.projects.find(p => p.id === pid);
  if (pr && !path.startsWith('/')) path = pr.path + '/' + path.replace(/^\.?\//, '');
  return { pid, path, ranges: parseRanges(hp.get('l')), tour, step };
}

async function openDeepLink(link) {
  if (!link) return;
  if (!link.path && !link.tour) { if (link.pid !== S.pid) await switchProject(link.pid); return; }
  if (link.tour) {
    const ok = await loadTour(link.tour, link.step, !link.path);
    if (!link.path || !ok) return;
  }
  if (link.pid !== S.pid) await switchProject(link.pid, { restore: false });
  const first = link.ranges[0];
  const f = await openFile(link.path, { line: first ? first[0] : 0, col: 0, push: false, center: true }).catch(() => null);
  if (!f) return;
  setMarks(f, link.ranges.length && (link.ranges.length > 1 || link.ranges[0][0] !== link.ranges[0][1]) ? link.ranges : (first ? [first] : null));
  if (first) revealRange(f, first[0], first[1]);
  recordHistory(true);
}

// revealRange scrolls so the whole range is visible (centered), or its start near the top if it is too tall.
function revealRange(f, a, b) {
  const sc = f.el, view = sc.clientHeight, sticky = 3 * LH;
  const top = a * LH, h = (b - a + 1) * LH;
  sc.scrollTop = h + sticky < view ? top - (view - h) / 2 : top - sticky - LH;
}

function setMarks(f, ranges) {
  f.marks = ranges && ranges.length ? ranges : null;
  renderMarks(f);
  updateLinkButton();
}

function renderMarks(f) {
  if (!f.rowEls) return;
  renderTourBadges(f);
  f.rowsEl.querySelectorAll('.row.mark').forEach(r => r.classList.remove('mark', 'mark-first', 'mark-last'));
  for (const [a, b] of f.marks || []) {
    for (let i = a; i <= b && i < f.rowEls.length; i++) f.rowEls[i].classList.add('mark');
    if (f.rowEls[a]) f.rowEls[a].classList.add('mark-first');
    if (f.rowEls[Math.min(b, f.rowEls.length - 1)]) f.rowEls[Math.min(b, f.rowEls.length - 1)].classList.add('mark-last');
  }
}

// linkRanges: the marked lines, else the lines of a text selection inside the editor, else the caret line.
function linkRanges(f) {
  const sel = getSelection();
  if (sel && !sel.isCollapsed && f.rowsEl.contains(sel.anchorNode) && f.rowsEl.contains(sel.focusNode)) {
    const row = n => (n.nodeType === 3 ? n.parentNode : n).closest('.row');
    const a = +row(sel.anchorNode).dataset.l, b = +row(sel.focusNode).dataset.l;
    return [[Math.min(a, b), Math.max(a, b)]];
  }
  return f.marks || [[f.caret.line, f.caret.line]];
}

async function copyLink() {
  const f = S.files.get(S.active);
  if (!f) return;
  const ranges = linkRanges(f);
  if (!f.marks || formatRanges(ranges) !== formatRanges(f.marks)) setMarks(f, ranges);
  recordHistory(true);
  const url = location.origin + location.pathname + stateHash(currentState());
  let ok = false;
  try { await navigator.clipboard.writeText(url); ok = true; } catch {
    // Clipboard API needs a secure context; plain http on an IP falls back to execCommand.
    const ta = document.createElement('textarea');
    ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  toast(ok ? `Copied link to ${basename(f.path)}:${formatRanges(ranges)}` : url, ok ? 2600 : 8000);
}

function updateLinkButton() {
  const f = S.files.get(S.active);
  const b = $('#sbLink');
  if (!b) return;
  b.classList.toggle('hidden', !f);
  b.title = f && f.marks ? `Copy link to lines ${formatRanges(f.marks)} (Alt+Shift+C)` : 'Copy link to this line or selection (Alt+Shift+C)';
}

function recordHistory(replace) {
  const st = currentState();
  if (!st) return;
  if (replace) history.replaceState(st, '', stateHash(st));
  else history.pushState(st, '', stateHash(st));
}
function scheduleHistoryUpdate() { clearTimeout(histTimer); histTimer = setTimeout(() => recordHistory(true), 400); }

// A link pasted into the address bar of an open tab only changes the hash.
window.addEventListener('hashchange', () => {
  if (history.state && history.state.path) return; // our own history entry, handled by popstate
  openDeepLink(resolveLink(new URLSearchParams(location.hash.slice(1))));
});

window.addEventListener('popstate', async e => {
  const st = e.state;
  if (!st || !st.path) return;
  if (st.pid !== S.pid) await switchProject(st.pid, { restore: false });
  clearTimeout(histTimer);
  const f = await openFile(st.path, { line: st.line, col: st.col, push: false, center: true }).catch(() => null);
  if (f) setMarks(f, st.marks || null);
  if (S.tour && st.tour === S.tour.raw && st.step != null) { S.tour.step = st.step; renderTour(); }
  if (f && st.top != null) f.el.scrollTop = st.top;
});

// ---------------------------------------------------------------- go to declaration / usages

async function goToDeclaration(f, line, col) {
  const w = wordAt(f, line, col);
  if (!w) return;
  if (f.lang !== 'go') { toast('Navigation is available in Go files'); return; }
  let locs;
  try { locs = await api('definition', { project: S.pid, path: f.path, line, char: w.start }); }
  catch (e) { toast('gopls: ' + e.message); return; }
  if (!locs.length) { toast(`Cannot find declaration to go to`); return; }
  const d = locs[0];
  if (d.path === f.path && d.line === line && d.char <= w.start && w.start <= d.endChar) {
    showUsages(f, line, w.start);  // Ctrl+Click on a declaration shows its usages, like IntelliJ.
    return;
  }
  if (locs.length > 1) { showLocations(`Declarations of <code>${esc(w.word)}</code>`, locs); return; }
  openFile(d.path, { line: d.line, col: d.char, center: true, target: d });
}

async function goToImplementation(f) {
  const w = wordAt(f, f.caret.line, f.caret.col);
  if (!w || f.lang !== 'go') return;
  let locs;
  try { locs = await api('implementation', { project: S.pid, path: f.path, line: w.line, char: w.start }); }
  catch (e) { toast('gopls: ' + e.message); return; }
  if (!locs.length) { toast('No implementations found'); return; }
  if (locs.length === 1) { const d = locs[0]; openFile(d.path, { line: d.line, col: d.char, center: true, target: d }); return; }
  showLocations(`Implementations of <code>${esc(w.word)}</code>`, locs);
}

let usagesSeq = 0;
async function showUsages(f, line, col) {
  const w = wordAt(f, line, col);
  if (!w) { toast('Place the caret on a symbol to find its usages'); return; }
  if (f.lang !== 'go') { toast('Usages are available in Go files'); return; }
  const seq = ++usagesSeq;
  const title = `Usages of <code>${esc(w.word)}</code>`;
  const pending = setTimeout(() => { if (seq === usagesSeq) openBottom(title, '<div class="bmsg"><span class="spin"></span>Searching…</div>', ''); }, 250);
  let locs;
  try { locs = await api('references', { project: S.pid, path: f.path, line: w.line, char: w.start }); }
  catch (e) { clearTimeout(pending); if (seq === usagesSeq) { dismissUsages(); toast('gopls: ' + e.message); } return; }
  clearTimeout(pending);
  if (seq !== usagesSeq) return;
  const others = locs.filter(l => !(l.path === f.path && l.line === w.line && l.char === w.start));
  if (!locs.length || !others.length) { dismissUsages(); toast(locs.length ? `No other usages of ${w.word}` : `No usages of ${w.word} found`); return; }
  if (locs.length === 1) { dismissUsages(); const d = locs[0]; openFile(d.path, { line: d.line, col: d.char, center: true, target: d }); return; }
  showLocations(title, locs);
}

let bItems = [], bSel = -1;
function showLocations(title, locs) {
  const groups = new Map();
  for (const l of locs) { if (!groups.has(l.path)) groups.set(l.path, []); groups.get(l.path).push(l); }
  const rows = [];
  bItems = [];
  const limit = 3000;
  for (const [path, ls] of groups) {
    const rel = ls[0].rel || path;
    rows.push(`<div class="urow file">${fileIcon(basename(path))}<span>${esc(basename(path))}</span><span class="fp">${esc(dirname(rel))}</span><span class="cnt">${ls.length} usage${ls.length > 1 ? 's' : ''}</span></div>`);
    for (const l of ls) {
      if (bItems.length >= limit) break;
      const t = l.text || '';
      const lead = t.length - t.trimStart().length;
      const s = Math.max(0, l.char - lead), e = Math.max(s, (l.endChar || l.char) - lead);
      const tt = t.slice(lead);
      rows.push(`<div class="urow item" data-i="${bItems.length}"><span class="ln">${l.line + 1}</span><span>${esc(tt.slice(0, s))}<mark>${esc(tt.slice(s, e))}</mark>${esc(tt.slice(e, 300))}</span></div>`);
      bItems.push(l);
    }
  }
  const count = `${locs.length} result${locs.length > 1 ? 's' : ''} in ${groups.size} file${groups.size > 1 ? 's' : ''}`;
  openBottom(title, rows.join(''), count);
  bSel = -1;
  selectUsage(0, false);
  $('#bList').focus();
}

// The bottom tool window has two tabs: Walkthrough (when a tour is loaded) and Usages.
const usagesHead = { title: '', count: '' };

function openBottom(title, html, count) {
  usagesHead.title = title; usagesHead.count = count;
  $('#bList').innerHTML = html;
  $('#bTabUsages').classList.remove('hidden');
  showBottom('usages');
}

function showBottom(tab) {
  S.bottomTab = tab;
  $('#bottom').classList.remove('hidden');
  $('#splitBottom').classList.remove('hidden');
  $('#bottom').style.height = store.get('bottomH', 280) + 'px';
  $('#bTabTour').classList.toggle('active', tab === 'tour');
  $('#bTabUsages').classList.toggle('active', tab === 'usages');
  $('#bList').classList.toggle('hidden', tab !== 'usages');
  $('#bTour').classList.toggle('hidden', tab !== 'tour');
  $('#tCtl').classList.toggle('hidden', tab !== 'tour' || !S.tour);
  if (tab === 'tour') {
    $('#tSteps').classList.toggle('hidden', !S.tour);
    $('#tNote').classList.toggle('hidden', !S.tour);
    $('#tList').classList.toggle('hidden', !!S.tour);
    if (!S.tour) renderTourList();
  }
  if (tab === 'usages') { $('#bTitle').innerHTML = usagesHead.title; $('#bCount').textContent = usagesHead.count; }
  else renderTourHead();
  updateTourStatus();
}

// dismissUsages backs out of a usages search that showed nothing worth listing, without hiding
// a walkthrough that shares the bottom panel.
function dismissUsages() {
  if (S.bottomTab !== 'usages') return;
  if (S.tour) showBottom('tour'); else closeBottom();
}

function closeBottom() {
  $('#bottom').classList.add('hidden');
  $('#splitBottom').classList.add('hidden');
  updateTourStatus();
}

function selectUsage(i, open) {
  if (!bItems.length) return;
  bSel = Math.max(0, Math.min(bItems.length - 1, i));
  const list = $('#bList');
  list.querySelectorAll('.urow.sel').forEach(r => r.classList.remove('sel'));
  const row = list.querySelector(`.urow.item[data-i="${bSel}"]`);
  if (row) { row.classList.add('sel'); reveal(row, list); }
  if (open) { const l = bItems[bSel]; openFile(l.path, { line: l.line, col: l.char, center: true, target: l, focus: open === 'focus' }); }
}

function initBottom() {
  const list = $('#bList');
  list.addEventListener('click', e => { const r = e.target.closest('.urow.item'); if (r) selectUsage(+r.dataset.i, true); });
  list.addEventListener('dblclick', e => { const r = e.target.closest('.urow.item'); if (r) { selectUsage(+r.dataset.i, 'focus'); } });
  list.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); selectUsage(bSel + 1, true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selectUsage(bSel - 1, true); }
    else if (e.key === 'Enter') { e.preventDefault(); selectUsage(bSel, 'focus'); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBottom(); focusEditor(); }
  });
  list.addEventListener('focus', () => { list.dataset.focus = '1'; });
  $('#bClose').addEventListener('click', () => { closeBottom(); focusEditor(); });
  $('#bTabTour').addEventListener('click', () => showBottom('tour'));
  $('#bTabUsages').addEventListener('click', () => showBottom('usages'));
  initTour();
}

// ---------------------------------------------------------------- hover popup

let popupHideTimer;
async function showHover(f, span) {
  const pos = spanPos(f, span);
  if (!pos) return;
  let res;
  try { res = await api('hover', { project: S.pid, path: f.path, line: pos.line, char: pos.col }); } catch { return; }
  if (hoverEl !== span || !res.markdown) return;
  const p = $('#popup');
  p.innerHTML = renderMarkdown(res.markdown);
  p.classList.remove('hidden');
  const r = span.getBoundingClientRect();
  const ph = p.offsetHeight, pw = p.offsetWidth;
  let top = r.bottom + 4;
  if (top + ph > innerHeight - 30) top = Math.max(8, r.top - ph - 4);
  p.style.top = top + 'px';
  p.style.left = Math.max(8, Math.min(r.left, innerWidth - pw - 12)) + 'px';
}
function schedulePopupHide() { clearTimeout(popupHideTimer); popupHideTimer = setTimeout(hidePopup, 300); }
function hidePopup() { clearTimeout(popupHideTimer); $('#popup').classList.add('hidden'); }

function renderMarkdown(md) {
  const parts = md.split(/```(\w*)\n([\s\S]*?)```/);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) {
      const text = parts[i].replace(/^\s*---\s*$/gm, '').trim();
      if (!text) continue;
      out += '<div class="doc">' + mdBlocks(text) + '</div>';
    } else if (i % 3 === 2) {
      const lines = parts[i].replace(/\n$/, '').split('\n');
      const lang = parts[i - 1] || 'go';
      const fake = { lines, lex: lang === 'go' ? lexGo(lines) : lines.map(() => []), sem: null, hints: null };
      out += '<pre>' + lines.map((_, j) => lineHTML(fake, j)).join('\n') + '</pre>';
    }
  }
  return out;
}

// mdBlocks renders paragraphs, "-"/"*" and "1." lists and "#" headings.
function mdBlocks(text) {
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) out.push('<p>' + inlineMd(para.join('\n')) + '</p>'); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>` + list.items.map(i => '<li>' + inlineMd(i) + '</li>').join('') + `</${list.tag}>`); list = null; };
  for (const line of text.split('\n')) {
    const ul = /^\s*[-*]\s+(.*)$/.exec(line), ol = /^\s*\d+[.)]\s+(.*)$/.exec(line), h = /^#{1,6}\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push((ul || ol)[1]);
    } else if (h) { flushPara(); flushList(); out.push('<p><b>' + inlineMd(h[1]) + '</b></p>'); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else if (list && /^\s{2,}\S/.test(line)) list.items[list.items.length - 1] += ' ' + line.trim();
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return out.join('');
}

function inlineMd(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    // Code links: [text](L42), [text](L42-L50) or [text](path/to/file.go:42) open in the editor.
    .replace(/\[([^\]]+)\]\(((?:[\w./-]+:)?L?\d+(?:-L?\d+)?)\)/g, (m, label, target) => `<a class="goto" data-goto="${target}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, ' ');
}

// ---------------------------------------------------------------- walkthroughs
// A walkthrough ("tour") is JSON carried in the URL hash as tour=<value>, where value is either the
// JSON itself or base64url(deflate-raw(JSON)) as printed by `codebrowse tour`:
//   { "title": "...", "project": "<id|name|path>", "steps": [
//       { "title": "...", "file": "rel/or/abs/path.go", "lines": "637-700,712", "note": "markdown" } ] }

async function decodeTour(raw) {
  const v = raw.trim();
  if (v.startsWith('{')) return JSON.parse(v);
  const b64 = v.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((v.length + 3) % 4);
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return JSON.parse(await new Response(stream).text());
}

function tourProject(t) {
  if (t.project) {
    const want = String(t.project);
    const p = S.projects.find(p => p.id === want || p.name === want || p.path === want.replace(/\/+$/, ''));
    if (p) return p;
  }
  for (const st of t.steps) {
    if (st.file && st.file.startsWith('/')) {
      const p = S.projects.filter(p => st.file.startsWith(p.path + '/')).sort((a, b) => b.path.length - a.path.length)[0];
      if (p) return p;
    }
  }
  return proj();
}

// loadTour shows the walkthrough. With navigate it also opens the given step; otherwise the editor
// stays where the rest of the link points (the user wandered off and reloaded).
async function loadTour(raw, step, navigate) {
  if (S.tour && S.tour.raw === raw) { if (navigate) goStep(step, { push: false }); return true; }
  let t;
  try { t = await decodeTour(raw); } catch (e) { toast('Invalid walkthrough link: ' + e.message, 6000); return false; }
  if (!t || !Array.isArray(t.steps) || !t.steps.length) { toast('Walkthrough has no steps'); return false; }
  const p = tourProject(t);
  if (p && p.id !== S.pid) await switchProject(p.id, { restore: false });
  const root = p ? p.path : '';
  S.tour = {
    raw, title: t.title || 'Walkthrough', step: Math.min(step, t.steps.length - 1), visited: new Set(),
    steps: t.steps.map(st => ({
      title: st.title || '', note: st.note || '', lines: String(st.lines || st.line || ''),
      ranges: parseRanges(st.lines || st.line), rel: st.file || '',
      path: !st.file ? null : st.file.startsWith('/') ? st.file : root + '/' + st.file.replace(/^\.?\//, ''),
    })),
  };
  renderTour();
  showBottom('tour');
  if (navigate) await goStep(S.tour.step, { push: false });
  return true;
}

async function goStep(i, { push = true } = {}) {
  const t = S.tour;
  if (!t) return;
  i = Math.max(0, Math.min(t.steps.length - 1, i));
  if (push) recordHistory(true); // snapshot the current position and step before moving on
  t.step = i;
  t.visited.add(i);
  const st = t.steps[i];
  renderTour();
  if ($('#bottom').classList.contains('hidden') || S.bottomTab !== 'tour') showBottom('tour');
  if (!st.path) { recordHistory(true); return; }
  const first = st.ranges[0];
  const f = await openFile(st.path, { line: first ? first[0] : 0, col: 0, center: true, push: false, focus: false }).catch(() => null);
  if (!f || S.tour !== t || t.step !== i) return;
  setMarks(f, st.ranges.length ? st.ranges : null);
  if (first) revealRange(f, first[0], Math.max(...st.ranges.filter(r => r[0] - first[0] < 60).map(r => r[1])));
  for (const g of S.files.values()) if (g && g !== f) renderTourBadges(g);
  recordHistory(!push);
}

// endTour closes the current walkthrough and shows the list of saved ones.
function endTour() {
  S.tour = null;
  for (const f of S.files.values()) if (f) { renderTourBadges(f); if (f.marks) setMarks(f, null); }
  showBottom('tour');
  recordHistory(true);
}

const timeAgo = d => {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return Math.floor(s / 86400) + ' d ago';
};
let tourItems = [], tourSel = 0;

async function renderTourList() {
  const el = $('#tList');
  $('#bTitle').textContent = '';
  $('#bCount').textContent = '';
  let tours = [];
  try { tours = await api('tours'); } catch { /* ignore */ }
  if (S.tour) return;
  const here = tours.filter(t => t.project === S.pid), other = tours.filter(t => t.project !== S.pid);
  tourItems = [...here, ...other];
  tourSel = Math.min(tourSel, Math.max(0, tourItems.length - 1));
  const icon = '<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="3.5" cy="12.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="12.5" cy="3.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.2 12.5h4.3a2.5 2.5 0 000-5h-3a2.5 2.5 0 010-5h4.3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
  const row = (t, i) => {
    const pn = (S.projects.find(p => p.id === t.project) || {}).name || t.project;
    return `<div class="titem ${i === tourSel ? 'sel' : ''}" data-i="${i}"><span class="tic">${icon}</span><div class="tmain"><div class="ttitle">${esc(t.title)}</div><div class="tmeta">${t.steps} step${t.steps === 1 ? '' : 's'} · ${esc(pn)} · ${timeAgo(t.created)}</div></div><button class="icon-btn tdel" title="Delete walkthrough"><svg viewBox="0 0 16 16" width="13" height="13"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button></div>`;
  };
  let html = '';
  if (here.length) html += `<div class="tgroup">This project</div>` + here.map((t, i) => row(t, i)).join('');
  if (other.length) html += `<div class="tgroup">Other projects</div>` + other.map((t, i) => row(t, here.length + i)).join('');
  html += `<div class="tempty">${tours.length ? '' : '<b>No walkthroughs yet.</b><br>'}A walkthrough is a guided tour through the code: each step highlights lines in a file and explains them. Ask your coding agent to <b>“make a codebrowse walkthrough of …”</b>; it writes the steps as JSON and runs <code>codebrowse tour &lt; tour.json</code>, which validates them and adds the tour here. Opening a <code>#tour=</code> link works too.</div>`;
  el.innerHTML = html;
}

async function openSavedTour(i) {
  const t = tourItems[i];
  if (!t) return;
  await loadTour(t.encoded, 0, true);
}

const stepLoc = st => st.rel ? `${basename(st.rel)}${st.lines ? ':' + st.lines : ''}` : '';

function renderTour() {
  const t = S.tour;
  if (!t) return;
  $('#tSteps').classList.remove('hidden');
  $('#tNote').classList.remove('hidden');
  $('#tList').classList.add('hidden');
  if (S.bottomTab === 'tour') $('#tCtl').classList.remove('hidden');
  $('#tSteps').innerHTML = t.steps.map((st, i) => `<div class="tstep ${i === t.step ? 'active' : ''} ${t.visited.has(i) ? 'visited' : ''}" data-i="${i}">
    <span class="tnum">${i + 1}</span><div class="tbody"><div class="ttl">${esc(st.title || stepLoc(st) || 'Step ' + (i + 1))}</div><div class="tloc" title="${esc(st.rel)}">${esc(st.rel ? dirname(st.rel) + (dirname(st.rel) ? '/' : '') + stepLoc(st) : '')}</div></div></div>`).join('');
  const st = t.steps[t.step];
  $('#tNote').innerHTML = `<h3>${esc(st.title || 'Step ' + (t.step + 1))}${st.rel ? `<span class="tloc">${esc(st.rel)}${st.lines ? ':' + esc(st.lines) : ''}</span>` : ''}</h3>` +
    (st.note ? renderMarkdown(st.note) : '<div class="empty-note">No notes for this step.</div>');
  $('#tNote').scrollTop = 0;
  reveal($('#tSteps .tstep.active'), $('#tSteps'));
  renderTourHead();
  updateTourStatus();
}

function renderTourHead() {
  const t = S.tour;
  if (!t || S.bottomTab !== 'tour') return;
  $('#bTitle').textContent = t.title;
  $('#bCount').textContent = '';
  $('#tPos').textContent = `${t.step + 1} / ${t.steps.length}`;
  $('#tPrev').disabled = t.step === 0;
  $('#tNext').disabled = t.step === t.steps.length - 1;
}

function updateTourStatus() {
  const b = $('#sbTour');
  b.classList.toggle('active', !!S.tour);
  $('#sbTourText').textContent = S.tour ? `${S.tour.title} · ${S.tour.step + 1}/${S.tour.steps.length}` : 'Walkthroughs';
}

// renderTourBadges puts step numbers into the gutter of every step that starts in this file.
function renderTourBadges(f) {
  if (!f.rowEls) return;
  f.rowsEl.querySelectorAll('.row[data-step]').forEach(r => { r.removeAttribute('data-step'); r.firstChild.removeAttribute('data-step'); r.classList.remove('tour-other'); });
  if (!S.tour) return;
  S.tour.steps.forEach((st, i) => {
    if (st.path !== f.path || !st.ranges.length) return;
    const row = f.rowEls[st.ranges[0][0]];
    if (!row) return;
    row.dataset.step = row.dataset.step ? row.dataset.step + ',' + (i + 1) : String(i + 1);
    row.firstChild.dataset.step = row.dataset.step; // the gutter badge reads it via attr()
    if (i !== S.tour.step) row.classList.add('tour-other'); else row.classList.remove('tour-other');
  });
}

// gotoTarget resolves a note link: "L42", "L42-L50" (in the step's file) or "path:42".
function gotoTarget(target) {
  const t = S.tour;
  const st = t && t.steps[t.step];
  const m = /^(?:(.+):)?L?(\d+)(?:-L?(\d+))?$/.exec(target);
  if (!m) return;
  let path = st && st.path;
  if (m[1]) {
    const root = (tourProject({ steps: [] }) || {}).path || '';
    path = m[1].startsWith('/') ? m[1] : root + '/' + m[1];
    if (st && st.path && !m[1].includes('/')) path = dirname(st.path) + '/' + m[1];
  }
  if (!path) return;
  const a = +m[2] - 1, b = m[3] ? +m[3] - 1 : a;
  openFile(path, { line: a, col: 0, center: true }).then(f => { setMarks(f, [[a, b]]); revealRange(f, a, b); recordHistory(true); }).catch(() => {});
}

function initTour() {
  $('#tSteps').addEventListener('click', e => { const r = e.target.closest('.tstep'); if (r) goStep(+r.dataset.i); });
  $('#tSteps').addEventListener('keydown', e => {
    if (!S.tour) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); goStep(S.tour.step + 1); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); goStep(S.tour.step - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); focusEditor(); }
  });
  $('#tPrev').addEventListener('click', () => S.tour && goStep(S.tour.step - 1));
  $('#tNext').addEventListener('click', () => S.tour && goStep(S.tour.step + 1));
  $('#tEnd').addEventListener('click', endTour);
  updateTourStatus();
  $('#sbTour').addEventListener('click', () => {
    if (!$('#bottom').classList.contains('hidden') && S.bottomTab === 'tour') closeBottom(); else showBottom('tour');
  });
  const list = $('#tList');
  list.addEventListener('click', async e => {
    const it = e.target.closest('.titem');
    if (!it) return;
    const i = +it.dataset.i;
    if (e.target.closest('.tdel')) {
      const t = tourItems[i];
      if (!confirm(`Delete walkthrough "${t.title}"?`)) return;
      await api('tours', { id: t.id }, { method: 'DELETE' }).catch(err => toast(err.message));
      renderTourList();
      return;
    }
    openSavedTour(i);
  });
  list.addEventListener('keydown', e => {
    const move = d => { tourSel = Math.max(0, Math.min(tourItems.length - 1, tourSel + d)); list.querySelectorAll('.titem').forEach(r => r.classList.toggle('sel', +r.dataset.i === tourSel)); reveal(list.querySelector('.titem.sel'), list); };
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); openSavedTour(tourSel); }
  });
  $('#tNote').addEventListener('click', e => { const a = e.target.closest('a.goto'); if (a) { e.preventDefault(); gotoTarget(a.dataset.goto); } });
}

// ---------------------------------------------------------------- finder (search everywhere)

const SYM_KIND = { 5: ['c', '#E5C07B'], 6: ['m', '#F07178'], 7: ['f', '#C77DBB'], 8: ['f', '#C77DBB'], 10: ['e', '#E5C07B'], 11: ['I', '#5FB865'], 12: ['f', '#56A8F5'], 13: ['v', '#C77DBB'], 14: ['c', '#C77DBB'], 23: ['s', '#E5C07B'], 26: ['T', '#16BAAC'] };

function openFinder(mode = 'files') {
  closeFinder();
  const back = $('#modalBack');
  const m = document.createElement('div');
  m.className = 'modal finder';
  m.innerHTML = `<div class="modal-tabs"><span class="mt" data-m="files">Files</span><span class="mt" data-m="symbols">Symbols</span><span class="mt" data-m="structure">Structure</span><span class="hint-r">Tab to switch · name:line · :line</span></div><input class="q" spellcheck="false" autocomplete="off"><div class="fres"></div>`;
  document.body.appendChild(m);
  back.classList.remove('hidden');
  back.onclick = closeFinder;
  const q = $('.q', m), res = $('.fres', m);
  let items = [], sel = 0, seq = 0, timer;
  const setMode = md => {
    mode = md;
    m.querySelectorAll('.mt').forEach(t => t.classList.toggle('active', t.dataset.m === mode));
    q.placeholder = { files: 'Type file name…', symbols: 'Type symbol name (functions, types, methods)…', structure: 'Filter symbols in this file…' }[mode];
    run();
  };
  m.querySelectorAll('.mt').forEach(t => t.onclick = () => { setMode(t.dataset.m); q.focus(); });
  const render = (msg) => {
    if (msg) { res.innerHTML = `<div class="fmsg">${msg}</div>`; return; }
    res.innerHTML = items.map((it, i) => `<div class="fr ${i === sel ? 'sel' : ''}" data-i="${i}">${it.icon}<span class="fn-name">${it.name}</span><span class="fn-path">${esc(it.sub || '')}</span></div>`).join('') || '<div class="fmsg">Nothing found</div>';
    reveal(res.querySelector('.fr.sel'), res);
  };
  const hiName = (name, query) => {
    const ql = query.toLowerCase(); let qi = 0, out = '';
    for (const ch of name) { if (qi < ql.length && ch.toLowerCase() === ql[qi]) { out += '<b>' + esc(ch) + '</b>'; qi++; } else out += esc(ch); }
    return out;
  };
  async function run() {
    const my = ++seq;
    let raw = q.value.trim();
    const lm = /^(.*?):(\d+)$/.exec(raw);
    const lineNo = lm ? +lm[2] - 1 : null;
    if (lm) raw = lm[1];
    const p = proj();
    if (!p) { render('No project'); return; }
    if (mode === 'files') {
      if (lm && !raw) {
        items = S.active ? [{ icon: fileIcon(basename(S.active)), name: `Go to line ${lineNo + 1}`, sub: basename(S.active), path: S.active, line: lineNo }] : [];
        sel = 0; render(); return;
      }
      if (!raw) {
        items = S.recent.filter(r => r !== S.active).slice(0, 30).concat(S.active ? [S.active] : []).map(path => ({ icon: fileIcon(basename(path)), name: esc(basename(path)), sub: relInProject(path) != null ? dirname(relInProject(path)) : path, path }));
        sel = 0; render(items.length ? null : 'Type to search files'); return;
      }
      const r = await api('find', { project: p.id, q: raw }).catch(() => []);
      if (my !== seq) return;
      items = r.map(x => ({ icon: fileIcon(basename(x.rel)), name: hiName(basename(x.rel), raw.includes('/') ? '' : raw), sub: dirname(x.rel), path: p.path + '/' + x.rel, line: lineNo }));
      sel = 0; render();
    } else if (mode === 'symbols') {
      if (!raw) { items = []; render('Type to search symbols across the workspace (needs gopls)'); return; }
      clearTimeout(timer);
      timer = setTimeout(async () => {
        render('<span class="spin"></span>Searching…');
        const r = await api('wsymbols', { project: p.id, q: raw }).catch(e => { if (my === seq) render(esc(e.message)); return null; });
        if (!r || my !== seq) return;
        const local = r.filter(x => x.path.startsWith(p.path + '/')), ext = r.filter(x => !x.path.startsWith(p.path + '/'));
        items = local.concat(ext).map(x => { const k = SYM_KIND[x.kind] || ['•', '#868A91']; return { icon: `<span class="sk" style="background:${k[1]}">${k[0]}</span>`, name: hiName(x.name, raw), sub: (x.container ? x.container + ' · ' : '') + x.rel, path: x.path, line: x.line, col: x.char }; });
        sel = 0; render();
      }, 150);
    } else {
      const f = S.files.get(S.active);
      if (!f) { items = []; render('No file open'); return; }
      const ql = raw.toLowerCase();
      items = (f.symbols || []).filter(s => !ql || fuzzy(s.name.toLowerCase(), ql)).map(s => { const k = SYM_KIND[s.kind] || ['•', '#868A91']; return { icon: `<span class="sk" style="background:${k[1]};margin-left:${s.depth * 14}px">${k[0]}</span>`, name: hiName(s.name, raw), sub: (s.detail || '').slice(0, 120), path: f.path, line: s.line, col: s.char }; });
      sel = 0; render(f.symbols && f.symbols.length ? null : 'No symbols (gopls may still be loading)');
    }
  }
  const choose = (it) => {
    if (!it) return;
    closeFinder();
    openFile(it.path, it.line != null ? { line: it.line, col: it.col || 0, center: true } : {}).catch(() => {});
  };
  q.addEventListener('input', run);
  q.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (e.key === 'PageDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 10); render(); }
    else if (e.key === 'PageUp') { e.preventDefault(); sel = Math.max(0, sel - 10); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[sel]); }
    else if (e.key === 'Tab') { e.preventDefault(); const ms = ['files', 'symbols', 'structure']; setMode(ms[(ms.indexOf(mode) + (e.shiftKey ? 2 : 1)) % 3]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFinder(); focusEditor(); }
  });
  res.addEventListener('click', e => { const r = e.target.closest('.fr'); if (r) choose(items[+r.dataset.i]); });
  setMode(mode);
  q.focus();
}

function fuzzy(t, q) { let i = 0; for (const c of t) if (c === q[i]) i++; return i === q.length; }

function closeFinder() {
  document.querySelectorAll('.modal.finder, .modal.helpm').forEach(m => m.remove());
  if (!document.querySelector('.modal')) { $('#modalBack').classList.add('hidden'); $('#modalBack').onclick = null; }
}

function openHelp() {
  closeFinder();
  const m = document.createElement('div');
  m.className = 'modal helpm';
  const rows = [
    ['Ctrl+Click', 'Go to declaration (on a declaration: show usages)'], ['Ctrl+B', 'Go to declaration at caret'], ['Ctrl+G', 'Show usages of symbol at caret (jumps directly if only one)'],
    ['Ctrl+Alt+B', 'Go to implementation(s)'], ['Alt+← / Alt+→', 'Navigate back / forward (also Ctrl+Alt+← / →, mouse back)'], ['Double Shift / Ctrl+P', 'Search files (Tab: symbols, structure)'],
    ['Ctrl+E', 'Recent files'], ['Ctrl+F12', 'File structure'], ['Alt+F1', 'Select opened file in project tree'], ['Click / Shift+Click line number', 'Highlight a line / range (Ctrl+Click adds a range); the URL becomes a deep link'],
    ['Alt+Shift+C', 'Copy deep link to the highlighted lines, selection or caret line'], ['F8 / Shift+F8', 'Next / previous walkthrough step'],
    ['Alt+1', 'Focus project tree'], ['Esc', 'Close popup / usages pane, back to editor'], ['Ctrl+F', 'Find in file (browser find)'],
    ['Hover', 'Quick documentation'], ['Middle-click tab', 'Close tab'],
  ];
  m.innerHTML = `<div class="help"><h2>Keyboard shortcuts</h2>${rows.map(r => `<kbd>${esc(r[0])}</kbd><span>${esc(r[1])}</span>`).join('')}</div>`;
  document.body.appendChild(m);
  $('#modalBack').classList.remove('hidden');
  $('#modalBack').onclick = closeFinder;
}

// ---------------------------------------------------------------- status

let statusTimer;
async function pollStatus() {
  clearTimeout(statusTimer);
  if (!S.pid) return;
  const pid = S.pid;
  let st;
  try { st = await api('status', { project: pid }); } catch { statusTimer = setTimeout(pollStatus, 5000); return; }
  if (pid !== S.pid) return;
  const prev = S.status;
  S.status = st;
  if (prev.branch !== st.branch || prev.dirty !== st.dirty) renderTree();
  if (st.version !== S.treeVersion) { const first = S.treeVersion === -1; S.treeVersion = st.version; if (!first || st.index === 'ready') refreshTree(false); }
  if (prev.gopls && prev.gopls !== 'ready' && st.gopls === 'ready') {
    for (const f of S.files.values()) if (f && f.lang === 'go' && (f.semFailed || !f.sem)) { f.semFailed = false; loadSemantic(f); }
  }
  updateStatusBar();
  const busy = st.index !== 'ready' || (st.gopls !== 'ready' && st.gopls !== 'stopped');
  statusTimer = setTimeout(pollStatus, busy ? 1500 : 8000);
}

function updateStatusBar() {
  const f = S.files.get(S.active);
  $('#sbPos').textContent = f ? `${f.caret.line + 1}:${f.caret.col + 1}` : '';
  updateLinkButton();
  $('#sbIndent').textContent = f ? f.indent : '';
  $('#tbBranchName').textContent = f && f.branch ? f.branch : '';
  $('#tbBranch').style.visibility = f && f.branch ? '' : 'hidden';
  const p = proj();
  const crumbs = $('#sbCrumbs');
  if (f && p) {
    const rel = relInProject(f.path);
    const parts = rel != null ? [p.name, ...rel.split('/')] : f.rel.split('/');
    crumbs.innerHTML = parts.map((x, i) => (i === parts.length - 1 ? fileIcon(x) : '') + `<span>${esc(x)}</span>`).join('<span class="sep">›</span>') + (rel == null ? ` <span title="Read-only: outside the project">${ICON.lock}</span>` : '');
  } else crumbs.innerHTML = p ? esc(p.name) : '';
  const st = S.status || {};
  const g = $('#sbGopls');
  let gtext = '', cls = '';
  if (st.index && st.index !== 'ready') { gtext = 'Indexing…'; cls = 'busy'; }
  else if (st.gopls === 'ready') { gtext = 'gopls'; cls = 'ok'; }
  else if (st.gopls && st.gopls.startsWith('error')) { gtext = st.gopls; cls = 'err'; }
  else if (st.gopls && st.gopls !== 'stopped') { gtext = 'gopls: ' + st.gopls; cls = 'busy'; }
  else if (st.gopls === 'stopped') { gtext = 'gopls idle'; }
  g.textContent = gtext; g.title = gtext; g.className = 'sb-gopls ' + cls;
  $('#tbStatus').textContent = st.files != null ? `${st.files.toLocaleString()} files indexed` : '';
}

// ---------------------------------------------------------------- global keys & layout

let lastShift = 0, shiftClean = false;
function initKeys() {
  window.addEventListener('keydown', e => {
    const f = S.files.get(S.active);
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Control' || e.key === 'Meta') { ctrlDown = true; if (hoverEl) setLink(hoverEl); }
    if (e.key === 'Shift' && !mod && !e.altKey) {
      if (!e.repeat) {
        const now = Date.now();
        if (shiftClean && now - lastShift < 400) { e.preventDefault(); lastShift = 0; openFinder('files'); return; }
        lastShift = now; shiftClean = true;
      }
      return;
    }
    shiftClean = false;
    const inInput = e.target.closest && e.target.closest('input, textarea');
    if (inInput) return;
    const k = e.key.toLowerCase();
    if (mod && !e.shiftKey && !e.altKey && k === 'g') { e.preventDefault(); if (f) showUsages(f, f.caret.line, f.caret.col); }
    else if (mod && e.altKey && k === 'b') { e.preventDefault(); if (f) goToImplementation(f); }
    else if (mod && !e.altKey && k === 'b') { e.preventDefault(); if (f) goToDeclaration(f, f.caret.line, f.caret.col); }
    else if (mod && !e.altKey && (k === 'p' || (e.shiftKey && k === 'n'))) { e.preventDefault(); openFinder('files'); }
    else if (mod && !e.altKey && k === 'e') { e.preventDefault(); openFinder('files'); }
    else if (mod && e.key === 'F12') { e.preventDefault(); openFinder('structure'); }
    else if (e.key === 'F8' && !mod && !e.altKey && S.tour) { e.preventDefault(); goStep(S.tour.step + (e.shiftKey ? -1 : 1)); }
    else if (e.altKey && e.shiftKey && !mod && k === 'c') { e.preventDefault(); copyLink(); }
    else if (e.altKey && !mod && e.key === 'F1') { e.preventDefault(); locateInTree(); }
    else if (e.altKey && !mod && e.key === '1') { e.preventDefault(); $('#tree').focus(); }
    else if (e.altKey && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); e.key === 'ArrowLeft' ? history.back() : history.forward(); }
    else if (mod && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); e.key === 'ArrowLeft' ? history.back() : history.forward(); }
    else if (e.key === 'Escape') {
      if (!$('#menu').classList.contains('hidden')) { hideMenu(); return; }
      if (!$('#popup').classList.contains('hidden')) { hidePopup(); return; }
      if (document.querySelector('.modal')) { closeFinder(); return; }
      if (!$('#bottom').classList.contains('hidden')) { closeBottom(); focusEditor(); return; }
      if (f && f.marks) { setMarks(f, null); recordHistory(true); }
      focusEditor();
    }
  }, true);
  window.addEventListener('keyup', e => { if (e.key === 'Control' || e.key === 'Meta') { ctrlDown = false; setLink(null); } });
  window.addEventListener('blur', () => { ctrlDown = false; setLink(null); });
  window.addEventListener('focus', () => { const f = S.files.get(S.active); if (f) reloadIfChanged(f); pollStatus(); });
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#menu') && !e.target.closest('#projBtn') && !e.target.closest('#tbProject')) hideMenu();
    if (!e.target.closest('#popup')) hidePopup();
  });
  $('#popup').addEventListener('mouseenter', () => clearTimeout(popupHideTimer));
  $('#popup').addEventListener('mouseleave', schedulePopupHide);
  $('#crumbs').addEventListener('click', e => { const c = e.target.closest('.c[data-l]'); const f = S.files.get(S.active); if (c && f) openFile(f.path, { line: +c.dataset.l, col: +c.dataset.ch, center: true }); });
}

function initSplitters() {
  const side = $('#sidebar');
  side.style.width = store.get('sideW', 340) + 'px';
  drag($('#splitSide'), (dx, start) => { const w = Math.max(160, Math.min(innerWidth * 0.7, start + dx)); side.style.width = w + 'px'; store.set('sideW', w); }, () => side.offsetWidth, 'x');
  const bottom = $('#bottom');
  drag($('#splitBottom'), (dy, start) => { const h = Math.max(80, Math.min(innerHeight * 0.75, start - dy)); bottom.style.height = h + 'px'; store.set('bottomH', h); }, () => bottom.offsetHeight, 'y');
}

function drag(handle, onMove, getStart, axis) {
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    const s0 = axis === 'x' ? e.clientX : e.clientY, start = getStart();
    const mv = ev => onMove((axis === 'x' ? ev.clientX : ev.clientY) - s0, start);
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); document.body.style.cursor = ''; const f = S.files.get(S.active); if (f) { placeCaret(f, false); renderHighlights(f); } };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
  });
}

// ---------------------------------------------------------------- boot

async function boot() {
  initTree(); initTabs(); initBottom(); initKeys(); initSplitters();
  $('#projBtn').addEventListener('click', e => openProjectMenu(e.currentTarget));
  $('#tbProject').addEventListener('click', e => openProjectMenu(e.currentTarget));
  $('#tbSearch').addEventListener('click', () => openFinder('files'));
  $('#tbHelp').addEventListener('click', openHelp);
  $('#sbLink').addEventListener('click', copyLink);
  await document.fonts.ready.catch(() => {});
  await loadProjects();
  const link = resolveLink(new URLSearchParams(location.hash.slice(1)));
  let pid = link && link.pid ? link.pid : store.get('project', null);
  if (!S.projects.some(p => p.id === pid)) pid = S.projects[0] ? S.projects[0].id : null;
  await switchProject(pid, { restore: true, skipActive: !!(link && (link.path || link.tour)) });
  if (link) await openDeepLink(link);
  if (!S.projects.length) addProjectDialog();
}

boot();
