import { MicrophoneCapture } from './microphone';
import type { BrowserAsr, SpeechTransport } from './speech-transport';
import { MAX_RECORDING_BYTES, MIN_RECORDING_BYTES } from '../../shared/speech-protocol';
import { isAbort } from '../../shared/async';
import { normalizeTranscript } from '../../shared/transcript';
type Callbacks = { text: (value: string) => void; error: (message: string) => void; state: (message: string) => void };
export class VoiceInput {
  private operation?: { controller: AbortController; ready: boolean; asr?: BrowserAsr; callbacks: Callbacks; timer?: ReturnType<typeof setTimeout>; bytes: number };
  constructor(private transport: SpeechTransport, private capture = new MicrophoneCapture()) {}
  async start(turnId: number, callbacks: Callbacks) {
    this.cancel();
    const op = { controller: new AbortController(), ready: false, callbacks, bytes: 0 } as NonNullable<VoiceInput['operation']>;
    this.operation = op;
    const current = () => this.operation === op && !op.controller.signal.aborted;
    const pending: Uint8Array[] = [];
    callbacks.state('正在准备麦克风；首次使用需要浏览器授权。');
    const fail = (message: string) => { if (current()) { this.cancel(); callbacks.error(message); } };
    try {
      await this.capture.start(pcm => {
        if (!current()) return;
        op.bytes += pcm.length;
        if (op.bytes > MAX_RECORDING_BYTES) { fail('一次录音最多 30 秒，请分段说。'); return; }
        try { if (op.ready) op.asr!.append(pcm); else pending.push(pcm); } catch { fail('录音发送中断，请重新录制。'); }
      }, op.controller.signal);
      if (!current()) return;
      op.timer = setTimeout(() => fail('录音已达到 30 秒上限，请重新分段录制。'), 30000);
      op.asr = this.transport.openAsr(turnId, op.controller.signal); await op.asr.ready;
      if (!current()) return;
      for (const pcm of pending) op.asr.append(pcm);
      op.ready = true; callbacks.state('正在录音并发送到 Qwen；松开停止并识别。');
    } catch (error) { if (!isAbort(error)) fail(error instanceof Error ? error.message : '无法开始录音，请重试。'); }
  }
  async finish() {
    const op = this.operation; if (!op) return;
    if (!op.ready) { this.cancel(); op.callbacks.error('录音尚未就绪。完成授权后，请再次按住说话。'); return; }
    clearTimeout(op.timer);
    try {
      await this.capture.finish();
      if (this.operation !== op || op.controller.signal.aborted) return;
      if (op.bytes < MIN_RECORDING_BYTES) { this.cancel(); op.callbacks.error('录音太短，请按住再说一句。'); return; }
      op.callbacks.state('录音已停止，正在识别……');
      const text = await op.asr!.commit();
      if (this.operation !== op || op.controller.signal.aborted) return;
      const transcript = normalizeTranscript(text);
      this.cancel(); op.callbacks.text(transcript);
    } catch (error) { if (this.operation === op && !isAbort(error)) { this.cancel(); op.callbacks.error(error instanceof Error ? error.message : '识别失败，请重新录制。'); } }
  }
  cancel() { const op = this.operation; this.operation = undefined; if (op) { clearTimeout(op.timer); op.controller.abort(); } this.capture.cancel(); }
}
