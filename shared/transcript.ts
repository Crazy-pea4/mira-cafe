export class TranscriptError extends Error {
  constructor(readonly code: 'EMPTY_TRANSCRIPT' | 'BAD_TRANSCRIPT' | 'TOO_LONG', message: string) { super(message); }
}
/** Validate completed ASR text before it can become a user message or a model request. */
export function normalizeTranscript(value: unknown): string {
  if (typeof value !== 'string') throw new TranscriptError('BAD_TRANSCRIPT', '识别结果格式异常，请重新录制或输入文字。');
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/gu, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(text)) throw new TranscriptError('EMPTY_TRANSCRIPT', '没有识别到内容，请再说一次或输入文字。');
  if (text.length > 800) throw new TranscriptError('TOO_LONG', '识别内容过长，请分段说。');
  return text;
}
