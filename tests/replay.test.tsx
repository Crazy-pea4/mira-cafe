import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppDatabase, StorageConflict } from '../server/database';
import { ReplayRepository } from '../server/replays';
import { buildApp } from '../server/app';
import { MockProvider } from '../server/providers';
import { ConversationEngine } from '../src/core/engine';
import { ReplayPlayer, ReplayRecorder, type ReplayApi } from '../src/core/replay';
import { ReplayPanel } from '../src/ReplayPanel';
import { replayFrame, replayDataSchema, REPLAY_ASSET_VERSION, type ReplayData, type ReplayEvent, type ReplaySummary } from '../shared/replay';
import type { Transport } from '../src/core/transport';
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const silent = { play: async (_text: string, _signal: AbortSignal, start: () => void) => start(), stop() {} };
const engine = () => new ConversationEngine({ turn: async () => { throw Error('No model calls expected'); }, cancel: async () => {} }, silent);
const frame = () => replayFrame(engine().getSnapshot());
const id = '77777777-7777-4777-8777-777777777777';
const summary = (overrides: Partial<ReplaySummary> = {}): ReplaySummary => ({ id, createdAt: 1, status: 'recording', count: 1, turns: 0, durationMs: 0, assetVersion: REPLAY_ASSET_VERSION, ...overrides });
const event = (sequence: number, atMs = sequence * 100): ReplayEvent => ({ sequence, atMs, turnId: 1, type: 'subtitle.started', frame: { ...frame(), subtitle: '可见对白' + sequence } });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('SQLite replay event ownership, ordering and retention', () => {
  it('stores ordered snapshots atomically, accepts identical retries and refuses conflicting/late events', () => {
    const db = new AppDatabase(':memory:'), repository = new ReplayRepository(db);
    try {
      const owner = db.createVisitor('one'), other = db.createVisitor('two');
      repository.create(owner, ':mock', id, frame());
      repository.append(owner, ':mock', id, [event(1), event(2)]);
      repository.append(owner, ':mock', id, [event(1), event(2)]);
      expect(repository.read(owner, ':mock', id)?.events).toHaveLength(3);
      expect(repository.read(other, ':mock', id)).toBeUndefined();
      expect(repository.read(owner, ':deepseek', id)).toBeUndefined();
      expect(() => repository.append(owner, ':mock', id, [event(3), event(5)])).toThrow(StorageConflict);
      expect(repository.read(owner, ':mock', id)?.events).toHaveLength(3);
      expect(() => repository.append(owner, ':mock', id, [{ ...event(1), frame: { ...frame(), subtitle: '被篡改' } }])).toThrow(StorageConflict);
      expect(() => repository.append(owner, ':mock', id, [event(3, 10)])).toThrow(StorageConflict);
      repository.stop(owner, ':mock', id);
      expect(() => repository.append(owner, ':mock', id, [event(3)])).toThrow(StorageConflict);
      expect(repository.append(owner, ':mock', id, [event(2)])?.status).toBe('stopped');
      expect(repository.delete(other, ':mock', id)).toBe(false);
      expect(repository.delete(owner, ':mock', id)).toBe(true);
      expect(db.sql.prepare('SELECT count(*) AS count FROM replay_events').get()?.count).toBe(0);
    } finally { db.close(); }
  });

  it('retains five recordings, closes an old active recording and limits event/turn counts', () => {
    const db = new AppDatabase(':memory:'), repository = new ReplayRepository(db);
    try {
      const owner = db.createVisitor('one');
      for (let i = 0; i < 7; i++) repository.create(owner, ':mock', `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`, frame());
      const records = repository.list(owner, ':mock');
      expect(records).toHaveLength(5); expect(records.filter(item => item.status === 'recording')).toHaveLength(1);
      const current = records.find(item => item.status === 'recording')!;
      db.sql.prepare('UPDATE recordings SET event_count=999 WHERE id=?').run(current.id);
      expect(repository.append(owner, ':mock', current.id, [event(999)])?.status).toBe('limit');
      expect(() => repository.append(owner, ':mock', current.id, [event(1000)])).toThrow(StorageConflict);
      repository.create(owner, ':mock', id, frame());
      db.sql.prepare('UPDATE recordings SET turn_count=50 WHERE id=?').run(id);
      expect(() => repository.append(owner, ':mock', id, [{ ...event(1), type: 'input.accepted' }])).toThrow(StorageConflict);
    } finally { db.close(); }
  });

  it('serves replays without invoking a provider and rejects hidden drafts and another browser', async () => {
    const db = new AppDatabase(':memory:'), provider = new MockProvider(), reply = vi.spyOn(provider, 'reply');
    const app = buildApp(provider, 18000, undefined, undefined, { basePath: '' }, 'key', db);
    const headers = { origin: 'http://localhost', host: 'localhost' };
    try {
      const boot = await app.inject({ url: '/api/progress', headers });
      const cookie = boot.cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const send = (url: string, payload?: object) => app.inject({ url, method: payload ? 'POST' : 'GET', headers: { ...headers, cookie }, payload });
      expect((await send('/api/replays', { id, frame: { ...frame(), streamingText: '未校验秘密' } })).statusCode).toBe(400);
      expect((await send('/api/replays', { id, frame: frame() })).statusCode).toBe(200);
      expect((await send('/api/replays/' + id + '/events', { events: [event(1)] })).statusCode).toBe(200);
      expect((await send('/api/replays/' + id)).json().events).toHaveLength(2);
      expect((await app.inject({ url: '/api/replays/' + id, headers })).statusCode).toBe(404);
      const cross = await app.inject({ url: '/api/replays', method: 'POST', headers: { ...headers, cookie, origin: 'http://evil.test' }, payload: { id, frame: frame() } });
      expect(cross.statusCode).toBe(403); expect(reply).not.toHaveBeenCalled();
    } finally { await app.close(); db.close(); }
  });
});

