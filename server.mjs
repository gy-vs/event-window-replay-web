import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {currentWindows, getCursor, listCursors, readVersion, replayView} from './src/window-log.mjs';
import {createStore} from './src/file-store.mjs';

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {'content-type': type});
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  let text = '';
  for await (const part of req) text += part;
  return JSON.parse(text || '{}');
}

// Pure errors carry the boundary semantics:
//   unknown cursor / version      -> 404 (the resume target is gone)
//   cursor does not match window  -> 409 (cursor is bound to another window)
//   anything else                 -> 400 (bad request shape)
function fail(res, message) {
  const status = /^unknown/.test(message) ? 404 : /does not match/.test(message) ? 409 : 400;
  return send(res, status, {error: message});
}

const CONTENT_TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8'};

export function createServerWithStore(store) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const {pathname} = url;
    try {
      if (pathname === '/api/events' && req.method === 'POST') {
        const event = await readBody(req);
        const stored = await store.appendEvent(event);
        return send(res, 201, stored);
      }

      if (pathname === '/api/windows' && req.method === 'GET') {
        const state = store.snapshot();
        // versions stays in the payload so existing version queries keep their index.
        return send(res, 200, {windows: currentWindows(state), versions: state.versions, cursors: listCursors(state)});
      }

      const versionMatch = pathname.match(/^\/api\/versions\/(\d+)$/);
      if (versionMatch && req.method === 'GET') {
        return send(res, 200, readVersion(store.snapshot(), Number(versionMatch[1])));
      }

      const commitMatch = pathname.match(/^\/api\/windows\/([^/]+)\/commit$/);
      if (commitMatch && req.method === 'POST') {
        const window = decodeURIComponent(commitMatch[1]);
        const result = await store.commit(window);
        return send(res, 201, {window, ...result});
      }

      if (pathname === '/api/replay' && req.method === 'GET') {
        const window = url.searchParams.get('window') ?? '';
        const version = Number(url.searchParams.get('version'));
        return send(res, 200, replayView(store.snapshot(), window, version));
      }

      if (pathname === '/api/cursors' && req.method === 'GET') {
        return send(res, 200, {cursors: listCursors(store.snapshot())});
      }
      if (pathname === '/api/cursors' && req.method === 'POST') {
        const cursor = await store.saveCursor(await readBody(req));
        return send(res, 201, cursor);
      }
      const cursorMatch = pathname.match(/^\/api\/cursors\/(\d+)$/);
      if (cursorMatch && req.method === 'GET') {
        return send(res, 200, getCursor(store.snapshot(), Number(cursorMatch[1])));
      }

      if (pathname === '/api/health' && req.method === 'GET') {
        const state = store.snapshot();
        return send(res, 200, {service: 'event-window-replay', windows: currentWindows(state).length});
      }

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = await readFile(join(PUBLIC_DIR, 'index.html'));
        return send(res, 200, html, CONTENT_TYPES['.html']);
      }
      if (req.method === 'GET' && pathname === '/app.js') {
        const js = await readFile(join(PUBLIC_DIR, 'app.js'));
        return send(res, 200, js, CONTENT_TYPES['.js']);
      }

      return send(res, 404, {error: 'not found'});
    } catch (error) {
      return fail(res, error.message);
    }
  });
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

async function start() {
  const file = process.env.LOG_FILE ?? 'data/event-window.log';
  const store = await createStore({file});
  const app = createServerWithStore(store);
  app.listen(Number(process.env.PORT ?? 4174));
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) await start();
