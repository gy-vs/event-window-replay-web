// Browser state: the live timeline comes from the server; replay views are
// always computed by the server (viewAt) so we never replay by re-rendering
// the current database values.

const $ = sel => document.querySelector(sel);
const els = {
  body: document.body,
  headSeq: $('#head-seq'),
  badge: $('#mode-badge'),
  backLive: $('#back-live'),
  newEventsNote: $('#new-events-note'),
  liveWindows: $('#live-windows'),
  windowSelect: $('#window-select'),
  anchorInfo: $('#anchor-info'),
  replayBanner: $('#replay-banner'),
  staleBanner: $('#stale-banner'),
  scrub: $('#scrub'),
  ticks: $('#ticks'),
  replayView: $('#replay-view'),
  cursorLabel: $('#cursor-label'),
  saveCursor: $('#save-cursor'),
  cursorList: $('#cursor-list'),
};

// Persistent across version switches:
const ui = {
  collapsed: new Set(),         // window names
  selectedEvent: null,          // event id
  replayWindow: null,
  replayAtSeq: null,
  replaySeqBase: null,          // live seq when replay was entered
  mode: 'live',
  live: null,                   // {windows, versions}
  timeline: null,               // timelineView payload
};

async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status}: ${(await res.json().catch(() => ({}))).error || res.statusText}`);
  return res.json();
}
async function send(method, path, body) {
  const res = await fetch(path, {method, headers: {'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), {status: res.status, code: data.code});
  return data;
}

// ---------- live pane ----------
function tag(text, cls) { const s = document.createElement('span'); s.className = `tag ${cls}`; s.textContent = text; return s; }

function renderEventRow(event, extraClass) {
  const li = document.createElement('li');
  li.className = `event-row ${extraClass || ''}`;
  if (event.id === ui.selectedEvent) li.classList.add('selected');
  li.dataset.eventId = event.id;
  li.textContent = `${event.eventTime} · ${event.id}${event.value != null ? ' = ' + event.value : ''}`;
  if (event.late) li.append(tag('迟到', 'late'));
  return li;
}

function renderLive() {
  if (!ui.live) return;
  els.headSeq.textContent = ui.timeline ? `序列 ${ui.timeline.seq}` : '';
  els.liveWindows.innerHTML = '';
  if (ui.live.windows.length === 0) {
    els.liveWindows.innerHTML = '<span class="muted">尚无窗口，先写入事件。</span>';
    return;
  }
  for (const w of ui.live.windows) {
    const wrap = document.createElement('div');
    wrap.className = 'window';
    const head = document.createElement('div');
    head.className = 'window-head';
    const name = document.createElement('span');
    name.className = 'window-name';
    name.textContent = w.window;
    head.append(name, tag(w.status === 'closed' ? '已提交' : '等待中', w.status));
    if (w.lastCommittedVersion != null) head.append(tag(`v${w.lastCommittedVersion}`, 'v'));
    const spacer = document.createElement('span'); spacer.className = 'spacer'; head.append(spacer);
    const toggle = document.createElement('button');
    toggle.textContent = ui.collapsed.has(w.window) ? '展开' : '折叠';
    toggle.addEventListener('click', () => {
      ui.collapsed.has(w.window) ? ui.collapsed.delete(w.window) : ui.collapsed.add(w.window);
      renderAll();
    });
    head.append(toggle);
    wrap.append(head);
    if (!ui.collapsed.has(w.window)) {
      const ul = document.createElement('ul');
      ul.className = 'events';
      for (const event of [...w.events].sort((a, b) => a.eventTime - b.eventTime || a.id.localeCompare(b.id))) {
        ul.append(renderEventRow(event, event.late ? 'late' : ''));
      }
      wrap.append(ul);
    }
    els.liveWindows.append(wrap);
  }
}

// ---------- replay pane ----------
function windowVersionHistory(windowName) {
  return ui.timeline.versions.filter(v => v.window === windowName).sort((a, b) => a.version - b.version);
}

function renderWindowOptions() {
  const names = ui.timeline.windows.map(w => w.window);
  if (ui.replayWindow == null || !names.includes(ui.replayWindow)) ui.replayWindow = names[0] ?? null;
  const prev = ui.replayWindow;
  els.windowSelect.innerHTML = '';
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    els.windowSelect.append(opt);
  }
  els.windowSelect.value = ui.replayWindow ?? '';
  if (prev !== ui.replayWindow) ui.replayAtSeq = null;
}

// The anchor version is the version the current scrub position would bind a
// saved cursor to: the newest commit at/before the position, or — for a
// pre-commit position — that commit itself.
function anchorVersionFor(windowName, atSeq) {
  const hist = windowVersionHistory(windowName);
  const at = [...hist].reverse().find(v => v.seq <= atSeq);
  if (at) return at;
  return hist.find(v => atSeq < v.seq) ?? null; // before the first commit
}

function renderScrubber() {
  const name = ui.replayWindow;
  const max = ui.timeline.seq;
  els.scrub.max = String(max);
  if (ui.replayAtSeq == null || ui.replayAtSeq > max) ui.replayAtSeq = max;
  els.scrub.value = String(ui.replayAtSeq);

  els.ticks.innerHTML = '';
  const occ = ui.timeline.occurrences.filter(o => o.window === name);
  for (const o of occ) {
    const t = document.createElement('span');
    const left = max ? (o.seq / max) * 100 : 0;
    t.style.left = `${left}%`;
    t.className = `tick ${o.kind}`;
    if (o.kind === 'event') {
      t.textContent = o.id;
      if (o.id === ui.selectedEvent) t.classList.add('flagged');
    } else {
      t.textContent = `v${o.version}${o.kind === 'recompute' ? '↻' : '✓'}`;
    }
    t.title = `${o.kind} @seq ${o.seq}`;
    t.addEventListener('click', () => { ui.replayAtSeq = o.seq; enterReplay(); });
    els.ticks.append(t);
  }

  const anchor = name == null ? null : anchorVersionFor(name, ui.replayAtSeq);
  els.anchorInfo.textContent = anchor
    ? `锚定 ${anchor.kind === 'recompute' ? '重算' : '提交'} v${anchor.version}（提交于序列 ${anchor.seq}，提交前为 ${anchor.seq - 1}）`
    : '该窗口尚无版本';
  els.saveCursor.disabled = anchor == null;
}

function groupList(labelText, events, cls) {
  if (!events.length) return null;
  const frag = document.createDocumentFragment();
  const label = document.createElement('div');
  label.className = 'group-label';
  label.textContent = `${labelText}（${events.length}）`;
  frag.append(label);
  const ul = document.createElement('ul');
  ul.className = 'events';
  for (const e of events) ul.append(renderEventRow(e, cls));
  frag.append(ul);
  return frag;
}

async function renderReplay() {
  renderScrubber();
  const name = ui.replayWindow;
  if (name == null) {
    els.replayView.innerHTML = '<span class="muted">尚无窗口可回放。</span>';
    return;
  }
  const view = await getJson(`/api/views?window=${encodeURIComponent(name)}&atSeq=${ui.replayAtSeq}`);
  const sum = list => list.filter(e => Number.isFinite(e.value)).reduce((a, e) => a + e.value, 0);
  els.replayView.innerHTML = '';

  const meta = document.createElement('div');
  meta.className = 'muted';
  meta.style.margin = '4px 0 8px';
  meta.textContent = `回放位置 序列 ${view.atSeq} / 当前 ${view.currentSeq} · ` +
    `${view.committedVersion != null ? `${view.committedKind === 'recompute' ? '重算' : '提交'}版本 v${view.committedVersion}` : '尚未提交'} · ` +
    `窗口当时${view.status === 'closed' ? '已关闭' : '开启'} · 确认值合计 ${sum(view.confirmed)}`;
  els.replayView.append(meta);

  els.replayView.append(groupList('当时已确认（版本快照）', view.confirmed, '') ?? document.createTextNode(''));
  els.replayView.append(groupList('仍在等待（已到达未提交）', view.waiting, 'waiting') ?? document.createTextNode(''));
  els.replayView.append(groupList('后来才到达（历史中不可见）', view.later, 'later') ?? document.createTextNode(''));
  if (!view.confirmed.length && !view.waiting.length && !view.later.length) {
    els.replayView.append(spanMuted('该位置窗口尚无事件。'));
  }
}

function spanMuted(text) { const s = document.createElement('span'); s.className = 'muted'; s.textContent = text; return s; }

// ---------- mode switching ----------
async function enterReplay({keepStaleBanner = false} = {}) {
  ui.mode = 'replay';
  ui.replaySeqBase = ui.timeline.seq;
  if (!keepStaleBanner) els.staleBanner.classList.add('hidden');
  await refreshReplayOnly();
}
async function backToLive() {
  ui.mode = 'live';
  ui.replaySeqBase = null;
  await refreshAll();
}

function applyModeChrome() {
  const isReplay = ui.mode === 'replay';
  els.body.className = isReplay ? 'replay' : 'live';
  els.badge.textContent = isReplay ? `回放中 · ${ui.replayWindow} @ ${ui.replayAtSeq}` : '实时';
  els.backLive.classList.toggle('hidden', !isReplay);
  if (isReplay && ui.timeline && ui.replaySeqBase != null && ui.timeline.seq > ui.replaySeqBase) {
    els.newEventsNote.textContent = `回放期间有新写入（序列 ${ui.replaySeqBase} → ${ui.timeline.seq}），返回实时视图查看`;
    els.newEventsNote.classList.remove('hidden');
  } else {
    els.newEventsNote.classList.add('hidden');
  }
}

async function refreshReplayOnly() {
  // Live data keeps flowing into the left pane during replay (so new arrivals
  // are never lost), while the right pane stays pinned to the historical view.
  await refreshTimeline();
  ui.live = await getJson('/api/windows');
  renderWindowOptions();
  renderLive();
  await renderReplay();
  applyModeChrome();
  renderCursors();
}

async function refreshAll() {
  const [w] = await Promise.all([getJson('/api/windows'), refreshTimeline()]);
  ui.live = w;
  renderWindowOptions();
  renderLive();
  await renderReplay();
  applyModeChrome();
  renderCursors();
}

async function refreshTimeline() {
  const prevSeq = ui.timeline?.seq ?? null;
  ui.timeline = await getJson('/api/timeline');
  // While in replay, new arrivals must not silently move the scrubber.
  if (ui.mode === 'replay' && prevSeq != null && ui.timeline.seq > prevSeq) {
    ui.replayAtSeq = Math.min(ui.replayAtSeq ?? prevSeq, ui.timeline.seq);
  }
  if (ui.mode === 'live') ui.replayAtSeq = ui.timeline.seq;
}

// ---------- saved cursors ----------
async function saveCurrentCursor() {
  const anchor = anchorVersionFor(ui.replayWindow, ui.replayAtSeq);
  if (!anchor) return;
  try {
    await send('POST', '/api/cursors', {version: anchor.version, atSeq: ui.replayAtSeq, label: els.cursorLabel.value});
    els.cursorLabel.value = '';
    await renderCursors();
  } catch (err) { alert(err.message); }
}

async function renderCursors() {
  const data = await getJson('/api/cursors');
  els.cursorList.innerHTML = '';
  if (data.cursors.length === 0) {
    els.cursorList.append(spanMuted('暂无游标'));
    return;
  }
  for (const c of data.cursors) {
    const item = document.createElement('div');
    item.className = `cursor-item${c.boundStale ? ' stale' : ''}`;
    const label = document.createElement('strong');
    label.textContent = c.label;
    item.append(label, tag(`${c.window} v${c.version} @ ${c.atSeq}`, 'v'));
    if (c.boundStale) item.append(tag('已被重算', 'stale'));
    const spacer = document.createElement('span'); spacer.className = 'spacer'; item.append(spacer);

    const restore = document.createElement('button');
    restore.textContent = c.boundStale ? '读取历史' : '恢复回放';
    restore.addEventListener('click', () => restoreCursor(c.id, c.boundStale));
    item.append(restore);

    const del = document.createElement('button');
    del.textContent = '删除';
    del.addEventListener('click', async () => { await send('DELETE', `/api/cursors/${c.id}`); renderCursors(); });
    item.append(del);
    els.cursorList.append(item);
  }
}

async function restoreCursor(id, expectStale) {
  try {
    const data = await send('POST', `/api/cursors/${id}/restore`);
    ui.replayWindow = data.cursor.window;
    ui.replayAtSeq = data.cursor.atSeq;
    await enterReplay();
    els.staleBanner.classList.add('hidden');
  } catch (err) {
    if (err.status === 409 && expectStale) {
      // Old cursor: history is still readable, but it must never drive/overwrite
      // the current view. Pin the panes to its position with an explicit notice.
      const detail = await getJson(`/api/cursors/${id}`);
      ui.replayWindow = detail.cursor.window;
      ui.replayAtSeq = detail.cursor.atSeq;
      els.staleBanner.textContent =
        `游标绑定的 v${detail.cursor.version} 已被重算（当前 v${detail.view.latestVersion}）：仅作历史读取，不能覆盖当前状态。`;
      els.staleBanner.classList.remove('hidden');
      await enterReplay({keepStaleBanner: true});
    } else {
      alert(err.message);
    }
  }
}

// ---------- wiring ----------
function renderAll() {
  renderWindowOptions();
  renderLive();
  renderReplay().then(applyModeChrome);
}

els.windowSelect.addEventListener('change', async () => {
  ui.replayWindow = els.windowSelect.value || null;
  ui.replayAtSeq = ui.timeline.seq;
  await enterReplay();
});
els.scrub.addEventListener('input', () => {
  ui.replayAtSeq = Number(els.scrub.value);
  renderReplay().then(applyModeChrome);
});
els.backLive.addEventListener('click', backToLive);
els.saveCursor.addEventListener('click', saveCurrentCursor);

// Event selection and window collapse survive version switches: events live in
// the same DOM ids in both panes, handled with one delegated listener.
document.addEventListener('click', event => {
  const row = event.target.closest('.event-row');
  if (!row) return;
  ui.selectedEvent = ui.selectedEvent === row.dataset.eventId ? null : row.dataset.eventId;
  for (const el of document.querySelectorAll('.event-row')) {
    el.classList.toggle('selected', el.dataset.eventId === ui.selectedEvent);
  }
});

async function poll() {
  try {
    if (ui.mode === 'live') await refreshAll();
    else await refreshReplayOnly();
  } catch (error) { /* transient; next tick retries */ }
}
setInterval(poll, 2000);
refreshAll().catch(error => { els.liveWindows.textContent = error.message; });
