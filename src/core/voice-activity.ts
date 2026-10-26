// Local energy-based endpointing. Silence stays in this short rolling buffer;
// the existing ASR provider receives ordinary PCM only after speech starts.
export type VoiceActivity =
  | { type: 'start'; frames: Uint8Array[]; responding: boolean }
  | { type: 'audio'; pcm: Uint8Array }
  | { type: 'interrupt' }
  | { type: 'end'; speechMs: number };

export class VoiceActivityDetector {
  private noise = 0.002;
  private prefix: Uint8Array[] = [];
  private prefixMs = 0;
  private candidateMs = 0;
  private active = false;
  private durationMs = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private responding = false;
  private interrupted = false;
  reset() {
    this.prefix = [];
    this.prefixMs = this.candidateMs = this.durationMs = this.speechMs = this.silenceMs = 0;
    this.active = this.responding = this.interrupted = false;
  }
  push(pcm: Uint8Array, responding: boolean): VoiceActivity[] {
    if (!pcm.length || pcm.length % 2) return [];
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let energy = 0;
    for (let i = 0; i < pcm.length; i += 2) energy += (view.getInt16(i, true) / 32768) ** 2;
    const rms = Math.sqrt(energy / (pcm.length / 2)),
      ms = pcm.length / 32,
      threshold = Math.max(responding ? 0.018 : 0.012, this.noise * 3.5),
      voiced = rms >= (this.active ? threshold * 0.65 : threshold);
    const events: VoiceActivity[] = [];
    if (!this.active) {
      this.prefix.push(pcm.slice());
      this.prefixMs += ms;
      while (this.prefix.length > 1 && this.prefixMs - this.prefix[0].length / 32 >= 320)
        this.prefixMs -= this.prefix.shift()!.length / 32;
      this.candidateMs = voiced ? this.candidateMs + ms : 0;
      if (!voiced) this.noise = Math.max(0.001, Math.min(0.02, this.noise * 0.98 + rms * 0.02));
      if (this.candidateMs < 120) return events;
      this.active = true;
      this.responding = responding;
      this.durationMs = this.prefixMs;
      this.speechMs = this.candidateMs;
      events.push({ type: 'start', frames: this.prefix, responding });
      this.prefix = [];
      this.prefixMs = 0;
    } else {
      this.durationMs += ms;
      events.push({ type: 'audio', pcm });
      if (voiced) this.speechMs += ms;
      this.silenceMs = voiced ? 0 : this.silenceMs + ms;
    }
    // Brief acknowledgements/noise do not immediately stop the character.
    // Sustained speech takes ownership without waiting for recognition.
    if (this.responding && !this.interrupted && this.speechMs >= 440) {
      this.interrupted = true;
      events.push({ type: 'interrupt' });
    }
    if (this.silenceMs >= 800 || this.durationMs >= 28500) {
      events.push({ type: 'end', speechMs: this.speechMs });
      this.reset();
    }
    return events;
  }
}

export function isBriefAcknowledgement(text: string, speechMs: number) {
  const words = text.replace(/[\s\p{P}\p{S}]/gu, '');
  return speechMs < 440 && /^(嗯+|恩+|哦+|噢+|啊+|对的?|是的?|好的?|没错|是啊)$/.test(words);
}