describe('explicit recording and read-only player', () => {
  function api() {
    return { list: vi.fn(async () => []), create: vi.fn(async () => summary()), append: vi.fn(async () => summary()), stop: vi.fn(async () => {}), read: vi.fn(), delete: vi.fn(async () => {}) } satisfies ReplayApi;
  }
  it('does not record before explicit start, captures displayed events in order and flushes before stopping', async () => {
    vi.useFakeTimers(); let now = 0;
    const service = api(), recorder = new ReplayRecorder(service, () => now);
    recorder.capture('subtitle.started', 1, frame()); expect(service.append).not.toHaveBeenCalled();
    await recorder.start(frame()); now = 40; recorder.capture('input.accepted', 1, frame());
    now = 80; recorder.capture('subtitle.started', 1, { ...frame(), subtitle: '已经显示', streamingText: '不应保存' } as any);
    const stop = recorder.stop(); await flush(); await stop;
    expect(service.append).toHaveBeenCalledOnce();
    const recorded = service.append.mock.calls[0] as unknown as [string, ReplayEvent[]];
    expect(recorded[1].map(item => item.sequence)).toEqual([1, 2]);
    expect(recorded[1].map(item => item.atMs)).toEqual([40, 80]);
    expect(JSON.stringify(recorded)).not.toContain('不应保存');
    expect(service.stop).toHaveBeenCalledOnce();
    recorder.capture('subtitle.started', 2, frame()); await vi.advanceTimersByTimeAsync(1000);
    expect(service.append).toHaveBeenCalledOnce();
  });

  it('stops recording on persistence failure and closes a start that finishes after page cleanup', async () => {
    vi.useFakeTimers(); const service = api(), recorder = new ReplayRecorder(service);
    service.append.mockRejectedValueOnce(Error('保存失败'));
    await recorder.start(frame()); recorder.capture('turn.failed', 1, frame()); await vi.advanceTimersByTimeAsync(250);
    expect(recorder.getSnapshot()).toMatchObject({ recording: false, saving: false, notice: '保存失败' });
    let finish!: (value: ReplaySummary) => void;
    service.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const start = recorder.start(frame()); recorder.suspend(); finish(summary()); await start;
    expect(recorder.getSnapshot().recording).toBe(false); expect(service.stop).toHaveBeenCalledOnce();
  });

  it('plays recorded frames, pauses and seeks without any transport or paid request', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const data = replayDataSchema.parse({ schemaVersion: 1, recording: summary({ status: 'stopped', count: 3, durationMs: 200 }), events: [event(0), event(1), { ...event(2), type: 'turn.cancelled', frame: { ...frame(), status: 'idle', subtitle: '' } }] });
    const original = JSON.stringify(data), player = new ReplayPlayer(data);
    player.play(); await vi.advanceTimersByTimeAsync(100); expect(player.getSnapshot().index).toBe(1);
    player.pause(); await vi.advanceTimersByTimeAsync(1000); expect(player.getSnapshot().index).toBe(1);
    player.seek(2); expect(player.data.events[player.getSnapshot().index].type).toBe('turn.cancelled');
    player.seek(-20); expect(player.getSnapshot().index).toBe(0);
    player.play(); await vi.advanceTimersByTimeAsync(200); expect(player.getSnapshot()).toEqual({ index: 2, playing: false });
    player.dispose(); expect(fetcher).not.toHaveBeenCalled(); expect(JSON.stringify(data)).toBe(original);
  });

  it('observes real engine starts, acknowledgements and cancellation without recording model previews or late callbacks', async () => {
    let start!: () => void, finish!: () => void;
    const model = vi.fn(async (_request, _signal, onText) => {
      onText?.('模型草稿不可记录');
      return { turnId: 1, provider: 'mock' as const, segments: [{ text: '第一句。第二句。', emotion: 'curious' as const, action: 'idle' as const }] };
    });
    const transport: Transport = { turn: model, cancel: vi.fn(async () => {}) };
    const live = new ConversationEngine(transport, { play: async (_text, signal, callback) => {
      start = callback; await new Promise<void>(resolve => { finish = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); });
    }, stop() {} });
    const events: ReplayEvent[] = [];
    live.onPresentation((type, turnId, snapshot) => events.push({ sequence: events.length, atMs: events.length, type, turnId, frame: replayFrame(snapshot) }));
    const work = live.submit('你好'); await flush();
    expect(events.map(item => item.type)).toEqual(['input.accepted', 'reply.started']);
    start(); expect(events.at(-1)?.type).toBe('subtitle.started');
    live.interrupt(); await work;
    const count = events.length; start(); finish(); await flush();
    expect(events).toHaveLength(count); expect(events.at(-1)?.type).toBe('turn.cancelled');
    expect(events.some(item => item.type === 'presentation.confirmed')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('模型草稿不可记录');
    expect(live.getSnapshot().completed).toBe(0);
  });

  it('renders a closed management dialog and does not create records during rendering', () => {
    const service = api(), recorder = new ReplayRecorder(service);
    const html = renderToStaticMarkup(<ReplayPanel api={service} recorder={recorder} snapshot={engine().getSnapshot()} busy={false} />);
    expect(html).toContain('打开剧情轨迹与回放'); expect(html).not.toMatch(/<dialog[^>]*\bopen/);
    expect(html).toContain('默认无声回放'); expect(service.create).not.toHaveBeenCalled(); expect(service.list).not.toHaveBeenCalled();
  });
});
