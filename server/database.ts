import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { initialStorage } from './migrations/001-storage';
import { auditStateSchema, AuditStoreError, type AuditStore, type Ledger } from './request-audit';
import { safeReplyDiagnostic, type ReplyDiagnostic } from './reply-diagnostics';
import { newStory, type StoryState } from './story';
import { progressSchema, type SavedProgress } from '../shared/progress';
import type { z } from 'zod';
import type { timingRecordSchema } from '../shared/timing';

export class StorageConflict extends Error {}
export type StoredConversation = { id: string; revision: number; state: StoryState; progress: SavedProgress | null };
export class AppDatabase implements AuditStore {
  readonly sql: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sql = new DatabaseSync(path, { timeout: 1500 });
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.sql.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.sql.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT');
    if (!this.sql.prepare('SELECT 1 FROM schema_migrations WHERE version=1').get()) this.transaction(() => {
      this.sql.exec(initialStorage);
      this.sql.prepare('INSERT INTO schema_migrations VALUES(1,?)').run(Date.now());
    });
    this.sql.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(Date.now());
  }
  close() { this.sql.close(); }
  transaction<T>(work: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.sql.exec('COMMIT'); return value; }
    catch (error) { this.sql.exec('ROLLBACK'); throw error; }
  }
  visitor(hash: string): string | undefined {
    return (this.sql.prepare('SELECT id FROM visitors WHERE token_hash=?').get(hash) as { id: string } | undefined)?.id;
  }
  createVisitor(hash: string): string {
    const id = randomUUID();
    this.sql.prepare('INSERT INTO visitors VALUES(?,?,?)').run(id, hash, Date.now());
    return id;
  }
  auth(hash: string, tag: string) {
    return this.sql.prepare('SELECT visitor_id AS owner, expires_at AS expires FROM auth_sessions WHERE token_hash=? AND credential_tag=? AND expires_at>?').get(hash, tag, Date.now()) as { owner: string; expires: number } | undefined;
  }
  grant(hash: string, owner: string, tag: string, expires: number) {
    this.sql.prepare('INSERT INTO auth_sessions VALUES(?,?,?,?)').run(hash, owner, tag, expires);
  }
  revoke(hash: string) { this.sql.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(hash); }
  current(owner: string, scope: string): StoredConversation {
    let row = this.sql.prepare('SELECT * FROM conversations WHERE visitor_id=? AND scope=? AND active=1').get(owner, scope) as Record<string, unknown> | undefined;
    if (!row) {
      const id = randomUUID(), now = Date.now();
      this.sql.prepare('INSERT OR IGNORE INTO conversations(id,visitor_id,scope,state_json,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, owner, scope, JSON.stringify(newStory()), now, now);
      row = this.sql.prepare('SELECT * FROM conversations WHERE visitor_id=? AND scope=? AND active=1').get(owner, scope) as Record<string, unknown>;
    }
    return { id: row.id as string, revision: row.revision as number, state: JSON.parse(row.state_json as string), progress: row.progress_json ? progressSchema.parse(JSON.parse(row.progress_json as string)) : null };
  }
  canImport(owner: string, scope: string) {
    const row = this.sql.prepare('SELECT count(*) AS count FROM conversations WHERE visitor_id=? AND scope=?').get(owner, scope)!;
    return row.count === 1;
  }
  save(conversation: StoredConversation, state: StoryState, progress: SavedProgress, exchange?: { key: string; user: string; assistant: string }) {
    return this.transaction(() => {
      const updated = this.sql.prepare('UPDATE conversations SET state_json=?,progress_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND active=1').run(JSON.stringify(state), JSON.stringify(progress), Date.now(), conversation.id, conversation.revision);
      if (!updated.changes) throw new StorageConflict('Progress changed');
      if (exchange) for (const role of ['user', 'assistant'] as const) this.sql.prepare('INSERT INTO conversation_messages(conversation_id,exchange_key,role,content,created_at) VALUES(?,?,?,?,?) ON CONFLICT(conversation_id,exchange_key,role) DO UPDATE SET content=excluded.content').run(conversation.id, exchange.key, role, exchange[role], Date.now());
      return { ...conversation, state, progress, revision: conversation.revision + 1 };
    });
  }
  reset(owner: string, scope: string) {
    this.transaction(() => {
      this.sql.prepare('UPDATE conversations SET active=0,updated_at=? WHERE visitor_id=? AND scope=? AND active=1').run(Date.now(), owner, scope);
      this.current(owner, scope);
    });
  }
  read(): Ledger {
    if (this.sql.prepare("SELECT 1 FROM legacy_imports WHERE name='usage' AND status='invalid'").get()) throw new AuditStoreError('Legacy counters require recovery');
    const row = this.sql.prepare('SELECT * FROM usage_totals WHERE singleton=1').get()!;
    return auditStateSchema.parse({ version: 1, requests: { deepseek: row.deepseek, asr: row.asr, tts: row.tts }, reservedMicros: row.reserved_micros });
  }
  update(change: (state: Ledger) => Ledger) {
    this.transaction(() => {
      const next = auditStateSchema.parse(change(this.read()));
      this.sql.prepare('UPDATE usage_totals SET deepseek=?,asr=?,tts=?,reserved_micros=? WHERE singleton=1').run(next.requests.deepseek, next.requests.asr, next.requests.tts, next.reservedMicros);
    });
  }
  diagnostic(facts: ReplyDiagnostic) {
    const safe = safeReplyDiagnostic(facts);
    if (!safe) return;
    try {
      this.sql.prepare('INSERT INTO reply_diagnostics(created_at,outcome,data_json) VALUES(?,?,?)').run(Date.now(), safe.outcome, JSON.stringify(safe));
      this.sql.exec('DELETE FROM reply_diagnostics WHERE id NOT IN (SELECT id FROM reply_diagnostics ORDER BY id DESC LIMIT 2000)');
    } catch { /* Diagnostics never fail an otherwise usable paid reply. */ }
  }
  importLegacy(directory: string) {
    if (!this.sql.prepare("SELECT 1 FROM legacy_imports WHERE name='usage'").get()) {
      const path = join(directory, 'budget.json');
      let ledger: Ledger | undefined, invalid = false;
      if (existsSync(path)) {
        try { ledger = auditStateSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
        catch { invalid = true; }
      }
      this.transaction(() => {
        if (ledger) this.sql.prepare('UPDATE usage_totals SET deepseek=?,asr=?,tts=?,reserved_micros=? WHERE singleton=1').run(ledger.requests.deepseek, ledger.requests.asr, ledger.requests.tts, ledger.reservedMicros);
        this.sql.prepare('INSERT INTO legacy_imports VALUES(?,?,?)').run('usage', Date.now(), invalid ? 'invalid' : 'imported');
      });
    }
    if (!this.sql.prepare("SELECT 1 FROM legacy_imports WHERE name='diagnostics'").get()) this.transaction(() => {
      for (const filename of ['recent-reply-diagnostics.json', 'last-reply-diagnostic.json']) {
        try {
          const value: unknown = JSON.parse(readFileSync(join(directory, filename), 'utf8'));
          for (const item of Array.isArray(value) ? value.slice(-20) : [value]) {
            const safe = safeReplyDiagnostic(item);
            if (safe) this.diagnostic(safe);
          }
        } catch { /* Preserve malformed original files, without storing their contents. */ }
      }
      this.sql.prepare('INSERT INTO legacy_imports VALUES(?,?,?)').run('diagnostics', Date.now(), 'imported');
    });
  }
  timings(owner: string, scope: string, page: string, records: z.infer<typeof timingRecordSchema>[]) {
    this.transaction(() => {
      for (const record of records) this.sql.prepare('INSERT OR IGNORE INTO client_timings(visitor_id,scope,page_id,record_id,data_json,created_at) VALUES(?,?,?,?,?,?)').run(owner, scope, page, record.id, JSON.stringify(record), Date.now());
      this.sql.prepare('DELETE FROM client_timings WHERE visitor_id=? AND scope=? AND id NOT IN (SELECT id FROM client_timings WHERE visitor_id=? AND scope=? ORDER BY id DESC LIMIT 200)').run(owner, scope, owner, scope);
    });
  }
  timingHistory(owner: string, scope: string) {
    return this.sql.prepare('SELECT data_json FROM client_timings WHERE visitor_id=? AND scope=? ORDER BY id DESC LIMIT 20').all(owner, scope).map(row => JSON.parse(row.data_json as string));
  }
}
