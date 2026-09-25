import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceWindow,
  appendEvent,
  createWindowLog,
  currentWindows,
  readVersion,
  timelineView,
  viewAt,
} from '../src/window-log.mjs';

test('committed history stays readable after later arrivals', () => {
  let state = createWindowLog();
  state = appendEvent(state, {id: 'a', window: 'west', eventTime: 10, value: 2});
  state = advanceWindow(state, {window: 'west'});
  const oldVersion = state.versions[0].version;

  // A new arrival into the open/closed window must not mutate the snapshot.
  state = appendEvent(state, {id: 'b', window: 'west', eventTime: 5, value: 4});
  assert.deepEqual(readVersion(state, oldVersion).events.map(item => item.id), ['a']);
  assert.deepEqual(currentWindows(state)[0].events.map(item => item.id), ['b', 'a']);
  assert.equal(currentWindows(state)[0].status, 'closed');
});

test('duplicate delivery is idempotent and does not move the sequence', () => {
  let state = createWindowLog();
  state = appendEvent(state, {id: 'a', window: 'north', eventTime: 1});
  const again = appendEvent(state, {id: 'a', window: 'north', eventTime: 9});
  assert.deepEqual(again, state);
});

test('pre-commit cursor sees confirmed results, waiting data and later events', () => {
  let state = createWindowLog();
  state = appendEvent(state, {id: 'a', window: 'west', eventTime: 1, value: 2});
  state = appendEvent(state, {id: 'b', window: 'west', eventTime: 2, value: 3});
  state = advanceWindow(state, {window: 'west'});
  const v1 = state.versions[0];
  state = appendEvent(state, {id: 'c', window: 'west', eventTime: 0, value: 9}); // late -> recompute v2
  const v2 = state.versions.find(v => v.kind === 'recompute');

  // Position immediately before v1 was committed: a is still only waiting.
  const before = viewAt(state, {window: 'west', atSeq: v1.seq - 1});
  assert.equal(before.committedVersion, null);
  assert.deepEqual(before.waiting.map(e => e.id), ['a', 'b']);
  assert.deepEqual(before.later.map(e => e.id), ['c']);

  // Position at v1: a,b are confirmed; c (arrives after) is later.
  const atV1 = viewAt(state, {window: 'west', atSeq: v1.seq});
  assert.equal(atV1.committedVersion, v1.version);
  assert.deepEqual(atV1.confirmed.map(e => e.id), ['a', 'b']);
  assert.deepEqual(atV1.later.map(e => e.id), ['c']);

  // Position at the recompute: snapshot includes the late event, old version
  // remains readable but is superseded.
  const atV2 = viewAt(state, {window: 'west', atSeq: v2.seq});
  assert.deepEqual(atV2.confirmed.map(e => e.id), ['c', 'a', 'b']);
  assert.equal(readVersion(state, v1.version).supersededBy, v2.version);
  assert.equal(readVersion(state, v1.version).events.length, 2);

  const tl = timelineView(state);
  // a arrival, commit v1, b arrival, then late c arrival + its recompute v2
  // sharing one tick (arrival ordered before the commit it triggers)
  assert.deepEqual(tl.occurrences.map(o => o.seq), [1, 2, 3, 4, 4]);
  assert.equal(tl.occurrences[4].kind, 'recompute');
});

test('a closed window rejects a second advance but recalculates on late arrival', () => {
  let state = createWindowLog();
  state = appendEvent(state, {id: 'a', window: 'west', eventTime: 1});
  state = advanceWindow(state, {window: 'west'});
  assert.throws(() => advanceWindow(state, {window: 'west'}), /already committed/);
  state = appendEvent(state, {id: 'late-a', window: 'west', eventTime: 0});
  assert.equal(state.versions.length, 2);
  assert.equal(state.versions[1].kind, 'recompute');
  assert.equal(state.versions[1].basedOnVersion, state.versions[0].version);
});
