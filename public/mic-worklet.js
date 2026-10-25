class MiraMicrophone extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new Float32Array(1024); this.offset = 0; this.finished = false;
    this.port.onmessage = event => {
      if (event.data === 'finish' && !this.finished) {
        if (this.offset) { const tail = this.buffer.slice(0, this.offset); this.port.postMessage({ samples: tail }, [tail.buffer]); }
        this.finished = true; this.port.postMessage({ finished: true });
      }
    };
  }
  process(inputs, outputs) {
    // Output is deliberately zero: the microphone is never routed audibly to speakers.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.finished) return false;
    const channels = inputs[0]; if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0; for (const channel of channels) sample += channel[i] ?? 0;
      this.buffer[this.offset++] = sample / channels.length;
      if (this.offset === this.buffer.length) {
        this.port.postMessage({ samples: this.buffer }, [this.buffer.buffer]);
        this.buffer = new Float32Array(1024); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('mira-microphone', MiraMicrophone);
