import { BrowserSpeech, type AudioPlayer } from './audio';
import { PcmSpeechPlayer } from './pcm-playback';
import { LocalSpeechTransport } from './speech-transport';
import { abortError } from '../../shared/async';
export class SceneAudio implements AudioPlayer {
  live = false;
  failNext = false;
  private pending?: Promise<void>;
  constructor(
    private browser = new BrowserSpeech(),
    private pcm = new PcmSpeechPlayer(new LocalSpeechTransport()),
  ) {}
  unlockFromGesture(): Promise<void> {
    this.browser.unlock();
    if (this.pcm.ready) return Promise.resolve();
    if (this.pending) return this.pending;
    // Prepare PCM even before health resolves, so a later live-provider result keeps activation.
    const task = this.pcm
      .unlock()
      .catch((error) => {
        if (this.live) throw error;
      })
      .finally(() => {
        if (this.pending === task) this.pending = undefined;
      });
    this.pending = task;
    return task;
  }
  async play(
    text: string,
    signal: AbortSignal,
    onStart: () => void,
    identity?: { turnId: number },
  ) {
    if (signal.aborted) throw abortError();
    if (this.live && this.pending) await this.pending;
    if (signal.aborted) throw abortError();
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('Simulated audio failure'));
    }
    return this.live
      ? this.pcm.play(text, identity?.turnId ?? 1, signal, onStart)
      : this.browser.play(text, signal, onStart);
  }
  stop() {
    this.browser.stop();
    this.pcm.stop();
  }
  dispose() {
    this.pending = undefined;
    this.browser.dispose();
    this.pcm.dispose();
  }
}
