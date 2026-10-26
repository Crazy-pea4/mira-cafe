import { isAbort } from '../../shared/async';
import { normalizeTranscript, TranscriptError } from '../../shared/transcript';
import { MAX_RECORDING_BYTES } from '../../shared/speech-protocol';
import { MicrophoneCapture } from './microphone';
import { SpeechTransportError, type BrowserAsr, type SpeechTransport } from './speech-transport';
import { VoiceActivityDetector, isBriefAcknowledgement } from './voice-activity';

export type VoiceCallState = {
  active: boolean;
  phase: 'off' | 'connecting' | 'listening' | 'recording' | 'recognizing' | 'error';
  message: string;
  startedAt: number | null;
};
type Callbacks = {
  turnId: () => number;
  responding: () => boolean;
  begin: () => void;
  text: (text: string) => void;
  end: () => void;
  stop: () => void;
};
type Utterance = {
  controller: AbortController;
  asr: BrowserAsr;
  ready: boolean;
  pending: Uint8Array[];
  bytes: number;
  responding: boolean;
  interrupted: boolean;
  finishing: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
export class VoiceCall {
  private snapshot: VoiceCallState = { active: false, phase: 'off', message: '', startedAt: null };
  private listeners = new Set<() => void>();
  private controller?: AbortController;
  private callbacks?: Callbacks;
  private utterance?: Utterance;
  private detector = new VoiceActivityDetector();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private transport: SpeechTransport,
    private capture = new MicrophoneCapture(),
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<VoiceCallState>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  async start(callbacks: Callbacks) {
    if (this.snapshot.active) return;
    this.stop();
    this.callbacks = callbacks;
    const controller = new AbortController();
    this.controller = controller;
    this.update({ active: true, phase: 'connecting', message: '请允许麦克风，正在接通…' });
    const current = () => this.controller === controller && !controller.signal.aborted;
    this.timer = setTimeout(() => {
      if (current()) this.fail('麦克风连接超时，通话已结束。点击电话可重新连接。');
    }, 15000);
    try {
      await this.capture.start(
        (pcm) => { if (current()) this.receive(pcm); },
        controller.signal,
        () => { if (current()) this.fail('麦克风连接中断，通话已结束。请检查设备后重新连接。'); },
      );
      if (!current()) return;
      clearTimeout(this.timer);
      this.update({ phase: 'listening', message: '', startedAt: Date.now() });
    } catch (error) {
      if (current() && !isAbort(error))
        this.fail(error instanceof Error ? error.message : '无法使用麦克风，请检查权限后重新连接。');
    }
  }
  private receive(pcm: Uint8Array) {
    const callbacks = this.callbacks;
    if (!callbacks || !this.snapshot.active) return;
    for (const event of this.detector.push(pcm, callbacks.responding())) {
      if (!this.snapshot.active) break;
      if (event.type === 'start') this.open(event.frames, event.responding);
      if (event.type === 'audio') this.append(event.pcm);
      if (event.type === 'interrupt' && this.utterance && !this.utterance.finishing) {
        this.utterance.interrupted = true;
        callbacks.begin();
      }
      if (event.type === 'end') void this.finish(event.speechMs);
    }
  }
  private open(frames: Uint8Array[], responding: boolean) {
    this.clearUtterance();
    const callbacks = this.callbacks!;
    const controller = new AbortController();
    try {
      const op: Utterance = {
        controller,
        asr: this.transport.openAsr(Math.max(1, callbacks.turnId()), controller.signal),
        ready: false, pending: [], bytes: 0, responding, interrupted: !responding, finishing: false,
      };
      this.utterance = op;
      if (!responding) callbacks.begin();
      this.update({ phase: 'recording', message: '' });
      for (const frame of frames) this.append(frame);
      if (!this.current(op)) return;
      op.timer = setTimeout(() => {
        if (this.utterance === op) this.fail('语音连接超时，通话已结束。点击电话可重新连接。');
      }, 8000);
      void op.asr.ready.then(() => {
        if (!this.current(op)) return;
        if (!op.finishing) clearTimeout(op.timer);
        op.ready = true;
        try {
          for (const frame of op.pending) op.asr.append(frame);
          op.pending = [];
        } catch { this.fail('录音发送中断，通话已结束。请重新连接。'); }
      }, (error) => { if (this.current(op) && !isAbort(error)) this.fail('语音连接中断，通话已结束。点击电话可重新连接。'); });
    } catch {
      controller.abort();
      this.fail('无法连接语音服务，通话已结束。点击电话可重新连接。');
    }
  }
  private current(op: Utterance) {
    return this.utterance === op && this.snapshot.active && !op.controller.signal.aborted;
  }
  private append(pcm: Uint8Array) {
    const op = this.utterance;
    if (!op || op.finishing) return;
    op.bytes += pcm.length;
    if (op.bytes > MAX_RECORDING_BYTES) {
      this.fail('这一句太长，通话已结束。请重新连接并分段说。');
      return;
    }
    try {
      if (op.ready) op.asr.append(pcm);
      else op.pending.push(pcm.slice());
    } catch { this.fail('录音发送中断，通话已结束。请重新连接。'); }
  }
  private async finish(speechMs: number) {
    const op = this.utterance;
    if (!op || op.finishing) return;
    op.finishing = true;
    this.update({ phase: 'recognizing' });
    clearTimeout(op.timer);
    op.timer = setTimeout(() => {
      if (this.current(op)) this.fail('语音识别超时，通话已结束。请重新连接再说一次。');
    }, 12000);
    try {
      await op.asr.ready;
      if (!this.current(op)) return;
      const text = normalizeTranscript(await op.asr.commit());
      if (!this.current(op)) return;
      const callbacks = this.callbacks!;
      if (op.responding && !op.interrupted && isBriefAcknowledgement(text, speechMs)) {
        this.clearUtterance();
        this.update({ phase: 'listening' });
        return;
      }
      if (!op.interrupted) callbacks.begin();
      this.clearUtterance();
      this.update({ phase: 'listening' });
      callbacks.text(text);
    } catch (error) {
      if (!this.current(op) || isAbort(error)) return;
      if ((error instanceof TranscriptError || error instanceof SpeechTransportError) && error.code === 'EMPTY_TRANSCRIPT') {
        this.clearUtterance();
        this.callbacks?.end();
        this.update({ phase: 'listening', message: '刚才没听清，直接再说一次吧。' });
      } else this.fail('这句话未能识别，通话已结束。请重新连接，或使用按住说话。');
    }
  }
  private clearUtterance() {
    const op = this.utterance;
    this.utterance = undefined;
    if (op) {
      clearTimeout(op.timer);
      op.controller.abort();
    }
  }
  clearInput() {
    this.clearUtterance();
    this.detector.reset();
    if (this.snapshot.active && this.snapshot.phase !== 'connecting') this.update({ phase: 'listening', message: '' });
  }
  blur() {
    // Permission UI can blur the page before capture has started.
    if (this.snapshot.active && this.snapshot.phase !== 'connecting')
      this.stop('页面失去焦点，已暂停收音。点击电话继续。', false);
  }
  private fail(message: string) {
    this.stop(message);
    this.update({ phase: 'error' });
  }
  stop(message = '', stopReply = true) {
    const callbacks = this.callbacks;
    this.callbacks = undefined;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = undefined;
    this.clearUtterance();
    this.capture.cancel();
    this.detector.reset();
    this.update({ active: false, phase: 'off', message, startedAt: null });
    callbacks?.end();
    if (stopReply) callbacks?.stop();
  }
}
