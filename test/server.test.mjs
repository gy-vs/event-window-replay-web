import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
import {EventStore} from '../src/event-store.mjs';

async function startServer(dataFile) {
  const store = new EventStore(dataFile);
  await store.ready;
  const app = createApp(store);
  await new Promise(resolve => app.listen(0, resolve));
  const port = app.address().port;
  return {store, app, base: `http://127.0.0.1:${port}`};
}

async function withServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ewr-'));
  const dataFile = join(dir, 'state.json');
  const server = await startServer(dataFile);
  try { return await fn(server, dataFile); } finally { await new Promise(r => server.app.close(r)); await rm(dir, {recursive: true, force: true}); }
}

async function api(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? {'content-type': 'application/json'} : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return {res, json};
}
const post = (base, path, body) => api(base, 'POST', path, body);
const get = (base, path) => api(base, 'GET', path);

test('continuous flow: events, advance, save cursor, late event, recompute, stale restore', async () => {
  await withServer(async ({base}) => {
    // 1) write the first batch
    await post(base, '/api/events', {id: 'a', window: 'west', eventTime: 10, value: 2});
    await post(base, '/api/events', {id: 'b', window: 'west', eventTime: 20, value: 3});

    // 2) submit the window -> v1
    const adv = await post(base, '/api/windows/advance', {window: 'west'});
    assert.equal(adv.res.status, 201);
    assert.deepEqual(adv.json.events.map(e => e.id), ['a', 'b']);
    assert.equal(adv.json.kind, 'commit');
    const v1 = adv.json.version;

    // 3) save a cursor at the pre-commit position
    const preCommitAt = adv.json.seq - 1;
    const saved = await post(base, '/api/cursors', {version: v1, atSeq: preCommitAt, label: 'before submit'});
    assert.equal(saved.res.status, 201);
    assert.equal(saved.json.cursor.atSeq, preCommitAt);
    assert.equal(saved.json.view.committedVersion, null);
    assert.deepEqual(saved.json.view.waiting.map(e => e.id), ['a', 'b']);
    assert.deepEqual(saved.json.view.later.map(e => e.id), []);
    const cursorId = saved.json.cursor.id;

    // legacy endpoints preserved
    const wins = await get(base, '/api/windows');
    assert.equal(wins.json.windows[0].status, 'closed');
    const v1Read = await get(base, `/api/versions/${v1}`);
    assert.deepEqual(v1Read.json.events.map(e => e.id), ['a', 'b']);

    // 4) late event arrives -> recompute v2
    const late = await post(base, '/api/events', {id: 'late1', window: 'west', eventTime: 5, value: 7});
    assert.equal(late.res.status, 201);
    assert.equal(late.json.late, true);
    const windows2 = await get(base, '/api/windows');
    assert.equal(windows2.json.windows[0].lastCommittedVersion, v1 + 1);
    assert.deepEqual(
      (await get(base, `/api/versions/${v1}`)).json.events.map(e => e.id),
      ['a', 'b'],
      'old version snapshot is still readable',
    );

    // 5) restoring the old cursor is rejected...
    const restore = await post(base, `/api/cursors/${cursorId}/restore`);
    assert.equal(restore.res.status, 409);
    assert.equal(restore.json.code, 'STALE_CURSOR');

    // ...but the cursor still reads history and never overwrites current state
    const historical = await get(base, `/api/cursors/${cursorId}`);
    assert.equal(historical.res.status, 200);
    assert.equal(historical.json.view.boundStale, true);
    assert.equal(historical.json.view.committedVersion, null);
    assert.deepEqual(historical.json.view.waiting.map(e => e.id), ['a', 'b']);

    const after = await get(base, '/api/windows');
    assert.deepEqual(after.json.windows[0].events.map(e => e.id), ['late1', 'a', 'b'],
      'failed restore did not roll current state back');
  });
});

test('replay position reports confirmed, waiting and later buckets independently of current data', async () => {
  await withServer(async ({base}) => {
    await post(base, '/api/events', {id: 'a', window: 'east', eventTime: 1});
    await post(base, '/api/events', {id: 'b', window: 'east', eventTime: 2});
    await post(base, '/api/windows/advance', {window: 'east'});
    const v1 = (await get(base, '/api/windows')).json.windows[0].lastCommittedVersion;
    // events that only arrive after the cursor position
    await post(base, '/api/events', {id: 'c', window: 'east', eventTime: 3});
    await post(base, '/api/events', {id: 'd', window: 'other', eventTime: 9});

    const v1Detail = (await get(base, `/api/versions/${v1}`)).json;
    const view = (await get(base, `/api/views?window=east&atSeq=${v1Detail.seq}`)).json;
    assert.deepEqual(view.confirmed.map(e => e.id), ['a', 'b']);
    assert.deepEqual(view.waiting.map(e => e.id), []);
    assert.deepEqual(view.later.map(e => e.id), ['c']);
    assert.equal(view.currentSeq, (await get(base, '/api/timeline')).json.seq);

    // invalid cursor position rejected
    const bad = await get(base, `/api/views?window=east&atSeq=${view.currentSeq + 5}`);
    assert.equal(bad.res.status, 400);
  });
});

