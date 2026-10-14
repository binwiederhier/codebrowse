// Tests for web/projtree.js, the project menu tree. Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { projectTree } = require('../web/projtree.js');

const pr = (id, path) => ({ id, name: id, path });

// shape renders a tree as nested arrays: folders as "name/" with children, projects as their id
const shape = nodes => nodes.map(n => n.project
  ? (n.children.length ? [n.project.id, shape(n.children)] : n.project.id)
  : [n.name + '/', shape(n.children)]);

test('strips the common parent and groups by folder', () => {
  const t = projectTree([pr('ntfy', '/h/Code/ntfy/ntfy'), pr('admin', '/h/Code/ntfy/admin'), pr('hostit', '/h/Code/hostit')]);
  assert.deepStrictEqual(shape(t), ['hostit', ['ntfy/', ['admin', 'ntfy']]]);
});

test('compacts chains of folders without projects', () => {
  const t = projectTree([pr('a', '/h/Code/workspaces/x/a'), pr('b', '/h/Code/workspaces/x/b'), pr('c', '/h/Code/c')]);
  assert.deepStrictEqual(shape(t), ['c', ['workspaces/x/', ['a', 'b']]]);
});

test('a project that contains other projects is their parent', () => {
  const t = projectTree([pr('ntfy-2', '/h/Code/ntfy'), pr('admin', '/h/Code/ntfy/admin'), pr('hostit', '/h/Code/hostit')]);
  assert.deepStrictEqual(shape(t), ['hostit', ['ntfy-2', ['admin']]]);
});

test('sorts folders and projects together by name, case-insensitively', () => {
  const t = projectTree([pr('Zed', '/h/Zed'), pr('alpha', '/h/alpha'), pr('m', '/h/mid/m'), pr('n', '/h/mid/n')]);
  assert.deepStrictEqual(shape(t), ['alpha', ['mid/', ['m', 'n']], 'Zed']);
});

test('a single project and no projects', () => {
  assert.deepStrictEqual(shape(projectTree([pr('a', '/h/Code/a')])), ['a']);
  assert.deepStrictEqual(projectTree([]), []);
});

test('folder nodes carry a stable key for remembering collapsed state', () => {
  const t = projectTree([pr('a', '/h/Code/ws/x/a'), pr('b', '/h/Code/ws/x/b'), pr('c', '/h/Code/c')]);
  assert.strictEqual(t[1].key, '/h/Code/ws/x');
});
