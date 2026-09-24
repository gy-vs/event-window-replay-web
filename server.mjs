import {createServer} from 'node:http';
import {appendEvent, createWindowLog, currentWindows, readVersion} from './src/window-log.mjs';

let state = createWindowLog();
function json(res, status, body) { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(body)); }
async function body(req) { let text = ''; for await (const part of req) text += part; return JSON.parse(text || '{}'); }
const app = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/api/events' && req.method === 'POST') { state = appendEvent(state, await body(req)); return json(res, 201, state.events.at(-1)); }
    if (url.pathname === '/api/windows' && req.method === 'GET') return json(res, 200, {windows: currentWindows(state), versions: state.versions});
    if (url.pathname.startsWith('/api/versions/') && req.method === 'GET') return json(res, 200, readVersion(state, Number(url.pathname.split('/').at(-1))));
    if (url.pathname === '/') return json(res, 200, {service: 'event-window-replay', windows: currentWindows(state)});
    return json(res, 404, {error: 'not found'});
  } catch (error) { return json(res, 400, {error: error.message}); }
});
if (import.meta.url === `file://${process.argv[1]}`) app.listen(Number(process.env.PORT ?? 4174));
export {app};
