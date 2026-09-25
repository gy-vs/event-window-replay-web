import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join, normalize} from 'node:path';
import {
  advanceWindow,
  appendEvent,
  currentWindows,
  cursorView,
  deleteCursor,
  readVersion,
  restoreCursor,
  saveCursor,
  timelineView,
  viewAt,
  WindowLogError,
} from './src/window-log.mjs';
import {EventStore} from './src/event-store.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const STATUS_BY_CODE = {
  BAD_REQUEST: 400,
  WINDOW_NOT_FOUND: 404,
  UNKNOWN_VERSION: 404,
  CURSOR_NOT_FOUND: 404,
  WINDOW_CLOSED: 409,
  STALE_CURSOR: 409,
};
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

function json(res, status, body) {
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let text = '';
  for await (const part of req) text += part;
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new WindowLogError('BAD_REQUEST', 'invalid JSON body'); }
}

async function serveStatic(res, pathname) {
  const requested = normalize(pathname === '/' ? '/index.html' : pathname);
  const file = join(PUBLIC_DIR, requested);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 404, {error: 'not found'});
  try {
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, {'content-type': CONTENT_TYPES.get(ext) ?? 'application/octet-stream'});
    res.end(body);
  } catch (error) {
    if (error.code === 'ENOENT') return json(res, 404, {error: 'not found'});
    throw error;
  }
}

export function createApp(store) {
  const wantsJson = req => (req.headers.accept ?? '').includes('application/json') || (req.headers.accept ?? '').startsWith('/');

  const app = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const {pathname, searchParams} = url;
    try {
      // --- Existing API surface (preserved) ---
      if (pathname === '/api/events' && req.method === 'POST') {
        const event = await readBody(req);
        const state = await store.mutate(s => appendEvent(s, event));
        // Events are stored time-sorted, so return the event just written
        // (idempotent duplicates echo the existing record too).
        return json(res, 201, state.events.find(item => item.id === event.id));
      }
      if (pathname === '/api/windows' && req.method === 'GET') {
        const state = await store.read();
        return json(res, 200, {windows: currentWindows(state), versions: state.versions});
      }
      const versionMatch = pathname.match(/^\/api\/versions\/(\d+)$/);
      if (versionMatch && req.method === 'GET') {
        const state = await store.read();
        return json(res, 200, readVersion(state, Number(versionMatch[1])));
      }

      // --- Window commits ---
      if (pathname === '/api/windows/advance' && req.method === 'POST') {
        const input = await readBody(req);
        const state = await store.mutate(s => advanceWindow(s, input));
        return json(res, 201, readVersion(state, state.windows.find(w => w.window === input.window).lastCommittedVersion));
      }
      if (pathname === '/api/timeline' && req.method === 'GET') {
        const state = await store.read();
        return json(res, 200, timelineView(state));
      }
      if (pathname === '/api/views' && req.method === 'GET') {
        const state = await store.read();
        const window = searchParams.get('window');
        const atSeq = Number(searchParams.get('atSeq'));
        return json(res, 200, viewAt(state, {window, atSeq}));
      }

      // --- Resumable version cursors ---
      if (pathname === '/api/cursors' && req.method === 'POST') {
        const input = await readBody(req);
        const {state, cursor} = await store.mutate(s => saveCursor(s, input));
        return json(res, 201, cursorView(state, cursor.id));
      }
      if (pathname === '/api/cursors' && req.method === 'GET') {
        const state = await store.read();
        return json(res, 200, {
          seq: state.seq,
          cursors: state.cursors.map(cursor => ({...cursor, boundStale: state.windows.find(w => w.window === cursor.window)?.lastCommittedVersion !== cursor.version})),
        });
      }
      const cursorMatch = pathname.match(/^\/api\/cursors\/(\d+)$/);
      if (cursorMatch && req.method === 'GET') {
        const state = await store.read();
        return json(res, 200, cursorView(state, Number(cursorMatch[1])));
      }
      const restoreMatch = pathname.match(/^\/api\/cursors\/(\d+)\/restore$/);
      if (restoreMatch && req.method === 'POST') {
        const state = await store.read();
        return json(res, 200, restoreCursor(state, Number(restoreMatch[1])));
      }
      if (cursorMatch && req.method === 'DELETE') {
        await store.mutate(s => deleteCursor(s, Number(cursorMatch[1])));
        return json(res, 200, {deleted: Number(cursorMatch[1])});
      }

      // --- Root and browser assets ---
      if (pathname === '/' && !wantsJson(req)) return serveStatic(res, '/index.html');
      if (pathname === '/') {
        const state = await store.read();
        return json(res, 200, {service: 'event-window-replay', windows: currentWindows(state)});
      }
      if (pathname === '/app.js' || pathname === '/index.html') return serveStatic(res, pathname);

      return json(res, 404, {error: 'not found'});
    } catch (error) {
      if (error instanceof WindowLogError) return json(res, STATUS_BY_CODE[error.code] ?? 400, {error: error.message, code: error.code});
      return json(res, 400, {error: error.message});
    }
  });
  return app;
}

function listen(store, app, port) {
  // Wait for disk load before accepting traffic so a restart resumes saved
  // cursors and versions rather than starting empty.
  store.ready.then(() => app.listen(port));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dataFile = process.env.EVENT_WINDOW_DATA_FILE ?? join(ROOT, 'data', 'event-window-log.json');
  const store = new EventStore(dataFile);
  const app = createApp(store);
  listen(store, app, Number(process.env.PORT ?? 4174));
}
