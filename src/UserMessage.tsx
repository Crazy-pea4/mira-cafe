export type InputSource = 'text' | 'asr' | 'mock-voice';
const LABELS: Record<InputSource, string> = { text: '文字消息', asr: '语音识别', 'mock-voice': '模拟语音 · 预设台词' };
export function UserMessage({ text, source }: { text: string; source: InputSource }) {
  if (!text) return null;
  return <div className="user-message" role="status" aria-label="你最近发送的消息" data-testid="user-message">
    <span className="user-message-label">你 <small>· {LABELS[source]}</small></span>
    <p>{text}</p>
  </div>;
}
