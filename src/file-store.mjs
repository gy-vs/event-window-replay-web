// Durable store around the pure window log.
//
// Every mutation is appended as one JSON line to the log file and then applied
// to the in-memory state. Writes are serialised through a promise queue so
// concurrent event posts keep a single consistent order and the log replays
// deterministically on restart. A partial trailing line from a crashed process
// is skipped on load; earlier records stay intact.

import {mkdir, open, readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {appendEvent, commitWindow, createWindowLog, ingestCursor, saveCursor} from './window-log.mjs';

function applyOp(state, op) {
  if (op.type === 'event') return appendEvent(state, op.event);
  if (op.type === 'commit') return commitWindow(state, op.window, op.at);
  if (op.type === 'cursor') return ingestCursor(state, op.cursor);
  throw new Error(`unknown log op ${op.type}`);
}

export async function createStore({file, now = () => Date.now()} = {}) {
  let state = createWindowLog();
  let fileHandle = null;
  let queue = Promise.resolve();

  if (file) {
    await mkdir(dirname(file), {recursive: true});
    let raw = '';
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        state = applyOp(state, JSON.parse(trimmed));
      } catch {
        break; // partial trailing write from a crashed process
      }
    }
    fileHandle = await open(file, 'a');
  }

  // The task computes {next, op, result} from the current state; the op is
  // flushed before the state swap, so memory and disk always agree.
  function enqueue(task) {
    const run = queue.then(async () => {
      const outcome = await task(state);
      if (fileHandle && outcome.op) {
        await fileHandle.writeFile(JSON.stringify(outcome.op) + '\n');
      }
      state = outcome.next;
      return outcome.result;
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    snapshot: () => state,
    appendEvent(event) {
      return enqueue(current => {
        if (current.events.some(item => item.id === event.id)) {
          return {next: current, op: null, result: current.events.find(item => item.id === event.id)};
        }
        const stored = {...event, arrivedAt: now()};
        return {next: appendEvent(current, stored), op: {type: 'event', event: stored}, result: stored};
      });
    },
    commit(window) {
      return enqueue(current => {
        const versions = current.versions.filter(item => item.window === window);
        if (versions.length === 0) throw new Error('unknown window');
        const head = versions[versions.length - 1];
        if (head.committed) return {next: current, op: null, result: {version: head.version, noop: true}};
        const at = now();
        const next = commitWindow(current, window, at);
        return {next, op: {type: 'commit', window, at}, result: {version: head.version}};
      });
    },
    saveCursor(input) {
      return enqueue(current => {
        const at = now();
        const {state: next, cursor} = saveCursor(current, input, at);
        return {next, op: {type: 'cursor', cursor}, result: cursor};
      });
    },
  };
}
