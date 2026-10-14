// projtree.js: groups the project list into a folder tree for the project menu.

// projectTree returns the top-level nodes of the tree. Each node is { name, key, project, children }:
// project is null for a plain folder, and key is the node's absolute path. Paths are relative to the
// deepest folder that contains every project, and chains of plain folders are joined ("ws/x").
function projectTree(projects) {
  if (!projects.length) return [];
  const split = p => p.split('/').filter(Boolean);

  // Find the common parent of all projects
  let base = null;
  for (const pr of projects) {
    const parent = split(pr.path).slice(0, -1);
    if (!base) { base = parent; continue; }
    let i = 0;
    while (i < base.length && i < parent.length && base[i] === parent[i]) i++;
    base = base.slice(0, i);
  }

  // Build the tree below it
  const root = { children: [] };
  const sorted = [...projects].sort((a, b) => a.path.length - b.path.length);
  for (const pr of sorted) {
    let node = root, key = '/' + base.join('/');
    for (const seg of split(pr.path).slice(base.length)) {
      key = (key === '/' ? '' : key) + '/' + seg;
      let child = node.children.find(c => c.key === key);
      if (!child) { child = { name: seg, key, project: null, children: [] }; node.children.push(child); }
      node = child;
    }
    if (node.project) node.children.push({ name: node.name, key: node.key, project: pr, children: [] }); // same path twice
    else node.project = pr;
  }

  // Join plain folder chains, then sort folders and projects together by label
  const label = n => (n.project ? n.project.name : n.name).toLowerCase();
  const finish = nodes => {
    for (const n of nodes) {
      while (!n.project && n.children.length === 1 && !n.children[0].project) {
        const c = n.children[0];
        n.name += '/' + c.name; n.key = c.key; n.children = c.children;
      }
      finish(n.children);
    }
    return nodes.sort((a, b) => label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0);
  };
  return finish(root.children);
}

if (typeof module !== 'undefined') module.exports = { projectTree };
