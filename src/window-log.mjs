// Pure event-window log.
//
// State is append-only and immutable: every mutating export returns a fresh
// state object. A *version* is created whenever an event is appended to a
// window; a *commit* marks one version as the confirmed watermark for that
// window. Events appended after the latest commit are late arrivals: the
// committed version is flagged `superseded` and the window moves into a
// recalculated state until it is committed again. Cursors bind a window to a
// version and can always read history, but they never mutate the live state.

export function createWindowLog() {
  return {events: [], versions: [], cursors: [], nextVersion: 1, nextCommitSeq: 1, nextCursorId: 1};
}

function copy(value) { return structuredClone(value); }

function arrivedAtFrom(event) {
  return Number.isFinite(event.arrivedAt) ? Number(event.arrivedAt) : Date.now();
}

function windowVersions(state, window) {
  return state.versions.filter(item => item.window === window);
}

function lastCommitted(versions) {
  for (let index = versions.length - 1; index >= 0; index -= 1) {
    if (versions[index].committed) return versions[index];
  }
  return null;
}

function aggregate(events) {
  let sum = 0;
  for (const event of events) if (Number.isFinite(event.value)) sum += Number(event.value);
  return {count: events.length, sum};
}

function eventsForWindow(state, window) {
  return state.events.filter(item => item.window === window);
}

export function appendEvent(state, event) {
  if (!event || !event.id || !event.window || !Number.isFinite(event.eventTime)) {
    throw new Error('event requires id, window and eventTime');
  }
  if (state.events.some(item => item.id === event.id)) return copy(state);
  const next = copy(state);
  const stored = {...event, eventTime: Number(event.eventTime), arrivedAt: arrivedAtFrom(event)};
  next.events.push(stored);
  next.events.sort((a, b) => a.eventTime - b.eventTime || a.id.localeCompare(b.id));

  // The append is late when the window already has a live commit. Marking the
  // commit superseded is what keeps an old cursor readable but stale.
  const versions = windowVersions(next, stored.window);
  const commit = lastCommitted(versions);
  const late = Boolean(commit && !commit.superseded);
  if (commit && late) commit.superseded = true;

  const version = next.nextVersion++;
  next.versions.push({
    version,
    window: stored.window,
    reason: 'append',
    eventIds: eventsForWindow(next, stored.window).map(item => item.id),
    arrivedAt: stored.arrivedAt,
    late,
    committed: false,
    superseded: false,
  });
  return next;
}

export function commitWindow(state, window, at = Date.now()) {
  const versions = windowVersions(state, window);
  if (versions.length === 0) throw new Error('unknown window');
  const head = versions[versions.length - 1];
  if (head.committed) return copy(state); // nothing new to confirm
  const next = copy(state);
  const target = next.versions.find(item => item.version === head.version);
  target.committed = true;
  target.commitId = next.nextCommitSeq++;
  target.commitTime = Number.isFinite(at) ? Number(at) : Date.now();
  return next;
}

export function saveCursor(state, input, at = Date.now()) {
  if (!input || !input.name || !input.window || !Number.isInteger(input.version)) {
    throw new Error('cursor requires name, window and version');
  }
  const owner = state.versions.find(item => item.version === input.version);
  if (!owner) throw new Error('unknown window version');
  if (owner.window !== input.window) throw new Error('cursor does not match window');
  const next = copy(state);
  const id = next.nextCursorId++;
  const cursor = {
    id,
    name: String(input.name),
    window: input.window,
    version: input.version,
    createdAt: Number.isFinite(at) ? Number(at) : Date.now(),
    note: input.note ? String(input.note) : '',
  };
  next.cursors.push(cursor);
  return {state: next, cursor};
}

// Replay a cursor record loaded from the durable log without minting a new id.
export function ingestCursor(state, record) {
  if (!record || !Number.isInteger(record.id) || !record.name || !record.window || !Number.isInteger(record.version)) {
    throw new Error('cursor requires id, name, window and version');
  }
  if (state.cursors.some(item => item.id === record.id)) return copy(state);
  const owner = state.versions.find(item => item.version === record.version);
  if (!owner) throw new Error('unknown window version');
  if (owner.window !== record.window) throw new Error('cursor does not match window');
  const next = copy(state);
  next.cursors.push({...record});
  next.cursors.sort((a, b) => a.id - b.id);
  next.nextCursorId = Math.max(next.nextCursorId, record.id + 1);
  return next;
}

