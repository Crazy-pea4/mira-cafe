export class SpeechError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SpeechError';
  }
}
export interface AsrSession {
  ready: Promise<void>;
  append(pcm: Uint8Array): void;
  commit(): Promise<string>;
  cancel(): void;
}
export interface SpeechProvider {
  openAsr(signal: AbortSignal): AsrSession;
  synthesize(text: string, signal: AbortSignal, audio: (pcm: Uint8Array) => void): Promise<void>;
}
export interface WireSocket {
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'message' | 'error' | 'close', listener: (data?: unknown) => void): void;
}
export type WireFactory = (url: string, headers: Record<string, string>) => WireSocket;
