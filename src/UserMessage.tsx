export type InputSource = 'text' | 'asr' | 'mock-voice';
const LABELS: Record<InputSource, string> = { text: '', asr: '语音转写', 'mock-voice': '示例对白' };
export function UserMessage({ text, source }: { text: string; source: InputSource }) {
  if (!text) return null;
  return (
    <div
      className="user-message"
      role="status"
      aria-label="你最近发送的消息"
      data-testid="user-message"
    >
      <span className="user-message-label">
        你 {LABELS[source] && <small>· {LABELS[source]}</small>}
      </span>
      <p>{text}</p>
    </div>
  );
}
