export function createWindowLog() {
  return {events: [], versions: [], nextVersion: 1};
}

function copy(value) { return structuredClone(value); }

export function appendEvent(state, event) {
  if (!event.id || !event.window || !Number.isFinite(event.eventTime)) throw new Error('event requires id, window and eventTime');
  if (state.events.some(item => item.id === event.id)) return copy(state);
  const next = copy(state);
  next.events.push({...event});
  next.events.sort((a, b) => a.eventTime - b.eventTime || a.id.localeCompare(b.id));
  const version = next.nextVersion++;
  next.versions.push({version, window: event.window, eventIds: next.events.filter(item => item.window === event.window).map(item => item.id)});
  return next;
}

export function readVersion(state, version) {
  const found = state.versions.find(item => item.version === version);
  if (!found) throw new Error('unknown window version');
  const ids = new Set(found.eventIds);
  return {version: found.version, window: found.window, events: state.events.filter(item => ids.has(item.id))};
}

export function currentWindows(state) {
  return [...new Set(state.events.map(item => item.window))].map(window => ({window, events: state.events.filter(item => item.window === window)}));
}
