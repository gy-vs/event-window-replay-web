// Event window replay UI.
//
// Two views coexist: the live view is always fed by /api/windows polling (even
// during replay, so newly written events are never lost), while the replay
// view is a historical snapshot from /api/replay split into confirmed /
// waiting / later buckets. Dragging the timeline moves a version cursor; it
// never asks the server to rewrite anything. A superseded cursor stays
// readable but is shown as expired.

const $ = selector => document.querySelector(selector);
const els = {
  mode: $('#mode'), tabs: $('#tabs'), windowStatus: $('#window-status'),
  commit: $('#commit'), saveCursor: $('#save-cursor'), cursorList: $('#cursor-list'),
  backLive: $('#back-live'), timeline: $('#timeline'), ticks: $('#ticks'),
  timelineHint: $('#timeline-hint'),
  replayPanel: $('#replay-panel'), replayBanner: $('#replay-banner'),
  replayGroups: $('#replay-groups'), replayPos: $('#replay-pos'),
  livePanel: $('#live-panel'), liveWindows: $('#live-windows'), liveHint: $('#live-hint'),
  form: $('#append-form'),
};

const STORE = {
  get collapsed() { try { return new Set(JSON.parse(localStorage.getItem('ewr:collapsed') ?? '[]')); } catch { return new Set(); } },
  set collapsed(set) { localStorage.setItem('ewr:collapsed', JSON.stringify([...set])); },
};

const state = {
  live: null,                    // {windows, versions, cursors}
  mode: 'live',                  // 'live' | 'replay'
  selectedWindow: localStorage.getItem('ewr:window') ?? '',
  selectedEventId: localStorage.getItem('ewr:event') ?? '',
  collapsed: STORE.collapsed,
  replay: null,                  // {window, version, view}
  cursorId: null,                // when entered through a saved cursor
  invalidCursor: null,           // {id, error}
  dragging: false,
  dragVersion: null,
  flashIds: new Set(),
};

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || response.statusText), {status: response.status});
  return body;
}

