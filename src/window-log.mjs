// Event window log with committable window versions and resumable replay cursors.
//
// State is immutable: every mutator returns a fresh copy. A monotonic sequence
// (`seq`) orders *arrivals and commits* so a cursor position can describe the
// exact moment before a window version was submitted.
//
//   event arrives -> window open (pending) --advanceWindow--> committed version
//   late event arrives for a closed window -> new "recompute" version, the old
//   one stays readable but is marked superseded.

export function createWindowLog() {
  return {events: [], windows: [], versions: [], cursors: [], seq: 0, nextVersion: 1, nextCursorId: 1};
}

export class WindowLogError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function copy(value) { return structuredClone(value); }

function findWindow(state, window) {
  return state.windows.find(item => item.window === window);
}

function windowEventsSorted(state, window) {
  return state.events
    .filter(item => item.window === window)
    .sort((a, b) => a.eventTime - b.eventTime || a.id.localeCompare(b.id));
}

function snapshotIds(state, window) {
  return windowEventsSorted(state, window).map(item => item.id);
}

function versionForWindow(state, window) {
  return state.versions.filter(item => item.window === window);
}

export function appendEvent(state, event) {
  if (!event || !event.id || !event.window || !Number.isFinite(event.eventTime)) {
    throw new WindowLogError('BAD_REQUEST', 'event requires id, window and eventTime');
  }
  // Duplicate delivery is idempotent and must not advance the sequence.
  if (state.events.some(item => item.id === event.id)) return copy(state);

  const next = copy(state);
  let win = findWindow(next, event.window);
  if (!win) {
    win = {window: event.window, status: 'open', lastCommittedVersion: null};
    next.windows.push(win);
  }

  next.seq += 1;
  const arrivedSeq = next.seq;
  const late = win.status === 'closed';
  next.events.push({...event, arrivedSeq, late});
  next.events.sort((a, b) => a.eventTime - b.eventTime || a.id.localeCompare(b.id));

  if (late) {
    // A late arrival recalculates the closed window. The recompute shares the
    // arrival's sequence tick (ordered arrival -> recompute in the timeline);
    // a cursor can still park just before both at arrivedSeq - 1.
    const basedOnVersion = win.lastCommittedVersion;
    const version = next.nextVersion++;
    next.versions.push({
      version,
      window: event.window,
      kind: 'recompute',
      seq: arrivedSeq,
      eventIds: snapshotIds(next, event.window),
      basedOnVersion,
    });
    for (const old of versionForWindow(next, event.window)) {
      if (old.version !== version && old.supersededBy == null) old.supersededBy = version;
    }
    win.lastCommittedVersion = version;
  }
  return next;
}

export function advanceWindow(state, input = {}) {
  const {window} = input;
  if (!window) throw new WindowLogError('BAD_REQUEST', 'window is required');
  const win = findWindow(state, window);
  if (!win) throw new WindowLogError('WINDOW_NOT_FOUND', `unknown window ${window}`);
  if (win.status === 'closed') throw new WindowLogError('WINDOW_CLOSED', `window ${window} is already committed`);

  const next = copy(state);
  const nextWin = findWindow(next, window);
  next.seq += 1;
  const version = next.nextVersion++;
  next.versions.push({
    version,
    window,
    kind: 'commit',
    seq: next.seq,
    eventIds: snapshotIds(next, window),
    basedOnVersion: null,
  });
  nextWin.status = 'closed';
  nextWin.lastCommittedVersion = version;
  return next;
}

export function readVersion(state, version) {
  const found = state.versions.find(item => item.version === version);
  if (!found) throw new WindowLogError('UNKNOWN_VERSION', 'unknown window version');
  const ids = new Set(found.eventIds);
  return {
    version: found.version,
    window: found.window,
    kind: found.kind,
    seq: found.seq,
    basedOnVersion: found.basedOnVersion,
    supersededBy: found.supersededBy ?? null,
    events: state.events.filter(item => ids.has(item.id)),
  };
}

export function currentWindows(state) {
  return [...new Set(state.events.map(item => item.window))].map(window => {
    const win = findWindow(state, window);
    return {
      window,
      status: win ? win.status : 'open',
      lastCommittedVersion: win ? win.lastCommittedVersion : null,
      events: state.events.filter(item => item.window === window),
    };
  });
}

