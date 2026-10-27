import { appPath } from './app-path';
import { isAbort } from '../../shared/async';
import { REPLAY_MAX_EVENTS, REPLAY_MAX_TURNS, replayDataSchema, replayFrame, replaySummarySchema, type ReplayData, type ReplayEvent, type ReplayEventType, type ReplayFrame, type ReplaySummary } from '../../shared/replay';

export interface ReplayApi {
  list(): Promise<ReplaySummary[]>;
  create(id: string, frame: ReplayFrame): Promise<ReplaySummary>;
  append(id: string, events: ReplayEvent[]): Promise<ReplaySummary>;
  stop(id: string): Promise<void>;
  read(id: string): Promise<ReplayData>;
  delete(id: string): Promise<void>;
}
export class HttpReplayApi implements ReplayApi {
  private async request(path: string, method = 'GET', body?: unknown) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 6000);
      try {
        const response = await fetch(appPath('api/replays' + path), {
          method, signal: controller.signal, keepalive: method !== 'GET',
          ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) {
          if (response.status >= 500 && attempt === 0) continue;
          throw new Error(response.status === 401 ? '邀请已过期，请刷新后重新进入。' : '轨迹暂时无法保存或读取，请重新打开面板。');
        }
        return await response.json();
      } catch (error) {
        const networkFailure = isAbort(error) || error instanceof TypeError;
        if (attempt === 0 && networkFailure) continue;
        if (networkFailure) throw new Error('轨迹连接超时或网络不可用，请重新打开面板后重试。');
        throw error;
      } finally { clearTimeout(timer); }
    }
    throw new Error('轨迹连接失败，请重试。');
  }
  async list() { const data = await this.request(''); return replaySummarySchema.array().parse(data.recordings); }
  async create(id: string, frame: ReplayFrame) { return replaySummarySchema.parse((await this.request('', 'POST', { id, frame })).recording); }
  async append(id: string, events: ReplayEvent[]) { return replaySummarySchema.parse((await this.request('/' + id + '/events', 'POST', { events })).recording); }
  async stop(id: string) { await this.request('/' + id + '/stop', 'POST'); }
  async read(id: string) { return replayDataSchema.parse(await this.request('/' + id)); }
  async delete(id: string) { await this.request('/' + id, 'DELETE'); }
}

export type RecorderState = { recording: boolean; saving: boolean; notice: string; count: number };
export class ReplayRecorder {
  private snapshot: RecorderState = { recording: false, saving: false, notice: '', count: 0 };
  private listeners = new Set<() => void>();
  private id?: string;
  private startedAt = 0;
  private sequence = 1;
  private turns = 0;
  private buffer: ReplayEvent[] = [];
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  constructor(private api: ReplayApi, private now = () => performance.now()) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<RecorderState>) {
    this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener();
  }
  async start(frame: ReplayFrame) {
    if (this.snapshot.recording || this.snapshot.saving) return;
    this.update({ saving: true, notice: '' });
    const generation = ++this.generation;
    const id = crypto.randomUUID();
    try {
      const recording = await this.api.create(id, replayFrame(frame));
      if (generation !== this.generation) { await this.api.stop(id); return; }
      if (recording.status !== 'recording') throw new Error('记录已结束，请重新开始。');
      this.id = id; this.startedAt = this.now(); this.sequence = 1; this.turns = 0; this.buffer = []; this.queue = Promise.resolve();
      this.update({ recording: true, saving: false, count: 1 });
    } catch (error) { if (generation === this.generation) this.update({ saving: false, notice: error instanceof Error ? error.message : '无法开始记录。' }); }
  }
  capture(type: ReplayEventType, turnId: number, frame: ReplayFrame) {
    if (!this.snapshot.recording || !this.id) return;
    if (this.sequence >= REPLAY_MAX_EVENTS || (type === 'input.accepted' && this.turns >= REPLAY_MAX_TURNS) || this.now() - this.startedAt > 86_400_000) {
      void this.stop('已达到记录上限，本段已停止保存。'); return;
    }
    if (type === 'input.accepted') this.turns++;
    this.buffer.push({ sequence: this.sequence++, atMs: Math.max(0, this.now() - this.startedAt), turnId, type, frame: replayFrame(frame) });
    this.update({ count: this.sequence });
    if (this.buffer.length >= 10) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 200);
  }
  private flush() {
    clearTimeout(this.timer); this.timer = undefined;
    const id = this.id;
    if (!id || !this.buffer.length) return;
    const events = this.buffer.splice(0, 10);
    this.queue = this.queue.then(async () => {
      if (this.id !== id) return;
      await this.api.append(id, events);
    }).catch(error => {
      if (this.id !== id) return;
      this.id = undefined; this.buffer = [];
      this.update({ recording: false, saving: false, notice: error instanceof Error ? error.message : '轨迹保存失败，已停止记录；仍可继续对话。' });
    });
    if (this.buffer.length) this.flush();
  }
  async stop(notice = '本段已保存，可以打开轨迹回放。') {
    const id = this.id;
    if (!id || this.snapshot.saving) return;
    this.update({ recording: false, saving: true });
    this.flush(); await this.queue;
    if (this.id !== id) return;
    try { await this.api.stop(id); this.id = undefined; this.update({ saving: false, notice }); }
    catch (error) { this.id = undefined; this.update({ saving: false, notice: error instanceof Error ? error.message : '结束记录失败，已保存的片段仍可查看。' }); }
  }
  suspend() {
    this.generation++;
    if (this.snapshot.recording) void this.stop();
    else if (!this.id) this.update({ saving: false });
  }
}

export type PlayerState = { index: number; playing: boolean };
export class ReplayPlayer {
  private snapshot: PlayerState = { index: 0, playing: false };
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(readonly data: ReplayData) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<PlayerState>) { this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener(); }
  seek(index: number) {
    this.pause(); this.update({ index: Number.isFinite(index) ? Math.max(0, Math.min(this.data.events.length - 1, Math.trunc(index))) : 0 });
  }
  pause() { clearTimeout(this.timer); this.update({ playing: false }); }
  play() {
    if (this.snapshot.playing) return;
    if (this.snapshot.index === this.data.events.length - 1) this.update({ index: 0 });
    this.update({ playing: true }); this.schedule();
  }
  private schedule() {
    if (!this.snapshot.playing) return;
    const next = this.snapshot.index + 1;
    if (next >= this.data.events.length) { this.pause(); return; }
    const delay = Math.max(0, this.data.events[next].atMs - this.data.events[this.snapshot.index].atMs);
    this.timer = setTimeout(() => { this.update({ index: next }); this.schedule(); }, delay);
  }
  dispose() { this.pause(); this.listeners.clear(); }
}
