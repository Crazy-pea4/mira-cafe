import { abortError } from '../../shared/async';
export interface AudioPlayer { play(text: string, signal: AbortSignal, onStart: () => void, identity?: { turnId: number }): Promise<void>; stop(): void; }
export class BrowserSpeech implements AudioPlayer {
  private currentCancel?: () => void;
  // Consent is session-local: loading/reloading the app can never enable sound.
  muted = true;
  failNext = false;
  play(text: string, signal: AbortSignal, onStart: () => void): Promise<void> {
    if (this.failNext) { this.failNext = false; return Promise.reject(new Error('Simulated audio failure')); }
    if (this.muted || !('speechSynthesis' in window)) return Promise.reject(new Error('Speech unavailable'));
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN'; utterance.rate = 1.05; utterance.pitch = 1.05;
      const voices = speechSynthesis.getVoices();
      const voice = voices.find(v => /^zh[-_]CN/i.test(v.lang)) ?? voices.find(v => /^zh/i.test(v.lang));
      if (voice) utterance.voice = voice;
      let done = false;
      const finish = (error?: Error) => {
        if (done) return; done = true;
        clearTimeout(timer); signal.removeEventListener('abort', cancel);
        utterance.onstart = null; utterance.onend = null; utterance.onerror = null;
        if (this.currentCancel === cancel) this.currentCancel = undefined;
        error ? reject(error) : resolve();
      };
      const cancel = () => { finish(abortError()); speechSynthesis.cancel(); };
      const timer = setTimeout(() => { finish(new Error('Speech timed out')); speechSynthesis.cancel(); }, Math.max(9000, text.length * 500));
      signal.addEventListener('abort', cancel, { once: true }); this.currentCancel = cancel;
      utterance.onstart = () => { if (!signal.aborted) onStart(); };
      utterance.onend = () => finish();
      utterance.onerror = () => finish(new Error('Speech failed'));
      try { speechSynthesis.speak(utterance); } catch { finish(new Error('Speech unavailable')); }
    });
  }
  stop() { this.currentCancel?.(); if ('speechSynthesis' in window) speechSynthesis.cancel(); }
}

