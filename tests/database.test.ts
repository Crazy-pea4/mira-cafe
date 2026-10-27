import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { AppDatabase, StorageConflict } from '../server/database';
import { buildApp } from '../server/app';
import { RequestAudit } from '../server/request-audit';
import { MockProvider } from '../server/providers';
import { storySaves } from '../server/story-save';
import { newStory } from '../server/story';
import { confirmedProgress } from '../server/persisted-progress';
import type { FastifyInstance } from 'fastify';
import type { Deployment } from '../server/deployment';

const origin = 'http://127.0.0.1:3001', headers = { host: '127.0.0.1:3001', origin };
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function directory() { const path = mkdtempSync(join(tmpdir(), 'mira-db-test-')); temporary.push(path); return path; }
function client(app: FastifyInstance, initial = '') {
  const cookies = new Map(initial.split(';').map(value => value.trim()).filter(Boolean).map(value => { const i = value.indexOf('='); return [value.slice(0, i), value.slice(i + 1)]; }));
  return {
    cookie: () => [...cookies].map(([name, value]) => name + '=' + value).join('; '),
    async request(url: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', payload?: object) {
      const response = await app.inject({ url, method, headers: { ...headers, cookie: [...cookies].map(([name, value]) => name + '=' + value).join('; ') }, payload });
      for (const cookie of response.cookies) cookies.set(cookie.name, cookie.value);
      return response;
    },
  };
}
const appWith = (db: AppDatabase, deployment: Deployment = { basePath: '' }) => buildApp(new MockProvider(), 18000, undefined, new RequestAudit(db), deployment, 'test-save-key', db);
const turn = { sessionId: '22222222-2222-4222-8222-222222222222', turnId: 1, text: '谢谢，外面雨好大。', history: [], fault: 'none' };

