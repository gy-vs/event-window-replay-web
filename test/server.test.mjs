import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServerWithStore} from '../server.mjs';
import {createStore} from '../src/file-store.mjs';

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({server, port: server.address().port}));
  });
}

async function harness(t, {persist = false} = {}) {
  let dir;
  let file;
  if (persist) {
    dir = await mkdtemp(join(tmpdir(), 'ewr-'));
    file = join(dir, 'store.log');
  }
  const store = await createStore({file, now: () => clock.value});
  const app = createServerWithStore(store);
  const {server, port} = await listen(app);
  const base = `http://127.0.0.1:${port}`;
  const request = async (path, options) => {
    const response = await fetch(base + path, options);
    const body = await response.json().catch(() => ({}));
    return {status: response.status, body};
  };
  const postJson = (path, payload) => request(path, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload),
  });
  const clock = {value: 1000};
  t.after(async () => { await shutdown(); if (dir) await rm(dir, {recursive: true, force: true}); });
  let shutdown = () => new Promise(resolve => server.close(resolve));
  return {request, postJson, store, file, port,
    async close() { await shutdown(); },
    tick(ms) { clock.value += ms; },
    get snapshot() { return store.snapshot(); },
  };
}

test('continuous flow: append, commit, cursor, late arrival, replay vs live', async t => {
  const h = await harness(t);

  // 1. two on-time events
  h.tick(10);
  await h.postJson('/api/events', {id: 'a', window: 'west', eventTime: 10, value: 2});
  h.tick(10);
  await h.postJson('/api/events', {id: 'b', window: 'west', eventTime: 20, value: 3});

  let {body} = await h.request('/api/windows');
  let west = body.windows.find(item => item.window === 'west');
  assert.equal(west.status, 'uncommitted');
  assert.equal(west.headVersion, 2);

  // 2. commit
  h.tick(10);
  const committed = await h.postJson('/api/windows/west/commit', {});
  assert.equal(committed.status, 201);
  assert.equal(committed.body.version, 2);

  // 3. save a cursor at the committed position (this is the "before late data" anchor)
  h.tick(10);
  const saved = await h.postJson('/api/cursors', {name: 'pre-late', window: 'west', version: 2});
  assert.equal(saved.status, 201);
  const cursorId = saved.body.id;

  // 4. late event arrives while the user would be replaying
  h.tick(100);
  await h.postJson('/api/events', {id: 'late-x', window: 'west', eventTime: 5, value: 9});

  // live view must already show the recalculated state, not the historical sum
  body = (await h.request('/api/windows')).body;
  west = body.windows.find(item => item.window === 'west');
  assert.equal(west.status, 'recalculated');
  assert.equal(west.aggregate.sum, 14);
  assert.deepEqual(west.waiting.map(e => e.id), ['late-x']);
  assert.deepEqual(west.confirmed.map(e => e.id), ['a', 'b']);

  // 5. replay through the cursor: history is readable and marked stale
  const replay = await h.request(`/api/replay?window=west&version=2`);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.stale, true);
  assert.deepEqual(replay.body.confirmed.events.map(e => e.id), ['a', 'b']);
  assert.deepEqual(replay.body.waiting.events, []);
  assert.deepEqual(replay.body.later.events.map(e => e.id), ['late-x']);
  assert.equal(replay.body.confirmed.aggregate.sum, 5);

  // 6. saved cursor metadata reports staleness but keeps its frozen result
  const cursorResponse = await h.request(`/api/cursors/${cursorId}`);
  assert.equal(cursorResponse.status, 200);
  assert.equal(cursorResponse.body.stale, true);
  assert.equal(cursorResponse.body.behind, true);
  assert.equal(cursorResponse.body.version, 2);

  // old version endpoint still serves the frozen event set (existing behavior)
  const oldVersion = await h.request('/api/versions/2');
  assert.equal(oldVersion.status, 200);
  assert.deepEqual(oldVersion.body.events.map(e => e.id), ['a', 'b']);
  assert.equal(oldVersion.body.superseded, true);
});

test('pre-commit replay shows confirmed, waiting and later buckets', async t => {
  const h = await harness(t);
  await h.postJson('/api/events', {id: 'a', window: 'w', eventTime: 10, value: 2});
  const v1 = h.snapshot.versions[0].version;
  await h.postJson('/api/events', {id: 'b', window: 'w', eventTime: 20, value: 3});
  await h.postJson('/api/windows/w/commit', {});
  await h.postJson('/api/events', {id: 'late', window: 'w', eventTime: 1, value: 9});

  const {status, body} = await h.request(`/api/replay?window=w&version=${v1}`);
  assert.equal(status, 200);
  assert.deepEqual(body.confirmed.events, []);
  assert.deepEqual(body.waiting.events.map(e => e.id), ['a']);
  assert.deepEqual(body.later.events.map(e => e.id), ['late', 'b']);
});

