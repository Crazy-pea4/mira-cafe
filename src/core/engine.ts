import type { Action, CharacterStatus, Emotion, Fault, History, Scene } from '../../shared/protocol';
import { turnResponseSchema, REPLY_TEXT_ONLY_NOTICE } from '../../shared/protocol';
import { delay, isAbort } from '../../shared/async';
import type { AudioPlayer } from './audio';
import type { Transport } from './transport';
export interface Snapshot {
  presentation: 'none' | 'simulated' | 'audio-clock'; status: CharacterStatus; turnId: number; subtitle: string; emotion: Emotion; action: Action;
  scene: Scene; photo: boolean; error: string; notice: string; lastInput: string; completed: number;
}
const INITIAL: Snapshot = { presentation: 'none', status: 'idle', turnId: 0, subtitle: '雨还没停。要不要坐一会儿？', emotion: 'guarded', action: 'idle', scene: 'rain', photo: false, error: '', notice: '', lastInput: '', completed: 0 };
export class ConversationEngine {
  private snapshot: Snapshot = { ...INITIAL };
  private listeners = new Set<() => void>();
  private controller?: AbortController;
  private history: History = [];
  constructor(private transport: Transport, private audio: AudioPlayer, readonly sessionId: string = crypto.randomUUID(), private fallbackMs = (text: string) => Math.max(1800, text.length * 110)) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<Snapshot>) { this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener(); }
  interrupt(listening = false) {
    const previous = this.snapshot.turnId;
    // Invalidate synchronously before abort callbacks or any network work can run.
    this.update({ presentation: 'none', turnId: previous + 1, status: listening ? 'listening' : 'idle', subtitle: '', action: 'idle', error: '', notice: '' });
    this.controller?.abort(); this.controller = undefined; this.audio.stop();
    if (previous) void this.transport.cancel(this.sessionId, previous).catch(() => {});
  }
  inputNotice(message: string) { this.update({ status: 'idle', action: 'idle', subtitle: '', notice: message, error: '' }); }
  endListening() { if (this.snapshot.status === 'listening') this.update({ status: 'idle' }); }
  async submit(text: string, fault: Fault = 'none') {
    const trimmed = text.trim(); if (!trimmed || trimmed.length > 800) return;
    this.interrupt();
    const turnId = this.snapshot.turnId;
    const controller = new AbortController(); this.controller = controller;
    const signal = controller.signal;
    const current = () => this.snapshot.turnId === turnId && !signal.aborted;
    this.update({ status: 'thinking', lastInput: trimmed });
    const priorHistory = this.history.slice(-12);
    this.history.push({ role: 'user', content: trimmed });
    try {
      const parsed = turnResponseSchema.safeParse(await this.transport.turn({ sessionId: this.sessionId, turnId, text: trimmed, history: priorHistory, fault }, signal));
      if (!parsed.success) throw new Error('角色回复格式异常，请重试。');
      const response = parsed.data;
      const replyNotice = response.notice === 'REPLY_TEXT_ONLY' ? REPLY_TEXT_ONLY_NOTICE : '';
      if (!current()) return;
      if (response.turnId !== turnId) throw new Error('收到不匹配的回复，请重试。');
      this.update({ notice: replyNotice });
      for (const segment of response.segments) {
        const sentences = segment.text.match(/[^。！？!?]+[。！？!?]?/g) ?? [segment.text];
        for (let index = 0; index < sentences.length; index++) {
          if (!current()) return;
          const sentence = sentences[index];
          const present = (presentation: Snapshot['presentation'] = 'audio-clock') => {
            if (!current()) return;
            this.update({
              presentation, status: 'speaking', subtitle: sentence, emotion: segment.emotion, action: segment.action,
              ...(index === 0 && segment.scene ? { scene: segment.scene } : {}),
              ...(index === 0 && segment.event === 'reveal-photo' ? { photo: true } : {}),
            });
          };
          try { await this.audio.play(sentence, signal, () => present(), { turnId }); }
          catch (error) {
            if (!current() || isAbort(error)) return;
            present('simulated');
            this.update({ notice: [replyNotice, '当前使用字幕演出（声音已关闭或语音暂时不可用）。'].filter(Boolean).join(' ') });
            await delay(this.fallbackMs(sentence), signal);
          }
          if (!current()) return;
          // Only fully presented sentences enter the next turn's history.
          this.history.push({ role: 'assistant', content: sentence });
        }
      }
      if (current()) this.update({ presentation: 'none', status: 'idle', action: 'idle', completed: this.snapshot.completed + 1 });
    } catch (error) {
      if (!current() || isAbort(error)) return;
      this.update({ status: 'error', subtitle: '', action: 'idle', error: error instanceof Error ? error.message : '连接失败，请重试。' });
    } finally {
      this.history = this.history.slice(-12);
      if (this.controller === controller) this.controller = undefined;
    }
  }
  retry() { return this.submit(this.snapshot.lastInput, 'none'); }
  reset() { this.interrupt(); this.history = []; this.update({ ...INITIAL, turnId: this.snapshot.turnId }); }
  dispose() { this.interrupt(); this.listeners.clear(); }
}