describe('SQLite storage, migrations and isolation', () => {
  it('applies migrations once, restricts file permissions, rolls back transactions and preserves imported counters', () => {
    const dir = directory(), file = join(dir, 'mira.sqlite');
    writeFileSync(join(dir, 'budget.json'), JSON.stringify({ version: 1, requests: { deepseek: 2, asr: 1, tts: 3 }, reservedMicros: 540000 }));
    let db = new AppDatabase(file);
    try {
      db.importLegacy(dir); db.importLegacy(dir);
      expect(db.read().requests).toEqual({ deepseek: 2, asr: 1, tts: 3 });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(() => db.transaction(() => { db.createVisitor('rollback'); throw Error('abort'); })).toThrow('abort');
      expect(db.visitor('rollback')).toBeUndefined();
      new RequestAudit(db).record('deepseek', new AbortController().signal);
      db.close(); db = new AppDatabase(file); db.importLegacy(dir);
      expect(db.read().requests.deepseek).toBe(3);
      expect(db.sql.prepare('SELECT count(*) AS count FROM schema_migrations').get()?.count).toBe(1);
    } finally { db.close(); }
  });

  it('does not overwrite malformed legacy statistics with a misleading zero ledger', () => {
    const dir = directory(); writeFileSync(join(dir, 'budget.json'), '{broken');
    const db = new AppDatabase(':memory:');
    try {
      db.importLegacy(dir);
      expect(new RequestAudit(db).status().available).toBe(false);
      expect(() => new RequestAudit(db).record('tts', new AbortController().signal)).not.toThrow();
      expect(db.sql.prepare("SELECT status FROM legacy_imports WHERE name='usage'").get()?.status).toBe('invalid');
    } finally { db.close(); }
  });

  it('persists only acknowledged dialogue and restores it without browser storage after restart', async () => {
    const file = join(directory(), 'mira.sqlite'); let db = new AppDatabase(file), app = appWith(db);
    let user = client(app);
    try {
      expect((await user.request('/api/progress')).json().progress).toBeNull();
      expect((await user.request('/api/turn', 'POST', turn)).statusCode).toBe(200);
      expect((await user.request('/api/progress')).json().progress).toBeNull();
      const receipt = await user.request('/api/presented', 'POST', { sessionId: turn.sessionId, turnId: 1, through: 1 });
      expect(receipt.statusCode).toBe(200);
      const before = (await user.request('/api/progress')).json().progress;
      expect(before.view.subtitle).not.toBe('');
      expect(db.sql.prepare('SELECT count(*) AS count FROM conversation_messages').get()?.count).toBe(2);
      const rev = db.sql.prepare('SELECT revision FROM conversations WHERE active=1').get()?.revision;
      expect((await user.request('/api/presented', 'POST', { sessionId: turn.sessionId, turnId: 1, through: 1 })).statusCode).toBe(200);
      expect(db.sql.prepare('SELECT revision FROM conversations WHERE active=1').get()?.revision).toBe(rev);
      const cookie = user.cookie(); await app.close(); db.close();
      db = new AppDatabase(file); app = appWith(db); user = client(app, cookie);
      expect((await user.request('/api/progress')).json().progress).toEqual(before);
      const other = client(app); expect((await other.request('/api/progress')).json().progress).toBeNull();
      const next = await user.request('/api/turn', 'POST', { ...turn, sessionId: '33333333-3333-4333-8333-333333333333', text: '你桌上是照片吗？' });
      expect(next.statusCode).toBe(200);
    } finally { await app.close(); db.close(); }
  });

  it('archives a reset and prevents late receipts or legacy import from resurrecting progress', async () => {
    const db = new AppDatabase(':memory:'), app = appWith(db), user = client(app);
    try {
      await user.request('/api/progress');
      await user.request('/api/turn', 'POST', turn);
      await user.request('/api/presented', 'POST', { sessionId: turn.sessionId, turnId: 1, through: 1 });
      const before = (await user.request('/api/progress')).json().progress;
      expect((await user.request('/api/progress', 'DELETE')).statusCode).toBe(200);
      expect((await user.request('/api/presented', 'POST', { sessionId: turn.sessionId, turnId: 1, through: 1 })).statusCode).toBe(409);
      expect((await user.request('/api/progress', 'POST', before)).json().progress).toBeNull();
      expect(db.sql.prepare('SELECT count(*) AS count FROM conversations').get()?.count).toBe(2);
    } finally { await app.close(); db.close(); }
  });

  it('imports a signed legacy checkpoint once and rejects tampering before saving', async () => {
    const db = new AppDatabase(':memory:'), app = appWith(db), user = client(app);
    try {
      await user.request('/api/progress');
      const state = newStory(), checkpoint = storySaves('test-save-key', ':mock').seal(state);
      const progress = { version: 1, checkpoint, view: { story: { act: 'invitation', facts: [], ending: null, planQuote: '', declined: false }, suggestions: state.lastSuggestions, narration: '', subtitle: '已呈现对白', emotion: 'guarded', scene: 'rain', location: 'cafe', photo: false, stageProps: { photoPose: 'aside', phone: 'none', message: '' }, lastInput: '', completed: 0 } };
      expect((await user.request('/api/progress', 'POST', { ...progress, checkpoint: checkpoint + 'invalid' })).statusCode).toBe(400);
      expect((await user.request('/api/progress', 'POST', progress)).json().progress.view.subtitle).toBe('已呈现对白');
      await user.request('/api/progress', 'POST', { ...progress, view: { ...progress.view, subtitle: '不应覆盖' } });
      expect((await user.request('/api/progress')).json().progress.view.subtitle).toBe('已呈现对白');
    } finally { await app.close(); db.close(); }
  });

  it('enforces conversation revision checks and keeps both messages atomic with progress', () => {
    const db = new AppDatabase(':memory:');
    try {
      const owner = db.createVisitor('owner'), first = db.current(owner, ':mock');
      const state = newStory(), checkpoint = storySaves('test-save-key', ':mock').seal(state);
      const progress = confirmedProgress(state, checkpoint, { turnId: 1, input: '', reply: { segments: [] }, proposal: { intent: 'engage' }, units: [], through: 0, heard: [] }, 0, null);
      db.save(first, state, progress, { key: 'a', user: '输入', assistant: '确认输出' });
      expect(() => db.save(first, state, progress, { key: 'b', user: '过时输入', assistant: '过时输出' })).toThrow(StorageConflict);
      expect(db.sql.prepare('SELECT count(*) AS count FROM conversation_messages').get()?.count).toBe(2);
    } finally { db.close(); }
  });

  it('stores bounded numeric timing history by visitor and rejects unexpected text fields', async () => {
    const db = new AppDatabase(':memory:'), app = appWith(db), user = client(app), other = client(app);
    const batch = { pageId: '55555555-5555-4555-8555-555555555555', records: [{ id: 1, kind: 'tts', turnId: 2, mode: 'live', status: 'complete', startedAt: 1, elapsedMs: 200, points: { firstAudio: 100 } }] };
    try {
      await user.request('/api/progress'); await other.request('/api/progress');
      expect((await user.request('/api/timings', 'POST', batch)).statusCode).toBe(200);
      await user.request('/api/timings', 'POST', batch);
      expect((await user.request('/api/timings')).json().records).toHaveLength(1);
      expect((await other.request('/api/timings')).json().records).toEqual([]);
      expect((await user.request('/api/timings', 'POST', { ...batch, records: [{ ...batch.records[0], transcript: '不应保存' }] })).statusCode).toBe(400);
    } finally { await app.close(); db.close(); }
  });

  it('persists invitation authentication across restart and still revokes logout', async () => {
    const salt = randomBytes(16), password = 'ephemeral-test';
    const passwordHash = 'scrypt$' + salt.toString('hex') + '$' + scryptSync(password, salt, 64).toString('hex');
    const deployment = { publicOrigin: origin, basePath: '', auth: { passwordHash } };
    const file = join(directory(), 'mira.sqlite'); let db = new AppDatabase(file), app = appWith(db, deployment), user = client(app);
    try {
      expect((await user.request('/auth/login', 'POST', { password })).statusCode).toBe(303);
      const cookie = user.cookie();
      expect((await user.request('/api/progress')).statusCode).toBe(200);
      await app.close(); db.close(); db = new AppDatabase(file); app = appWith(db, deployment); user = client(app, cookie);
      expect((await user.request('/api/health')).statusCode).toBe(200);
      expect((await user.request('/auth/logout', 'POST')).statusCode).toBe(303);
      expect((await user.request('/api/health')).statusCode).toBe(401);
    } finally { await app.close(); db.close(); }
  });
});