test('events written during replay still land in the live view', async t => {
  const h = await harness(t);
  await h.postJson('/api/events', {id: 'a', window: 'w', eventTime: 1, value: 2});
  await h.postJson('/api/windows/w/commit', {});
  await h.postJson('/api/cursors', {name: 'anchor', window: 'w', version: 1});

  // simulate the browser sitting on the replay position while new writes happen
  await h.postJson('/api/events', {id: 'during-1', window: 'w', eventTime: 2, value: 4});
  await h.postJson('/api/events', {id: 'during-2', window: 'other', eventTime: 2, value: 1});

  const replay = (await h.request('/api/replay?window=w&version=1')).body;
  assert.deepEqual(replay.later.events.map(e => e.id), ['during-1']);

  const live = (await h.request('/api/windows')).body;
  const ids = live.windows.flatMap(item => item.events.map(e => e.id)).sort();
  assert.deepEqual(ids, ['a', 'during-1', 'during-2']);
});

test('cursor is bound to its window: mismatched version is 409', async t => {
  const h = await harness(t);
  await h.postJson('/api/events', {id: 'a', window: 'w1', eventTime: 1});
  await h.postJson('/api/events', {id: 'b', window: 'w2', eventTime: 1});
  const w2Version = h.snapshot.versions.find(v => v.window === 'w2').version;

  const saved = await h.postJson('/api/cursors', {name: 'x', window: 'w1', version: w2Version});
  assert.equal(saved.status, 409);

  const replay = await h.request(`/api/replay?window=w1&version=${w2Version}`);
  assert.equal(replay.status, 409);
});

test('unknown cursor and version surface 404 without touching live state', async t => {
  const h = await harness(t);
  await h.postJson('/api/events', {id: 'a', window: 'w', eventTime: 1});

  assert.equal((await h.request('/api/cursors/999')).status, 404);
  assert.equal((await h.request('/api/replay?window=w&version=999')).status, 404);
  assert.equal((await h.request('/api/versions/999')).status, 404);
  assert.equal((await h.postJson('/api/windows/ghost/commit', {})).status, 404);

  const live = (await h.request('/api/windows')).body;
  assert.deepEqual(live.windows[0].events.map(e => e.id), ['a']);
});

test('duplicate concurrent appends are idempotent and ordered', async t => {
  const h = await harness(t);
  const results = await Promise.all([
    h.postJson('/api/events', {id: 'dup', window: 'w', eventTime: 5, value: 1}),
    h.postJson('/api/events', {id: 'dup', window: 'w', eventTime: 99, value: 2}),
    h.postJson('/api/events', {id: 'other', window: 'w', eventTime: 3, value: 4}),
  ]);
  assert.ok(results.every(r => r.status === 201));
  const live = (await h.request('/api/windows')).body;
  const west = live.windows.find(item => item.window === 'w');
  assert.deepEqual(west.events.map(e => [e.id, e.value]), [['other', 4], ['dup', 1]]);
  // only two versions: duplicate delivery must not mint a new one
  assert.equal(west.versions.length, 2);
});

test('durable log replays events, commits and cursors after restart', async t => {
  const h = await harness(t, {persist: true});
  await h.postJson('/api/events', {id: 'a', window: 'w', eventTime: 1, value: 2});
  await h.postJson('/api/windows/w/commit', {});
  await h.postJson('/api/cursors', {name: 'anchor', window: 'w', version: 1});
  h.tick(50);
  await h.postJson('/api/events', {id: 'late', window: 'w', eventTime: 0, value: 9});
  await h.close();

  // restart with a fresh store over the same file
  const reopened = await createStore({file: h.file, now: () => 9999});
  const app = createServerWithStore(reopened);
  const {server, port} = await listen(app);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;
  const body = await (await fetch(base + '/api/windows')).json();
  const win = body.windows.find(item => item.window === 'w');
  assert.equal(win.status, 'recalculated');
  assert.deepEqual(win.events.map(e => e.id), ['late', 'a']);
  assert.equal(body.cursors.length, 1);
  assert.equal(body.cursors[0].stale, true);

  // writing after restart continues from the replayed version/cursor counters
  const response = await fetch(base + '/api/events', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({id: 'after-restart', window: 'w', eventTime: 2, value: 1}),
  });
  assert.equal(response.status, 201);
  const again = await (await fetch(base + '/api/windows')).json();
  const cursor = again.cursors[0];
  assert.equal(cursor.id, 1);
  assert.equal(again.windows[0].headVersion, 3);
});

test('static page and app script are served for the browser timeline', async t => {
  const h = await harness(t);
  const base = `http://127.0.0.1:${h.port}`;

  const htmlResponse = await fetch(base + '/');
  assert.equal(htmlResponse.headers.get('content-type')?.includes('text/html'), true);
  const html = await htmlResponse.text();
  assert.match(html, /事件窗口回放/);
  assert.match(html, /\/app\.js/);

  const jsResponse = await fetch(base + '/app.js');
  assert.equal(jsResponse.headers.get('content-type')?.includes('javascript'), true);
  assert.match(await jsResponse.text(), /\/api\/replay/);

  // legacy JSON root moved under /api/health and still reports the service
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.service, 'event-window-replay');
});
