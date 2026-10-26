import { abortError } from '../../shared/async';
export const AUDIO_BLOCKED_NOTICE = '浏览器限制了声音，请点一下页面后继续；当前保留字幕。';
export class AudioPlaybackBlocked extends Error {
  constructor() {
    super(AUDIO_BLOCKED_NOTICE);
  }
}
export interface AudioPlayer {
  play(
    text: string,
    signal: AbortSignal,
    onStart: () => void,
    identity?: { turnId: number },
  ): Promise<void>;
  stop(): void;
}
export class BrowserSpeech implements AudioPlayer {
  private currentCancel?: () => void;
  // Replies are audible by default; user activation is still required by browsers.
  private activated = false;
  unlock() {
    this.activated = true;
  }
  dispose() {
    this.activated = false;
    this.stop();
  }
  failNext = false;
  play(text: string, signal: AbortSignal, onStart: () => void): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('Simulated audio failure'));
    }
    if (!this.activated) return Promise.reject(new AudioPlaybackBlocked());
    if (!('speechSynthesis' in window)) return Promise.reject(new Error('Speech unavailable'));
    const synthesis = window.speechSynthesis;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = 1.05;
      utterance.pitch = 1.05;
      const voices = synthesis.getVoices();
      const voice =
        voices.find((v) => /^zh[-_]CN/i.test(v.lang)) ?? voices.find((v) => /^zh/i.test(v.lang));
      if (voice) utterance.voice = voice;
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        utterance.onstart = null;
        utterance.onend = null;
        utterance.onerror = null;
        if (this.currentCancel === cancel) this.currentCancel = undefined;
        error ? reject(error) : resolve();
      };
      const cancel = () => {
        finish(abortError());
        synthesis.cancel();
      };
      const timer = setTimeout(
        () => {
          finish(new Error('Speech timed out'));
          synthesis.cancel();
        },
        Math.max(9000, text.length * 500),
      );
      signal.addEventListener('abort', cancel, { once: true });
      this.currentCancel = cancel;
      utterance.onstart = () => {
        if (!done && !signal.aborted) onStart();
      };
      utterance.onend = () => finish();
      utterance.onerror = (event) =>
        finish(
          event.error === 'not-allowed' ? new AudioPlaybackBlocked() : new Error('Speech failed'),
        );
      try {
        synthesis.speak(utterance);
      } catch (error) {
        finish(
          error instanceof DOMException && error.name === 'NotAllowedError'
            ? new AudioPlaybackBlocked()
            : new Error('Speech unavailable'),
        );
      }
    });
  }
  stop() {
    this.currentCancel?.();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window)
      window.speechSynthesis.cancel();
  }
}
