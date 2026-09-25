import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendEvent, commitWindow, createWindowLog, currentWindows, getCursor,
  readVersion, replayView, saveCursor,
} from '../src/window-log.mjs';

function build(events) {
  let state = createWindowLog();
  for (const event of events) state = appendEvent(state, event);
  return state;
}
const ids = bucket => bucket.events.map(item => item.id);

test('window history keeps the earlier event set readable', () => {
  let state = createWindowLog();
  state = appendEvent(state, {id: 'a', window: 'west', eventTime: 10, value: 2});
  const oldVersion = state.versions[0].version;
  state = appendEvent(state, {id: 'b', window: 'west', eventTime: 5, value: 4});
  assert.deepEqual(readVersion(state, oldVersion).events.map(item => item.id), ['a']);
  assert.deepEqual(currentWindows(state)[0].events.map(item => item.id), ['b', 'a']);
});

test('duplicate delivery is idempotent', () => {
  let state = createWindowLog();
  state = appendEvent(state, {id: 'a', window: 'north', eventTime: 1});
  const again = appendEvent(state, {id: 'a', window: 'north', eventTime: 9});
  assert.deepEqual(again, state);
});

test('commit locks a watermark and later appends become late arrivals', () => {
  let state = build([
    {id: 'a', window: 'w', eventTime: 1, value: 2, arrivedAt: 100},
    {id: 'b', window: 'w', eventTime: 2, value: 3, arrivedAt: 110},
  ]);
  const committed = state.versions.at(-1).version;
  state = commitWindow(state, 'w', 200);
  state = appendEvent(state, {id: 'late', window: 'w', eventTime: 0, value: 9, arrivedAt: 300});

  const win = currentWindows(state).find(item => item.window === 'w');
  assert.equal(win.status, 'recalculated');
  assert.deepEqual(ids({events: win.confirmed}), ['a', 'b']);
  assert.deepEqual(ids({events: win.waiting}), ['late']);

  // The old commit is still readable but flagged superseded; its event set is frozen.
  const old = readVersion(state, committed);
  assert.equal(old.superseded, true);
  assert.deepEqual(old.events.map(item => item.id), ['a', 'b']);

  const newVersion = state.versions.at(-1);
  assert.equal(newVersion.late, true);
});

test('replay at a pre-commit version separates confirmed, waiting and later events', () => {
  let state = build([
    {id: 'a', window: 'w', eventTime: 1, value: 2, arrivedAt: 100},
  ]);
  const preCommitVersion = state.versions[0].version;
  state = appendEvent(state, {id: 'b', window: 'w', eventTime: 2, value: 3, arrivedAt: 120});
  state = commitWindow(state, 'w', 200);
  state = appendEvent(state, {id: 'late', window: 'w', eventTime: 0, value: 7, arrivedAt: 300});

  const view = replayView(state, 'w', preCommitVersion);
  assert.deepEqual(ids(view.confirmed), []);
  assert.deepEqual(ids(view.waiting), ['a']);
  assert.deepEqual(ids(view.later), ['late', 'b']); // later sorted by eventTime
  assert.equal(view.behind, true);
});

test('replay at the committed version shows confirmed data plus future late arrivals', () => {
  let state = build([
    {id: 'a', window: 'w', eventTime: 1, value: 2, arrivedAt: 100},
    {id: 'b', window: 'w', eventTime: 2, value: 3, arrivedAt: 110},
  ]);
  const committed = state.versions.at(-1).version;
  state = commitWindow(state, 'w', 200);
  state = appendEvent(state, {id: 'late', window: 'w', eventTime: 0, value: 7, arrivedAt: 300});

  const view = replayView(state, 'w', committed);
  assert.deepEqual(ids(view.confirmed), ['a', 'b']);
  assert.deepEqual(ids(view.waiting), []);
  assert.deepEqual(ids(view.later), ['late']);
  assert.equal(view.stale, true);
  assert.equal(view.confirmed.aggregate.sum, 5);
});

test('cursor is bound to window and version and stays readable when superseded', () => {
  let state = build([{id: 'a', window: 'w', eventTime: 1, arrivedAt: 100}]);
  state = commitWindow(state, 'w', 200);
  const savedAt = state.versions[0].version;
  const outcome = saveCursor(state, {name: 'before late', window: 'w', version: savedAt}, 250);
  state = outcome.state;
  state = appendEvent(state, {id: 'late', window: 'w', eventTime: 0, arrivedAt: 300});

  const cursor = getCursor(state, outcome.cursor.id);
  assert.equal(cursor.stale, true);
  assert.equal(cursor.behind, true);
  assert.equal(cursor.headVersion, state.versions.at(-1).version);

  // The cursor never rewrites live state: waiting data is still pending.
  const win = currentWindows(state)[0];
  assert.equal(win.status, 'recalculated');

  assert.throws(() => saveCursor(state, {name: 'x', window: 'other', version: savedAt}), /does not match/);
  assert.throws(() => saveCursor(state, {name: 'x', window: 'w', version: 9999}), /unknown/);
});

test('recommit clears the recalculated status without rewriting history', () => {
  let state = build([{id: 'a', window: 'w', eventTime: 1, value: 2, arrivedAt: 100}]);
  const firstCommit = state.versions[0].version;
  state = commitWindow(state, 'w', 200);
  state = appendEvent(state, {id: 'late', window: 'w', eventTime: 0, value: 7, arrivedAt: 300});
  const secondCommit = state.versions.at(-1).version;
  state = commitWindow(state, 'w', 400);

  assert.equal(currentWindows(state)[0].status, 'confirmed');
  const oldView = replayView(state, 'w', firstCommit);
  assert.equal(oldView.stale, true);
  assert.deepEqual(ids(oldView.confirmed), ['a']);
  assert.deepEqual(ids(oldView.later), ['late']);
  const newView = replayView(state, 'w', secondCommit);
  assert.deepEqual(ids(newView.confirmed), ['late', 'a']);
  assert.equal(newView.stale, false);
});

test('commit is idempotent when nothing new is waiting', () => {
  let state = build([{id: 'a', window: 'w', eventTime: 1}]);
  state = commitWindow(state, 'w');
  const versionsBefore = state.versions.length;
  const again = commitWindow(state, 'w');
  assert.deepEqual(again, state);
  assert.equal(again.versions.length, versionsBefore);
});

test('versions of other windows do not interfere with replay or commits', () => {
  let state = build([
    {id: 'a', window: 'w1', eventTime: 1, arrivedAt: 100},
    {id: 'b', window: 'w2', eventTime: 1, arrivedAt: 101},
  ]);
  state = commitWindow(state, 'w1', 200);
  state = appendEvent(state, {id: 'late1', window: 'w1', eventTime: 0, arrivedAt: 300});

  const w2 = currentWindows(state).find(item => item.window === 'w2');
  assert.equal(w2.status, 'uncommitted');
  const view = replayView(state, 'w2', state.versions.find(v => v.window === 'w2').version);
  assert.deepEqual(ids(view.waiting), ['b']);
  assert.equal(view.stale, false);

  assert.throws(() => replayView(state, 'w1', state.versions.find(v => v.window === 'w2').version), /does not match/);
});
