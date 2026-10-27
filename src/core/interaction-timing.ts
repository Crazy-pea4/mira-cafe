export type TimingKind = 'asr' | 'model' | 'tts' | 'playback';
export type TimingPoint = 'ready' | 'commit' | 'firstText' | 'firstAudio' | 'firstPlayback';
export type TimingStatus = 'running' | 'complete' | 'cancelled' | 'error';
export type TimingRecord = {
  id: number;
  kind: TimingKind;
  turnId?: number;
  mode: 'live' | 'mock' | 'unknown';
  status: TimingStatus;
  startedAt: number;
  elapsedMs?: number;
  points: Partial<Record<TimingPoint, number>>;
};
export type TimingSpan = {
  mark(point: TimingPoint): void;
  finish(status: Exclude<TimingStatus, 'running'>): void;
};

// Page-local numeric observations only. No prompts, transcripts, PCM or secrets.
// Handles to cleared/evicted/completed spans can never revive old observations.
export class InteractionTiming {
  private records: readonly TimingRecord[] = [];
  private listeners = new Set<() => void>();
  private nextId = 0;
  private modelMode: TimingRecord['mode'] = 'unknown';
  private speechMode: TimingRecord['mode'] = 'unknown';
  constructor(private now = () => performance.now()) {}
  getSnapshot = () => this.records;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  configure(modelLive: boolean, speechLive: boolean) {
    this.modelMode = modelLive ? 'live' : 'mock';
    this.speechMode = speechLive ? 'live' : 'mock';
  }
  clear = () => {
    this.records = [];
    this.publish();
  };
  private publish() {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* Observations must not break interaction. */ }
    }
  }
  begin(kind: TimingKind, turnId?: number): TimingSpan {
    const id = ++this.nextId, startedAt = this.now();
    this.records = [...this.records.slice(-19), {
      id, kind, turnId, startedAt, points: {}, status: 'running',
      mode: kind === 'model' ? this.modelMode : this.speechMode,
    }];
    this.publish();
    const update = (change: (record: TimingRecord) => TimingRecord) => {
      const index = this.records.findIndex(record => record.id === id);
      if (index < 0 || this.records[index].status !== 'running') return;
      const next = change(this.records[index]);
      if (next === this.records[index]) return;
      this.records = this.records.map((record, i) => i === index ? next : record);
      this.publish();
    };
    const elapsed = () => Math.max(0, this.now() - startedAt);
    return {
      mark: point => update(record => record.points[point] !== undefined ? record : {
        ...record, points: { ...record.points, [point]: elapsed() },
      }),
      finish: status => update(record => ({ ...record, status, elapsedMs: elapsed() })),
    };
  }
}

export function firstReplyAudioMs(records: readonly TimingRecord[], turnId: number) {
  const model = records.find(record => record.kind === 'model' && record.turnId === turnId);
  const playback = records.find(record => record.kind === 'playback' && record.turnId === turnId && record.points.firstPlayback !== undefined);
  if (!model || !playback) return undefined;
  return Math.max(0, playback.startedAt + playback.points.firstPlayback! - model.startedAt);
}
