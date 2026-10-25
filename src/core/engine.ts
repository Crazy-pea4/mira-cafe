import type { Action, CharacterStatus, Emotion, Fault, History, Reply, Scene } from '../../shared/protocol';
import { turnResponseSchema, REPLY_TEXT_ONLY_NOTICE } from '../../shared/protocol';
import { delay, isAbort } from '../../shared/async';
import { AudioPlaybackBlocked, AUDIO_BLOCKED_NOTICE, type AudioPlayer } from './audio';
import { STORY_OPENING, INITIAL_SUGGESTIONS, sentences, type StoryView } from '../../shared/story';
import type { Transport } from './transport';
export interface Snapshot {
  suggestions: string[]; story?: StoryView;
  presentation: 'none' | 'simulated' | 'audio-clock'; status: CharacterStatus; turnId: number; subtitle: string; emotion: Emotion; action: Action;
  scene: Scene; photo: boolean; error: string; notice: string; lastInput: string; completed: number;
}
const INITIAL: Snapshot = { suggestions:[...INITIAL_SUGGESTIONS], presentation: 'none', status: 'idle', turnId: 0, subtitle: STORY_OPENING, emotion: 'guarded', action: 'idle', scene: 'rain', photo: false, error: '', notice: '', lastInput: '', completed: 0 };
export class ConversationEngine {
  private snapshot: Snapshot = { ...INITIAL };
  private listeners = new Set<() => void>();
  private controller?: AbortController;
  private history: History = [];
  constructor(private transport: Transport, private audio: AudioPlayer, public sessionId: string = crypto.randomUUID(), private fallbackMs = (text: string) => Math.max(1800, text.length * 110)) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<Snapshot>) { this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener(); }
  interrupt(listening = false) {
    const previous = this.snapshot.turnId;
    // Invalidate synchronously before abort callbacks or any network work can run.
    this.update({ suggestions:[], presentation: 'none', turnId: previous + 1, status: listening ? 'listening' : 'idle', subtitle: '', action: 'idle', error: '', notice: '' });
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
    const userEntry: History[number] = { role: 'user', content: trimmed };
    let assistantEntry: History[number] | undefined;
    const heardSegments: Reply['segments'] = [];
    let presentedCount=0;
    try {
      const parsed = turnResponseSchema.safeParse(await this.transport.turn({ sessionId: this.sessionId, turnId, text: trimmed, history: priorHistory, fault }, signal));
      if (!parsed.success) throw new Error('角色回复格式异常，请重试。');
      const response = parsed.data;
      const replyNotice = response.notice === 'REPLY_TEXT_ONLY' ? REPLY_TEXT_ONLY_NOTICE : '';
      if (!current()) return;
      if (response.turnId !== turnId) throw new Error('收到不匹配的回复，请重试。');
      this.update({ notice: replyNotice });
      for (const segment of response.segments) {
        let heardSegment: Reply['segments'][number] | undefined;
        const parts = sentences(segment.text);
        for (let index = 0; index < parts.length; index++) {
          if (!current()) return;
          const sentence = parts[index];
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
            this.update({ notice: [replyNotice, error instanceof AudioPlaybackBlocked ? AUDIO_BLOCKED_NOTICE : '暂时无法播放语音，你可以继续看字幕。'].filter(Boolean).join(' ') });
            await delay(this.fallbackMs(sentence), signal);
          }
          if (!current()) return;
          // Only fully presented sentences enter the next turn's history.
          if (!heardSegment) { heardSegment = { ...segment, text: sentence }; heardSegments.push(heardSegment); }
          else heardSegment.text += sentence;
          // Keep a single JSON assistant message per turn, containing only fully
          // presented text and the validated directives that accompanied it.
          let retained = heardSegments.slice();
          let content = JSON.stringify({ segments: retained });
          while (content.length > 800 && retained.length > 1) { retained = retained.slice(1); content = JSON.stringify({ segments: retained }); }
          if (!assistantEntry) { assistantEntry = { role: 'assistant', content }; this.history.push(userEntry, assistantEntry); }
          else assistantEntry.content = content;
          presentedCount++;
          if(this.transport.presented){
            try{
              const receipt=await this.transport.presented({sessionId:this.sessionId,turnId,through:presentedCount});
              if(current())this.update({story:receipt.story,...(receipt.suggestions?{suggestions:[...receipt.suggestions]}:{})});
            }catch(error){
              if(current())this.update({presentation:'none',status:'idle',action:'idle',suggestions:[],notice:error instanceof Error?error.message:'对白暂时没有同步，请刷新重开。'});
              return;
            }
          }
        }
      }
      if (current()) this.update({ ...(!this.transport.presented&&response.suggestions?{suggestions:[...response.suggestions]}:{}), presentation: 'none', status: 'idle', action: 'idle', completed: this.snapshot.completed + 1 });
    } catch (error) {
      if (!current() || isAbort(error)) return;
      this.update({ status: 'error', subtitle: '', action: 'idle', error: error instanceof Error ? error.message : '连接失败，请重试。' });
    } finally {
      // Pending/failed user turns were never committed; neither rapid input
      // nor an explicit retry inherits a phantom unanswered exchange.
      this.history = this.history.slice(-12);
      if (this.controller === controller) this.controller = undefined;
    }
  }
  retry() { return this.submit(this.snapshot.lastInput, 'none'); }
  reset() { this.interrupt(); this.sessionId=crypto.randomUUID(); this.history = []; this.update({ ...INITIAL, turnId: this.snapshot.turnId }); }
  dispose() { this.interrupt(); this.listeners.clear(); }
}

