import {readFile, rename, writeFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createWindowLog} from './window-log.mjs';

// File-backed event log. Mutations are applied through a serial promise queue so
// concurrent POSTs cannot interleave and lose events; each mutation is flushed
// to disk (temp file + rename) before its response resolves.
export class EventStore {
  constructor(path) {
    this.path = path;
    this.ready = this.#load();
    this.queue = Promise.resolve();
  }

  async #load() {
    try {
      const raw = await readFile(this.path, 'utf8');
      this.state = hydrate(JSON.parse(raw));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = createWindowLog();
      await this.#flush();
    }
  }

  getState() { return structuredClone(this.state); }

  // Read accessor used by request handlers; always resolves after initial load.
  async read() { await this.ready; return this.getState(); }

  // `mutator` receives a fresh clone, returns the next state (or {state,...}).
  async mutate(mutator) {
    const run = this.queue.then(async () => {
      await this.ready;
      const result = await mutator(this.getState());
      if (result && Object.hasOwn(result, 'state')) {
        this.state = result.state;
        await this.#flush();
        return structuredClone(result);
      }
      this.state = result;
      await this.#flush();
      return this.getState();
    });
    // Keep the chain alive even if one mutation rejects.
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  async #flush() {
    await mkdir(dirname(this.path), {recursive: true});
    const tmp = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state));
    await rename(tmp, this.path);
  }
}

// Restore future fields without losing state produced by older files.
function hydrate(raw) {
  return {
    ...createWindowLog(),
    ...raw,
    events: raw.events ?? [],
    windows: raw.windows ?? [],
    versions: raw.versions ?? [],
    cursors: raw.cursors ?? [],
    seq: raw.seq ?? 0,
    nextVersion: raw.nextVersion ?? (Math.max(0, ...(raw.versions ?? []).map(v => v.version)) + 1),
    nextCursorId: raw.nextCursorId ?? (Math.max(0, ...(raw.cursors ?? []).map(c => c.id)) + 1),
  };
}