// View of one window as it existed at a sequence position.
//  confirmed: frozen in the newest commit at or before the position
//  waiting:   arrived but not part of any committed version at the position
//  later:     only arrives after the position (rendered dimmed in replay)
export function viewAt(state, {window, atSeq} = {}) {
  if (!window) throw new WindowLogError('BAD_REQUEST', 'window is required');
  const win = findWindow(state, window);
  if (!win) throw new WindowLogError('WINDOW_NOT_FOUND', `unknown window ${window}`);
  if (!Number.isInteger(atSeq) || atSeq < 0 || atSeq > state.seq) {
    throw new WindowLogError('BAD_REQUEST', `atSeq must be between 0 and ${state.seq}`);
  }

  const committed = [...state.versions]
    .filter(item => item.window === window && item.seq <= atSeq)
    .sort((a, b) => a.version - b.version)
    .at(-1) ?? null;
  const confirmedIds = new Set(committed ? committed.eventIds : []);
  const confirmed = committed
    ? state.events.filter(item => confirmedIds.has(item.id))
    : [];
  const members = windowEventsSorted(state, window);

  return {
    window,
    atSeq,
    currentSeq: state.seq,
    // Status as of the replay position, not the current database status.
    status: committed ? 'closed' : 'open',
    currentlyClosed: win.status === 'closed',
    committedVersion: committed ? committed.version : null,
    committedKind: committed ? committed.kind : null,
    latestVersion: win.lastCommittedVersion,
    stale: committed != null && committed.version !== win.lastCommittedVersion,
    confirmed,
    waiting: members.filter(item => item.arrivedSeq <= atSeq && !confirmedIds.has(item.id)),
    later: members.filter(item => item.arrivedSeq > atSeq),
  };
}

// Flat, ordered timeline for the browser scrubber.
export function timelineView(state) {
  // At a shared sequence (late arrival + its recompute), the arrival precedes
  // the commit it triggers.
  const kindRank = {event: 0, commit: 1, recompute: 1};
  const occurrences = [
    ...state.events.map(item => ({kind: 'event', seq: item.arrivedSeq, window: item.window, id: item.id, late: item.late})),
    ...state.versions.map(item => ({kind: item.kind, seq: item.seq, window: item.window, version: item.version, supersededBy: item.supersededBy ?? null})),
  ].sort((a, b) => a.seq - b.seq || (kindRank[a.kind] - kindRank[b.kind]));
  return {
    seq: state.seq,
    windows: state.windows.map(win => ({...win})),
    events: state.events.map(item => ({...item})),
    versions: state.versions.map(item => ({...item})),
    occurrences,
  };
}

export function saveCursor(state, {version, atSeq, label} = {}) {
  if (!Number.isInteger(version)) throw new WindowLogError('BAD_REQUEST', 'cursor requires a bound version');
  const found = state.versions.find(item => item.version === version);
  if (!found) throw new WindowLogError('UNKNOWN_VERSION', 'unknown window version');
  // Default anchor is the commit itself; pass seq - 1 to pin the moment before.
  const position = atSeq == null ? found.seq : atSeq;
  if (!Number.isInteger(position) || position < 0 || position > found.seq) {
    throw new WindowLogError('BAD_REQUEST', `cursor atSeq must be between 0 and ${found.seq} (pre-commit is ${found.seq - 1})`);
  }

  const next = copy(state);
  const id = next.nextCursorId++;
  const cursor = {
    id,
    label: typeof label === 'string' && label.trim() ? label.trim() : `Cursor ${id}`,
    window: found.window,
    version,
    atSeq: position,
    createdSeq: state.seq,
  };
  next.cursors.push(cursor);
  return {state: next, cursor};
}

export function cursorView(state, id) {
  const cursor = state.cursors.find(item => item.id === id);
  if (!cursor) throw new WindowLogError('CURSOR_NOT_FOUND', 'unknown cursor');
  const view = viewAt(state, {window: cursor.window, atSeq: cursor.atSeq});
  // Validity is judged against the *bound* version, not the version visible at
  // the (possibly pre-commit) replay position.
  return {cursor: {...cursor}, view: {...view, boundStale: view.latestVersion !== cursor.version}};
}

// History is always readable; restoring is rejected when the bound version has
// been recomputed so an old snapshot can never overwrite the current state.
export function restoreCursor(state, id) {
  const result = cursorView(state, id);
  if (result.view.boundStale) {
    throw new WindowLogError('STALE_CURSOR', `cursor ${id} binds version ${result.cursor.version} but window ${result.cursor.window} is now at version ${result.view.latestVersion}`);
  }
  return result;
}

export function deleteCursor(state, id) {
  if (!state.cursors.some(item => item.id === id)) throw new WindowLogError('CURSOR_NOT_FOUND', 'unknown cursor');
  const next = copy(state);
  next.cursors = next.cursors.filter(item => item.id !== id);
  return next;
}
