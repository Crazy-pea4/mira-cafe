import { appPath } from './app-path';
import { Pcm16Resampler } from '../../shared/pcm';
import { abortError } from '../../shared/async';
export interface CaptureSession {
  finish(): Promise<void>;
  cancel(): void;
}
export type CaptureFactory = (
  frame: (pcm: Uint8Array) => void,
  signal: AbortSignal,
) => Promise<CaptureSession>;

// Explicit permission step: never starts a worklet, uploads audio or opens ASR.
export async function prepareMicrophone(): Promise<void> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
    throw new Error('真实麦克风需要 localhost 或 HTTPS 与浏览器支持。');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((track) => track.stop());
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError')
      throw new Error('麦克风权限未开启，请允许此页面使用麦克风后再点“启用麦克风”。');
    throw new Error('没有找到可用麦克风，请检查设备连接后重试。');
  }
}

export const openMicrophone: CaptureFactory = async (frame, signal) => {
  if (signal.aborted) throw abortError();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
    throw new Error('真实麦克风需要 localhost 或 HTTPS 与浏览器支持。');
  // This function is called only from an explicitly labeled press-to-record gesture.
  const context = new AudioContext();
  const resumed = context.resume();
  void resumed.catch(() => {});
  let stream: MediaStream | undefined,
    node: AudioWorkletNode | undefined,
    source: MediaStreamAudioSourceNode | undefined,
    gain: GainNode | undefined;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', cleanup);
    if (node) {
      node.port.onmessage = null;
      node.disconnect();
    }
    source?.disconnect();
    gain?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    void context.close().catch(() => {});
  };
  signal.addEventListener('abort', cleanup, { once: true });
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    if (signal.aborted || closed) {
      stream.getTracks().forEach((track) => track.stop());
      throw abortError();
    }
    await resumed;
    if (context.state === 'suspended') throw new Error('Audio context suspended');
    if (!context.audioWorklet?.addModule) throw new Error('AudioWorklet unavailable');
    await context.audioWorklet.addModule(appPath('mic-worklet.js'));
    if (signal.aborted || closed) throw abortError();
    const resampler = new Pcm16Resampler(context.sampleRate);
    let finishResolve: (() => void) | undefined;
    node = new AudioWorkletNode(context, 'mira-microphone', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.port.onmessage = (event) => {
      if (closed || signal.aborted) return;
      if (event.data.samples) {
        const pcm = resampler.push(event.data.samples);
        if (pcm.length) frame(pcm);
      }
      if (event.data.finished) {
        const tail = resampler.flush();
        if (tail.length) frame(tail);
        finishResolve?.();
      }
    };
    source = context.createMediaStreamSource(stream);
    gain = context.createGain();
    gain.gain.value = 0;
    source.connect(node);
    node.connect(gain);
    gain.connect(context.destination);
    return {
      cancel: cleanup,
      finish: () =>
        new Promise<void>((resolve) => {
          if (closed) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            cleanup();
            resolve();
          }, 250);
          finishResolve = () => {
            clearTimeout(timer);
            cleanup();
            resolve();
          };
          node!.port.postMessage('finish');
        }),
    };
  } catch (error) {
    cleanup();
    if (signal.aborted) throw abortError();
    if (error instanceof DOMException && error.name === 'NotAllowedError')
      throw new Error('麦克风未获允许，可重新按住录音或继续输入文字。');
    throw new Error('麦克风暂时不可用，请检查权限和设备后重试。');
  }
};
export class MicrophoneCapture {
  private active?: CaptureSession;
  private generation = 0;
  constructor(private factory: CaptureFactory = openMicrophone) {}
  async start(frame: (pcm: Uint8Array) => void, signal: AbortSignal) {
    this.cancel();
    const token = this.generation;
    const session = await this.factory((pcm) => {
      if (token === this.generation && !signal.aborted) frame(pcm);
    }, signal);
    if (token !== this.generation || signal.aborted) {
      session.cancel();
      throw abortError();
    }
    this.active = session;
  }
  async finish() {
    const active = this.active;
    await active?.finish();
    if (this.active === active) this.active = undefined;
  }
  cancel() {
    this.generation++;
    this.active?.cancel();
    this.active = undefined;
  }
}
