import test from 'node:test';
import assert from 'node:assert/strict';
import {appendEvent, createWindowLog, currentWindows, readVersion} from '../src/window-log.mjs';

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
