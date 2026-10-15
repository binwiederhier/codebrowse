'use strict';
// Changes against the base branch as navigation stops, and review marks on them. Pure functions,
// shared by app.js and the node tests.

// changeStops turns /api/changes files into one stop per changed line run, in path and line order.
// A stop's key (path and content ID) names it for review marks; a file without line runs is one stop.
function changeStops(files) {
  const stops = [];
  for (const c of files) {
    if (!c.changes.length) { stops.push({ path: c.path, rel: c.rel, line: 0, end: 0, key: c.rel + '\n' }); continue; }
    const mine = c.changes.map(ch => ({ path: c.path, rel: c.rel, line: Math.max(0, ch.start), end: Math.max(0, ch.end), key: c.rel + '\n' + ch.id }));
    mine.sort((a, b) => a.line - b.line);
    stops.push(...mine);
  }
  return stops;
}

// nextStop finds the stop after (dir 1) or before (dir -1) the given file and line, wrapping around.
function nextStop(stops, rel, line, dir) {
  if (!stops.length) return null;
  const cmp = st => st.rel < rel ? -1 : st.rel > rel ? 1 : st.line - line;
  const stop = dir > 0 ? stops.find(x => cmp(x) > 0) : [...stops].reverse().find(x => cmp(x) < 0);
  if (stop) return { stop, wrapped: false };
  return { stop: dir > 0 ? stops[0] : stops[stops.length - 1], wrapped: true };
}

// nextInFile is nextStop within one file.
function nextInFile(stops, path, line, dir) {
  const mine = stops.filter(st => st.path === path);
  if (!mine.length) return null;
  const stop = dir > 0 ? mine.find(x => x.line > line) : [...mine].reverse().find(x => x.line < line);
  return stop || (dir > 0 ? mine[0] : mine[mine.length - 1]);
}

// stopIndexAt is the index of the stop the line is in, or -1.
function stopIndexAt(stops, path, line) {
  return stops.findIndex(st => st.path === path && line >= st.line && line <= st.end);
}

// fileReview is 'all', 'some' or 'none' of a file's changes reviewed, or null for an unchanged file.
function fileReview(stops, path, reviewed) {
  const mine = stops.filter(st => st.path === path);
  if (!mine.length) return null;
  const n = mine.filter(st => reviewed.has(st.key)).length;
  return n === mine.length ? 'all' : n ? 'some' : 'none';
}

// markKeys adds (on) or removes keys from the stored list, most recent last, keeping at most max.
function markKeys(list, keys, on, max) {
  const drop = new Set(keys);
  const res = list.filter(k => !drop.has(k));
  if (on) res.push(...keys);
  return res.slice(Math.max(0, res.length - max));
}

// changeAtLine is the change whose gutter marker is on the line: an added or changed run covering it,
// else a deletion drawn there (one above the first line is drawn on it), else null.
function changeAtLine(changes, line) {
  return changes.find(c => c.kind !== 'del' && line >= c.start && line <= c.end) ||
    changes.find(c => c.kind === 'del' && Math.max(c.start, 0) === line) || null;
}

if (typeof module !== 'undefined') module.exports = { changeStops, nextStop, nextInFile, stopIndexAt, fileReview, markKeys, changeAtLine };
