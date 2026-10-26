import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

const SQL_DIR = new URL('../sql/', import.meta.url);

/** Runs every sql/*.sql file in name order. Files must be idempotent. */
export async function migrate(): Promise<void> {
  const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await pool.query(await readFile(new URL(file, SQL_DIR), 'utf8'));
  }
}

interface RequestRow {
  id: string;
  lat: number;
  lng: number;
  priority: string;
  at: Date;
}

export interface RequestEvent {
  requestId: string;
  event: string;
  agentId?: string;
  data?: Record<string, unknown>;
  at?: Date;
}

/**
 * Buffers writes and flushes them in batches so the dispatch hot path never
 * waits on Postgres. Losing the last <500ms of history on a crash is an
 * acceptable trade-off for this store.
 */
class EventStore {
  private requests: RequestRow[] = [];
  private events: (RequestEvent & { at: Date })[] = [];
  private timer?: NodeJS.Timeout;

  start(intervalMs = 500) {
    this.timer = setInterval(() => void this.flush(), intervalMs);
  }

  async stop() {
    clearInterval(this.timer);
    await this.flush();
  }

  recordRequest(row: RequestRow) {
    this.requests.push(row);
  }

  record(event: RequestEvent) {
    this.events.push({ ...event, at: event.at ?? new Date() });
  }

  private async flush() {
    const requests = this.requests.splice(0);
    const events = this.events.splice(0);
    try {
      // Requests first: events reference them logically.
      if (requests.length) {
        await pool.query(
          `INSERT INTO requests (id, pickup, priority, created_at)
           SELECT id, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography, priority, at
           FROM unnest($1::uuid[], $2::float8[], $3::float8[], $4::text[], $5::timestamptz[])
             AS t(id, lng, lat, priority, at)
           ON CONFLICT (id) DO NOTHING`,
          [
            requests.map((r) => r.id),
            requests.map((r) => r.lng),
            requests.map((r) => r.lat),
            requests.map((r) => r.priority),
            requests.map((r) => r.at),
          ],
        );
      }
      if (events.length) {
        await pool.query(
          `INSERT INTO request_events (request_id, event, agent_id, data, at)
           SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::jsonb[], $5::timestamptz[])`,
          [
            events.map((e) => e.requestId),
            events.map((e) => e.event),
            events.map((e) => e.agentId ?? null),
            events.map((e) => (e.data ? JSON.stringify(e.data) : null)),
            events.map((e) => e.at),
          ],
        );
      }
    } catch (err) {
      console.error(`[events] flush failed, dropped ${requests.length} requests / ${events.length} events`, err);
    }
  }
}

export const eventStore = new EventStore();