function versionView(state, found) {
  const ids = new Set(found.eventIds);
  const events = state.events.filter(item => ids.has(item.id));
  return {
    version: found.version,
    window: found.window,
    reason: found.reason,
    committed: found.committed,
    commitId: found.commitId ?? null,
    commitTime: found.commitTime ?? null,
    late: Boolean(found.late),
    superseded: Boolean(found.superseded),
    events,
    aggregate: aggregate(events),
  };
}

export function readVersion(state, version) {
  const found = state.versions.find(item => item.version === version);
  if (!found) throw new Error('unknown window version');
  return versionView(state, found);
}

// Split the window as it would have looked at `version`:
//   confirmed - events locked by the commit watermark at that point
//   waiting   - events present at that point but not yet committed
//   later     - events that only arrived after this version (incl. late ones)
export function replayView(state, window, version) {
  const ver = state.versions.find(item => item.version === version);
  if (!ver) throw new Error('unknown window version');
  if (ver.window !== window) throw new Error('cursor does not match window');
  const versions = windowVersions(state, window);
  const atIds = new Set(ver.eventIds);
  const base = ver.committed ? ver : lastCommitted(versions.filter(item => item.version < version));
  const confirmedIds = new Set(base ? base.eventIds : []);
  const current = eventsForWindow(state, window);
  const confirmed = current.filter(item => confirmedIds.has(item.id));
  const waiting = current.filter(item => atIds.has(item.id) && !confirmedIds.has(item.id));
  const later = current.filter(item => !atIds.has(item.id));
  const head = versions[versions.length - 1];
  const stale = Boolean(ver.superseded || versions.some(item => item.committed && item.version > version));
  return {
    window,
    version,
    committed: ver.committed,
    commitTime: ver.commitTime ?? null,
    headVersion: head.version,
    behind: version < head.version,
    stale,
    confirmed: {events: confirmed, aggregate: aggregate(confirmed)},
    waiting: {events: waiting, aggregate: aggregate(waiting)},
    later: {events: later, aggregate: aggregate(later)},
    timeline: versions.map(item => ({
      version: item.version,
      committed: item.committed,
      superseded: Boolean(item.superseded),
      late: Boolean(item.late),
      commitTime: item.commitTime ?? null,
    })),
  };
}

function describeWindow(state, window) {
  const versions = windowVersions(state, window);
  const events = eventsForWindow(state, window);
  const head = versions[versions.length - 1];
  const commit = lastCommitted(versions);
  const confirmedIds = new Set(commit ? commit.eventIds : []);
  const confirmed = events.filter(item => confirmedIds.has(item.id));
  const waiting = events.filter(item => !confirmedIds.has(item.id));
  const status = !commit ? 'uncommitted' : waiting.length > 0 ? 'recalculated' : 'confirmed';
  return {
    window,
    status,
    headVersion: head.version,
    versions: versions.map(item => item.version),
    committed: commit ? {
      version: commit.version,
      commitId: commit.commitId,
      commitTime: commit.commitTime,
      superseded: Boolean(commit.superseded),
      aggregate: aggregate(confirmed),
    } : null,
    confirmed,
    waiting,
    events,
    aggregate: aggregate(events),
  };
}

export function currentWindows(state) {
  return [...new Set(state.events.map(item => item.window))].map(window => describeWindow(state, window));
}

export function cursorView(state, cursor) {
  const view = replayView(state, cursor.window, cursor.version);
  return {
    ...cursor,
    committed: view.committed,
    headVersion: view.headVersion,
    behind: view.behind,
    stale: view.stale,
  };
}

export function listCursors(state) {
  return state.cursors.map(cursor => cursorView(state, cursor));
}

export function getCursor(state, id) {
  const cursor = state.cursors.find(item => item.id === id);
  if (!cursor) throw new Error('unknown cursor');
  return cursorView(state, cursor);
}