function post(path, body) {
  return api(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
}

const scrollMemory = new Map();
function saveScroll() {
  document.querySelectorAll('[data-scrollkey]').forEach(node => {
    if (node.scrollTop) scrollMemory.set(node.dataset.scrollkey, node.scrollTop);
  });
}
function restoreScroll() {
  document.querySelectorAll('[data-scrollkey]').forEach(node => {
    const top = scrollMemory.get(node.dataset.scrollkey);
    if (top != null) node.scrollTop = top;
  });
}
function persist() {
  STORE.collapsed = state.collapsed;
  if (state.selectedWindow) localStorage.setItem('ewr:window', state.selectedWindow);
  if (state.selectedEventId) localStorage.setItem('ewr:event', state.selectedEventId);
}
function hashFor() {
  const params = new URLSearchParams();
  if (state.selectedWindow) params.set('w', state.selectedWindow);
  if (state.mode === 'replay' && state.replay) params.set('v', String(state.replay.version));
  if (state.cursorId) params.set('c', String(state.cursorId));
  if (state.selectedEventId) params.set('e', state.selectedEventId);
  const qs = params.toString();
  return qs ? `#${qs}` : '#';
}
function syncHash(replace = false) {
  persist();
  if (replace) history.replaceState(null, '', hashFor());
  else history.pushState(null, '', hashFor());
}

window.addEventListener('popstate', () => routeFromHash(true));

async function routeFromHash(initial = false) {
  const params = new URLSearchParams(location.hash.slice(1));
  const window = params.get('w') ?? '';
  const version = params.get('v') != null ? Number(params.get('v')) : null;
  state.selectedEventId = params.get('e') ?? state.selectedEventId;
  if (window) state.selectedWindow = window;
  const cursorId = params.get('c');
  if (cursorId) {
    try {
      const cursor = await api(`/api/cursors/${encodeURIComponent(cursorId)}`);
      state.selectedWindow = cursor.window;
      await enterReplay(cursor.window, cursor.version, Number(cursorId), false);
      return;
    } catch (error) {
      state.mode = 'replay';
      state.replay = null;
      state.cursorId = Number(cursorId);
      state.invalidCursor = {id: cursorId, error: error.message};
      render();
      return;
    }
  }
  state.cursorId = null;
  state.invalidCursor = null;
  if (window && version != null) {
    await enterReplay(window, version, null, false);
  } else {
    state.mode = 'live';
    state.replay = null;
    render();
  }
}

function windowVersionsOf(live, window) {
  return (live?.versions ?? []).filter(item => item.window === window);
}

async function enterReplay(window, version, cursorId = null, navigate = true) {
  state.mode = 'replay';
  state.cursorId = cursorId;
  state.invalidCursor = null;
  try {
    const view = await api(`/api/replay?window=${encodeURIComponent(window)}&version=${version}`);
    state.selectedWindow = window;
    state.replay = {window, version, view};
    state.dragVersion = null;
    render();
    if (navigate) syncHash();
    scrollSelectedIntoView();
  } catch (error) {
    // Version disappeared or window mismatch: cursor is unusable.
    state.replay = null;
    state.invalidCursor = {id: cursorId, error: error.message};
    render();
  }
}

function backToLive() {
  state.mode = 'live';
  state.replay = null;
  state.cursorId = null;
  state.invalidCursor = null;
  state.dragVersion = null;
  render();
  syncHash();
}

function eventRow(event, {scope, late = false, lateLabel = '迟到'}) {
  const selected = event.id === state.selectedEventId;
  const flash = state.flashIds.has(event.id);
  setTimeout(() => state.flashIds.delete(event.id), 1500);
  return h('div', {
    class: `row${selected ? ' selected' : ''}${flash ? ' flash' : ''}`,
    dataset: {eventId: event.id},
    onclick: () => {
      state.selectedEventId = event.id;
      persist();
      syncHash();
      render();
    },
  },
    h('span', {class: 'id'}, event.id),
    h('span', {class: 'muted'}, `t=${event.eventTime}`),
    Number.isFinite(event.value) ? h('span', {}, `值=${event.value}`) : null,
    late ? h('span', {class: `tag ${scope === 'replay' ? 'late' : 'late'}`}, lateLabel) : null,
  );
}

function bucketGroup(scope, name, title, payload, {lateAll = false, label = '迟到'} = {}) {
  const key = `${scope}:${name}`;
  const collapsed = state.collapsed.has(key);
  const summary = h('summary', {}, `${title}（${payload.aggregate.count} 项，合计 ${payload.aggregate.sum}）`);
  const body = h('div', {class: 'events', dataset: {scrollkey: key}},
    ...payload.events.map(event => eventRow(event, {scope, late: lateAll || Boolean(event.late), lateLabel: label})),
    payload.events.length === 0 ? h('span', {class: 'muted'}, '空') : null,
  );
  return h('details', {class: `group ${name}`, open: !collapsed, ontoggle(event) {
    if (event.target.open) state.collapsed.delete(key); else state.collapsed.add(key);
    persist();
  }}, summary, body);
}

function renderTabs(live) {
  const names = live.windows.map(item => item.window);
  if (names.length && !names.includes(state.selectedWindow)) state.selectedWindow = names[0];
  els.tabs.replaceChildren(...names.map(name => h('button', {
    class: `tab${name === state.selectedWindow ? ' active' : ''}`,
    onclick: () => { state.selectedWindow = name; state.mode = 'live'; state.replay = null; state.cursorId = null; render(); syncHash(); },
  }, name)));
  const current = live.windows.find(item => item.window === state.selectedWindow);
  els.windowStatus.textContent = current
    ? `状态：${statusText(current.status)}｜头部版本 v${current.headVersion}｜已确认合计 ${current.committed?.aggregate.sum ?? 0}｜等待 ${current.waiting.length}`
    : '';
  els.commit.disabled = !current || current.status === 'confirmed' || current.status === 'uncommitted' && current.events.length === 0;
}

function statusText(status) {
  return {uncommitted: '未提交', confirmed: '已确认', recalculated: '已重算（有迟到数据）'}[status] ?? status;
}

function renderTimeline() {
  const versions = windowVersionsOf(state.live, state.selectedWindow);
  const selectedVersion = state.dragging && state.dragVersion != null
    ? state.dragVersion
    : state.mode === 'replay' && state.replay ? state.replay.version
    : versions.at(-1)?.version;
  const index = Math.max(0, versions.findIndex(item => item.version === selectedVersion));
  els.timeline.disabled = versions.length === 0;
  els.timeline.min = 0;
  els.timeline.max = Math.max(0, versions.length - 1);
  els.timeline.value = index;
  els.ticks.replaceChildren(...versions.map(item => h('span', {
    class: ['tick', item.committed ? 'commit' : '', item.superseded ? 'superseded' : '', item.late ? 'late' : '',
      item.version === selectedVersion ? 'current' : ''].filter(Boolean).join(' '),
    title: item.committed ? `提交 #${item.commitId}${item.superseded ? '（已被迟到事件取代）' : ''}` : (item.late ? '迟到事件产生的重算版本' : '写入版本'),
  }, `v${item.version}${item.committed ? ' ✓提交' : ''}`)));
  const head = versions.at(-1);
  els.timelineHint.textContent = versions.length
    ? (state.mode === 'replay'
        ? `停在 v${selectedVersion}（共 ${versions.length} 个版本，头部 v${head.version}）`
        : `拖动可回到任意版本；头部 v${head.version}`)
    : '写入事件后出现版本';
}

function renderReplay() {
  if (state.mode !== 'replay') { els.replayPanel.hidden = true; return; }
  els.replayPanel.hidden = false;

  if (state.invalidCursor) {
    els.replayPos.textContent = '';
    els.replayBanner.replaceChildren(h('div', {class: 'banner invalid'},
      `游标 ${state.invalidCursor.id} 已失效：${state.invalidCursor.error}。历史无法定位，已停止回放，当前实时结果未被改动。`,
      h('button', {class: 'primary', style: 'margin-left:10px', onclick: backToLive}, '回到实时')));
    els.replayGroups.replaceChildren();
    return;
  }
  const {window, version, view} = state.replay;
  els.replayPos.textContent = `${window} · v${version}${view.committed ? ` · 已提交${view.commitTime ? ' @' + new Date(view.commitTime).toLocaleTimeString() : ''}` : ' · 提交前'}`;

  const banners = [];
  if (view.stale) {
    banners.push(h('div', {class: 'banner stale'},
      `v${version} 的提交结果已被后来到达的事件重算（实时头部 v${view.headVersion}）。你看到的是该时刻的历史快照，保存或回放都不会用它覆盖当前状态。`));
  } else if (view.behind) {
    banners.push(h('div', {class: 'banner info'},
      `这是历史位置，实时视图已经推进到 v${view.headVersion}；“后来才到达”里能看到之后写入的事件。`));
  }
  els.replayBanner.replaceChildren(...banners);

  els.replayGroups.replaceChildren(
    bucketGroup('replay', 'confirmed', '当时已确认', view.confirmed),
    bucketGroup('replay', 'waiting', '仍在等待提交', view.waiting),
    bucketGroup('replay', 'later', '后来才到达（含迟到事件）', view.later, {lateAll: true, label: '后来到达'}),
  );
}

function renderLive() {
  const windows = state.live.windows;
  els.liveHint.textContent = state.mode === 'replay'
    ? '回放中仍持续轮询实时数据；回到实时不会丢失期间写入的事件。'
    : '当前数据库的实时聚合结果。';
  if (!windows.length) {
    els.liveWindows.replaceChildren(h('span', {class: 'muted'}, '暂无事件，先在下方写入。'));
    return;
  }
  const summarize = events => ({count: events.length, sum: events.reduce((s, e) => s + (Number.isFinite(e.value) ? Number(e.value) : 0), 0)});
  els.liveWindows.replaceChildren(...windows.map(item => {
    const recalc = item.status === 'recalculated';
    return h('div', {class: 'group', style: 'border:none; padding:0'},
      h('h2', {style: 'margin:6px 0 2px'}, item.window, ' ',
        h('span', {class: `tag ${item.status === 'confirmed' ? 'ok' : 'recalc'}`}, statusText(item.status)),
        h('span', {class: 'muted'}, `v${item.headVersion} · 当前合计 ${item.aggregate.sum}`)),
      bucketGroup('live', `${item.window}:confirmed`, '已确认', {events: item.confirmed, aggregate: summarize(item.confirmed)}),
      bucketGroup('live', `${item.window}:waiting`, recalc ? '迟到 / 等待重新提交' : '等待提交',
        {events: item.waiting, aggregate: summarize(item.waiting)}, {lateAll: recalc && item.waiting.length > 0}),
    );
  }));
}

function renderCursors() {
  const current = state.cursorId;
  els.cursorList.replaceChildren(
    h('option', {value: ''}, '恢复游标…'),
    ...state.live.cursors.map(cursor => h('option', {
      value: cursor.id,
      selected: cursor.id === current,
      title: cursor.stale ? '该游标版本已被迟到事件重算（只读历史）' : '',
    }, `${cursor.name} · ${cursor.window} v${cursor.version}${cursor.stale ? '（已过期）' : cursor.behind ? '（历史）' : ''}`)),
  );
}

function render() {
  if (!state.live) return;
  saveScroll();
  const inReplay = state.mode === 'replay';
  els.mode.textContent = state.invalidCursor ? '游标失效' : inReplay ? '回放' : '实时';
  els.mode.className = `badge ${state.invalidCursor ? 'invalid' : inReplay ? (state.replay?.view.stale ? 'stale' : 'replay') : 'live'}`;
  renderTabs(state.live);
  renderTimeline();
  renderReplay();
  renderLive();
  renderCursors();
  els.backLive.disabled = !inReplay;
  restoreScroll();
}

function scrollSelectedIntoView() {
  if (!state.selectedEventId) return;
  requestAnimationFrame(() => {
    const target = document.querySelector(`[data-event-id="${CSS.escape(state.selectedEventId)}"]`);
    if (target) {
      target.closest('details')?.setAttribute('open', '');
      target.scrollIntoView({block: 'nearest', behavior: 'smooth'});
    }
  });
}

// ---- live polling -------------------------------------------------------

async function pollLive() {
  try {
    const live = await api('/api/windows');
    const prev = state.live;
    if (prev) {
      const known = new Set(prev.windows.flatMap(item => item.events.map(e => e.id)));
      for (const item of live.windows) {
        for (const event of item.events) {
          if (!known.has(event.id)) { state.flashIds.add(event.id); setTimeout(() => { state.flashIds.delete(event.id); render(); }, 1500); }
        }
      }
      // Replay view's "later" bucket and timeline keep growing with live data.
      if (state.mode === 'replay' && state.replay && !state.dragging && !state.invalidCursor) {
        const prevCount = prev.versions.filter(v => v.window === state.replay.window).length;
        const nextCount = live.versions.filter(v => v.window === state.replay.window).length;
        if (nextCount !== prevCount) {
          state.replay.view = await api(`/api/replay?window=${encodeURIComponent(state.replay.window)}&version=${state.replay.version}`);
        }
      }
    }
    state.live = live;
    render();
  } catch {
    // transient poll failure: keep last rendered view
  }
}

// ---- controls ------------------------------------------------------------

els.timeline.addEventListener('pointerdown', () => { state.dragging = true; });
els.timeline.addEventListener('input', () => {
  const versions = windowVersionsOf(state.live, state.selectedWindow);
  const picked = versions[Number(els.timeline.value)];
  if (!picked) return;
  state.dragVersion = picked.version;
  state.timelineHint && (els.timelineHint.textContent = `松手查看 v${picked.version}…`);
});
els.timeline.addEventListener('change', async () => {
  const versions = windowVersionsOf(state.live, state.selectedWindow);
  const picked = versions[Number(els.timeline.value)];
  state.dragging = false;
  if (!picked) return;
  await enterReplay(state.selectedWindow, picked.version);
});

els.backLive.addEventListener('click', backToLive);

els.commit.addEventListener('click', async () => {
  if (!state.selectedWindow) return;
  await post(`/api/windows/${encodeURIComponent(state.selectedWindow)}/commit`, {});
  await pollLive();
});

els.saveCursor.addEventListener('click', async () => {
  const versions = windowVersionsOf(state.live, state.selectedWindow);
  if (!versions.length) return;
  const version = state.mode === 'replay' && state.replay ? state.replay.version : versions.at(-1).version;
  const name = prompt('为游标命名（绑定当前窗口与版本）', `游标 ${state.selectedWindow} v${version}`);
  if (!name) return;
  const cursor = await post('/api/cursors', {name, window: state.selectedWindow, version});
  await pollLive();
  await enterReplay(cursor.window, cursor.version, cursor.id);
});

els.cursorList.addEventListener('change', async () => {
  const id = els.cursorList.value;
  els.cursorList.value = '';
  if (!id) return;
  const cursor = await api(`/api/cursors/${id}`);
  state.selectedWindow = cursor.window;
  await enterReplay(cursor.window, cursor.version, cursor.id);
});

els.form.addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(els.form);
  const id = String(form.get('id') || '').trim() || `e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const payload = {
    id,
    window: String(form.get('window') || state.selectedWindow || 'default'),
    eventTime: Number(form.get('eventTime')),
  };
  const value = Number(form.get('value'));
  if (Number.isFinite(value)) payload.value = value;
  await post('/api/events', payload);
  els.form.reset();
  state.selectedWindow = payload.window;
  state.flashIds.add(id);
  await pollLive();
});

// ---- boot ----------------------------------------------------------------

await pollLive();
await routeFromHash(true);
syncHash(true);
setInterval(pollLive, 2000);
