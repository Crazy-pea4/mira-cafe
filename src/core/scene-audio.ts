import { BrowserSpeech, type AudioPlayer } from './audio';
import { PcmSpeechPlayer } from './pcm-playback';
import { LocalSpeechTransport } from './speech-transport';
export class SceneAudio implements AudioPlayer {
  muted = true; live = false; failNext = false;
  private browser = new BrowserSpeech();
  private pcm = new PcmSpeechPlayer(new LocalSpeechTransport());
  async enable() {
    // Called only by the explicitly labeled sound button. Never from a lifecycle effect.
    if (this.live) await this.pcm.unlock();
    this.muted = false; this.browser.muted = false;
  }
  disable() { this.muted = true; this.browser.muted = true; this.stop(); void this.pcm.suspend().catch(() => {}); }
  play(text: string, signal: AbortSignal, onStart: () => void, identity?: { turnId: number }) {
    if (this.muted) return Promise.reject(new Error('Muted by user'));
    if (this.failNext) { this.failNext = false; return Promise.reject(new Error('Simulated audio failure')); }
    return this.live ? this.pcm.play(text, identity?.turnId ?? 1, signal, onStart) : this.browser.play(text, signal, onStart);
  }
  stop() { this.browser.stop(); this.pcm.stop(); }
}
