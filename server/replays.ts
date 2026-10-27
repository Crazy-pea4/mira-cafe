import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppDatabase, StorageConflict } from './database';
import { withBasePath } from '../shared/base-path';
import { REPLAY_ASSET_VERSION, REPLAY_MAX_EVENTS, REPLAY_MAX_TURNS, replayEventSchema, replayFrameSchema, type ReplayEvent, type ReplayFrame, type ReplaySummary } from '../shared/replay';

export class ReplayRepository {
  constructor(private database: AppDatabase) {}
  private row(owner: string, scope: string, id: string) {
    return this.database.sql.prepare('SELECT * FROM recordings WHERE id=? AND visitor_id=? AND scope=?').get(id, owner, scope);
  }
  private summary(row: Record<string, unknown>): ReplaySummary {
    return { id: row.id as string, createdAt: row.created_at as number, status: row.status as ReplaySummary['status'], count: row.event_count as number, turns: row.turn_count as number, durationMs: row.duration_ms as number, assetVersion: row.asset_version as string };
  }
  list(owner: string, scope: string) {
    return this.database.sql.prepare('SELECT * FROM recordings WHERE visitor_id=? AND scope=? ORDER BY created_at DESC,id DESC LIMIT 5').all(owner, scope).map(row => this.summary(row));
  }
  create(owner: string, scope: string, id: string, frame: ReplayFrame) {
    return this.database.transaction(() => {
      const existing = this.row(owner, scope, id);
      if (existing) return this.summary(existing);
      this.database.sql.prepare("UPDATE recordings SET status='stopped',updated_at=? WHERE visitor_id=? AND scope=? AND status='recording'").run(Date.now(), owner, scope);
      this.database.sql.prepare("INSERT INTO recordings(id,visitor_id,scope,status,asset_version,created_at,updated_at) VALUES(?,?,?,'recording',?,?,?)").run(id, owner, scope, REPLAY_ASSET_VERSION, Date.now(), Date.now());
      this.database.sql.prepare('INSERT INTO replay_events VALUES(?,0,0,?,?,?)').run(id, frame.turnId, 'recording.started', JSON.stringify(frame));
      this.database.sql.prepare('DELETE FROM recordings WHERE visitor_id=? AND scope=? AND id!=? AND id NOT IN (SELECT id FROM recordings WHERE visitor_id=? AND scope=? AND id!=? ORDER BY created_at DESC,id DESC LIMIT 4)').run(owner, scope, id, owner, scope, id);
      return this.summary(this.row(owner, scope, id)!);
    });
  }
  append(owner: string, scope: string, id: string, events: ReplayEvent[]) {
    return this.database.transaction(() => {
      const row = this.row(owner, scope, id);
      if (!row) return undefined;
      let count = row.event_count as number, turns = row.turn_count as number, duration = row.duration_ms as number;
      for (const event of events) {
        if (event.sequence < count) {
          const old = this.database.sql.prepare('SELECT at_ms,turn_id,type,frame_json FROM replay_events WHERE recording_id=? AND sequence=?').get(id, event.sequence);
          if (!old || old.at_ms !== event.atMs || old.turn_id !== event.turnId || old.type !== event.type || old.frame_json !== JSON.stringify(event.frame)) throw new StorageConflict('Conflicting event');
          continue;
        }
        if (row.status !== 'recording' || event.sequence !== count || event.atMs < duration || count >= REPLAY_MAX_EVENTS || (event.type === 'input.accepted' && turns >= REPLAY_MAX_TURNS)) throw new StorageConflict('Recording ended or out of sequence');
        this.database.sql.prepare('INSERT INTO replay_events VALUES(?,?,?,?,?,?)').run(id, count, event.atMs, event.turnId, event.type, JSON.stringify(event.frame));
        count++; if (event.type === 'input.accepted') turns++; duration = event.atMs;
      }
      const status = count >= REPLAY_MAX_EVENTS ? 'limit' : row.status as string;
      this.database.sql.prepare('UPDATE recordings SET event_count=?,turn_count=?,duration_ms=?,status=?,updated_at=? WHERE id=?').run(count, turns, duration, status, Date.now(), id);
      return this.summary(this.row(owner, scope, id)!);
    });
  }
  stop(owner: string, scope: string, id: string) {
    this.database.sql.prepare("UPDATE recordings SET status=CASE WHEN status='limit' THEN 'limit' ELSE 'stopped' END,updated_at=? WHERE id=? AND visitor_id=? AND scope=?").run(Date.now(), id, owner, scope);
    const row = this.row(owner, scope, id); return row ? this.summary(row) : undefined;
  }
  read(owner: string, scope: string, id: string) {
    const row = this.row(owner, scope, id);
    if (!row) return undefined;
    const events = this.database.sql.prepare('SELECT * FROM replay_events WHERE recording_id=? ORDER BY sequence').all(id).map(event => ({ sequence: event.sequence as number, atMs: event.at_ms as number, turnId: event.turn_id as number, type: event.type, frame: JSON.parse(event.frame_json as string) }));
    return { schemaVersion: 1, recording: this.summary(row), events };
  }
  delete(owner: string, scope: string, id: string) {
    return this.database.sql.prepare('DELETE FROM recordings WHERE id=? AND visitor_id=? AND scope=?').run(id, owner, scope).changes > 0;
  }
}

export function registerReplays(app: FastifyInstance, database: AppDatabase, basePath: string, scope: string) {
  const repository = new ReplayRepository(database), path = (suffix: string) => withBasePath(basePath, 'api/replays' + suffix);
  const startSchema = z.object({ id: z.string().uuid(), frame: replayFrameSchema }).strict();
  const batchSchema = z.object({ events: z.array(replayEventSchema).min(1).max(10) }).strict();
  app.get(path(''), async request => ({ recordings: repository.list(request.miraOwner!, scope) }));
  app.post(path(''), { bodyLimit: 20000 }, async (request, reply) => {
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'BAD_REPLAY' } });
    return { recording: repository.create(request.miraOwner!, scope, parsed.data.id, parsed.data.frame) };
  });
  app.get(path('/:id'), async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id: unknown }).id);
    if (!id.success) return reply.code(400).send({ error: { code: 'BAD_REPLAY' } });
    const record = repository.read(request.miraOwner!, scope, id.data);
    return record ?? reply.code(404).send({ error: { code: 'NOT_FOUND' } });
  });
  app.post(path('/:id/events'), { bodyLimit: 150000 }, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id: unknown }).id), parsed = batchSchema.safeParse(request.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ error: { code: 'BAD_REPLAY' } });
    try {
      const recording = repository.append(request.miraOwner!, scope, id.data, parsed.data.events);
      return recording ? { recording } : reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    } catch (error) {
      if (error instanceof StorageConflict) return reply.code(409).send({ error: { code: 'REPLAY_CONFLICT', message: '记录已结束或顺序发生变化，请重新开始记录。' } });
      throw error;
    }
  });
  app.post(path('/:id/stop'), async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id: unknown }).id);
    if (!id.success) return reply.code(400).send({ error: { code: 'BAD_REPLAY' } });
    const recording = repository.stop(request.miraOwner!, scope, id.data);
    return recording ? { recording } : reply.code(404).send({ error: { code: 'NOT_FOUND' } });
  });
  app.delete(path('/:id'), async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id: unknown }).id);
    if (!id.success) return reply.code(400).send({ error: { code: 'BAD_REPLAY' } });
    return repository.delete(request.miraOwner!, scope, id.data) ? { ok: true } : reply.code(404).send({ error: { code: 'NOT_FOUND' } });
  });
}