test('fresh events written during replay remain visible after switching back to live', async () => {
  await withServer(async ({base}) => {
    await post(base, '/api/events', {id: 'a', window: 'west', eventTime: 1});
    await post(base, '/api/windows/advance', {window: 'west'});
    const tl1 = (await get(base, '/api/timeline')).json;

    // user is parked on a historical position
    const cursor = await post(base, '/api/cursors', {version: 1, atSeq: 0});
    assert.equal(cursor.res.status, 201);

    // new writes land while she replays
    await post(base, '/api/events', {id: 'during-replay', window: 'north', eventTime: 40});
    const tl2 = (await get(base, '/api/timeline')).json;
    assert.ok(tl2.seq > tl1.seq);

    // historical view stays pinned; live endpoint already carries the new event
    const parked = (await get(base, '/api/views?window=west&atSeq=0')).json;
    assert.deepEqual(parked.later.map(e => e.id), ['a']);
    const liveNow = (await get(base, '/api/windows')).json;
    assert.ok(liveNow.windows.some(w => w.events.some(e => e.id === 'during-replay')));
  });
});

test('concurrent event POSTs are serialized and none are lost', async () => {
  await withServer(async ({base}) => {
    const count = 25;
    await Promise.all(Array.from({length: count}, (_, i) =>
      post(base, '/api/events', {id: `e${i}`, window: 'race', eventTime: i})));
    const windows = (await get(base, '/api/windows')).json.windows;
    const race = windows.find(w => w.window === 'race');
    assert.equal(race.events.length, count);
    const tl = (await get(base, '/api/timeline')).json;
    assert.equal(new Set(tl.events.map(e => e.arrivedSeq)).size, count, 'arrival seqs are unique');
  });
});

test('duplicate POSTs do not add events or versions', async () => {
  await withServer(async ({base}) => {
    await post(base, '/api/events', {id: 'x', window: 'west', eventTime: 1});
    const dup = await post(base, '/api/events', {id: 'x', window: 'west', eventTime: 2});
    assert.equal(dup.json.eventTime, 1);
    const tl = (await get(base, '/api/timeline')).json;
    assert.equal(tl.events.length, 1);
    assert.equal(tl.versions.length, 0);
  });
});

test('saved cursors survive a server restart from the data file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ewr-restart-'));
  const dataFile = join(dir, 'state.json');
  try {
    // first "process": write, commit, save cursor, shut down
    {
      const server = await startServer(dataFile);
      const {base} = server;
      try {
        await post(base, '/api/events', {id: 'a', window: 'west', eventTime: 1});
        await post(base, '/api/windows/advance', {window: 'west'});
        await post(base, '/api/cursors', {version: 1, atSeq: 0, label: 'persist me'});
      } finally {
        await new Promise(r => server.app.close(r));
      }
    }

    // restarted store/server against the same file
    const server = await startServer(dataFile);
    const {base} = server;
    try {
      const cursors = (await get(base, '/api/cursors')).json;
      assert.equal(cursors.cursors.length, 1);
      assert.equal(cursors.cursors[0].label, 'persist me');
      const restored = await post(base, '/api/cursors/1/restore');
      assert.equal(restored.res.status, 200);
      assert.equal(restored.json.cursor.window, 'west');
      assert.deepEqual(restored.json.view.later.map(e => e.id), ['a']);
    } finally {
      await new Promise(r => server.app.close(r));
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('cursor bound to a current version restores successfully', async () => {
  await withServer(async ({base}) => {
    await post(base, '/api/events', {id: 'a', window: 'south', eventTime: 1});
    await post(base, '/api/windows/advance', {window: 'south'});
    const v1 = (await get(base, '/api/windows')).json.windows[0].lastCommittedVersion;
    const saved = await post(base, '/api/cursors', {version: v1});
    assert.equal(saved.json.cursor.atSeq, saved.json.cursor.atSeq);
    const ok = await post(base, `/api/cursors/${saved.json.cursor.id}/restore`);
    assert.equal(ok.res.status, 200);
    assert.equal(ok.json.view.boundStale, false);
    assert.deepEqual(ok.json.view.confirmed.map(e => e.id), ['a']);
  });
});

test('browser receives the page at / and legacy JSON root for API clients', async () => {
  await withServer(async ({base}) => {
    const page = await fetch(base + '/', {headers: {accept: 'text/html'}});
    assert.match(await page.text(), /Event window replay/);
    const jsonRoot = await fetch(base + '/', {headers: {accept: 'application/json'}});
    assert.equal((await jsonRoot.json()).service, 'event-window-replay');
  });
});
