// Tests for web/review.js, change navigation and review marks. Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { changeStops, nextStop, nextInFile, stopIndexAt, fileReview, markKeys, changeAtLine } = require('../web/review.js');

const files = [
  { path: '/p/a.go', rel: 'a.go', changes: [{ kind: 'mod', start: 4, end: 6, id: 'x' }, { kind: 'del', start: -1, end: -1, id: 'y' }] },
  { path: '/p/big.bin', rel: 'big.bin', changes: [] },
  { path: '/p/sub/c.go', rel: 'sub/c.go', changes: [{ kind: 'add', start: 0, end: 9, id: 'z' }] },
];

test('builds one stop per change in path and line order, keyed by path and content ID', () => {
  assert.deepStrictEqual(changeStops(files).map(s => [s.rel, s.line, s.end, s.key]), [
    ['a.go', 0, 0, 'a.go\ny'], ['a.go', 4, 6, 'a.go\nx'], ['big.bin', 0, 0, 'big.bin\n'], ['sub/c.go', 0, 9, 'sub/c.go\nz'],
  ]);
});

test('steps across files in path and line order, wrapping around', () => {
  const stops = changeStops(files);
  assert.deepStrictEqual(nextStop(stops, 'a.go', 0, 1), { stop: stops[1], wrapped: false });
  assert.deepStrictEqual(nextStop(stops, 'a.go', 4, 1).stop.rel, 'big.bin');
  assert.deepStrictEqual(nextStop(stops, 'sub/c.go', 0, 1), { stop: stops[0], wrapped: true });
  assert.deepStrictEqual(nextStop(stops, 'a.go', 0, -1), { stop: stops[3], wrapped: true });
  assert.deepStrictEqual(nextStop(stops, '', -1, 1), { stop: stops[0], wrapped: false });
  assert.strictEqual(nextStop([], 'a.go', 0, 1), null);
});

test('steps within one file, wrapping around', () => {
  const stops = changeStops(files);
  assert.strictEqual(nextInFile(stops, '/p/a.go', 0, 1).line, 4);
  assert.strictEqual(nextInFile(stops, '/p/a.go', 4, 1).line, 0);
  assert.strictEqual(nextInFile(stops, '/p/a.go', 2, -1).line, 0);
  assert.strictEqual(nextInFile(stops, '/p/none.go', 2, 1), null);
});

test('finds the change at the caret', () => {
  const stops = changeStops(files);
  assert.strictEqual(stopIndexAt(stops, '/p/a.go', 5), 1);
  assert.strictEqual(stopIndexAt(stops, '/p/a.go', 3), -1);
});

test('reports a file as reviewed when all its changes are', () => {
  const stops = changeStops(files);
  assert.strictEqual(fileReview(stops, '/p/a.go', new Set()), 'none');
  assert.strictEqual(fileReview(stops, '/p/a.go', new Set(['a.go\nx'])), 'some');
  assert.strictEqual(fileReview(stops, '/p/a.go', new Set(['a.go\nx', 'a.go\ny'])), 'all');
  assert.strictEqual(fileReview(stops, '/p/other.go', new Set(['a.go\nx'])), null);
});

test('marks and unmarks keys, most recent last, capped', () => {
  assert.deepStrictEqual(markKeys(['a', 'b'], ['a', 'c'], true, 10), ['b', 'a', 'c']);
  assert.deepStrictEqual(markKeys(['a', 'b', 'c'], ['b'], false, 10), ['a', 'c']);
  assert.deepStrictEqual(markKeys(['a', 'b', 'c'], ['d'], true, 3), ['b', 'c', 'd']);
});

test('finds the change drawn on a line, an added or changed run winning over a deletion', () => {
  const changes = [{ kind: 'del', start: -1, end: -1 }, { kind: 'mod', start: 3, end: 5 }, { kind: 'del', start: 5, end: 5 }, { kind: 'del', start: 8, end: 8 }];
  assert.strictEqual(changeAtLine(changes, 0), changes[0]);
  assert.strictEqual(changeAtLine(changes, 5), changes[1]);
  assert.strictEqual(changeAtLine(changes, 8), changes[3]);
  assert.strictEqual(changeAtLine(changes, 7), null);
});
