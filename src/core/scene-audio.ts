import { BrowserSpeech, type AudioPlayer } from './audio';
import { PcmSpeechPlayer } from './pcm-playback';
import { LocalSpeechTransport } from './speech-transport';
import { abortError, isAbort } from '../../shared/async';
import type { InteractionTiming } from './interaction-timing';
export class SceneAudio implements AudioPlayer {
  live = false;
  failNext = false;
  private pending?: Promise<void>;
  constructor(
    private browser = new BrowserSpeech(),
    private pcm = new PcmSpeechPlayer(new LocalSpeechTransport()),
    private timing?: InteractionTiming,
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
    const timing = this.timing?.begin('playback', identity?.turnId);
    let settled = false, started = false;
    try {
      if (this.live && this.pending) await this.pending;
      if (signal.aborted) throw abortError();
      if (this.failNext) {
        this.failNext = false;
        throw new Error('Simulated audio failure');
      }
      const start = () => {
        if (settled || signal.aborted) return;
        started = true;
        timing?.mark('firstPlayback');
        onStart();
      };
      await (this.live
        ? this.pcm.play(text, identity?.turnId ?? 1, signal, start)
        : this.browser.play(text, signal, start));
      timing?.finish(signal.aborted ? 'cancelled' : started ? 'complete' : 'error');
    } catch (error) {
      timing?.finish(signal.aborted || isAbort(error) ? 'cancelled' : 'error');
      throw error;
    } finally {
      settled = true;
    }
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
