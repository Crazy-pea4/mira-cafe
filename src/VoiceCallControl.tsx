import { useEffect, useState } from 'react';
import type { CharacterStatus } from '../shared/protocol';
import type { VoiceCallState } from './core/voice-call';

export function VoiceCallButton({ state, available, loaded, onToggle }: {
  state: VoiceCallState;
  available: boolean;
  loaded: boolean;
  onToggle: () => void;
}) {
  const label = state.active ? '结束实时语音通话' : '开始实时语音通话';
  return (
    <button
      type="button"
      className={'call-button ' + (state.active ? 'connected' : '')}
      onClick={onToggle}
      disabled={!state.active && (!loaded || !available)}
      aria-label={label}
      aria-pressed={state.active}
      aria-describedby={state.active || state.message ? 'voice-call-status' : undefined}
      title={!loaded ? '正在连接语音…' : !available ? '实时通话需要启用真实语音服务' : label}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.4 1.8.6 2.8.7a2 2 0 0 1 1.8 2.1Z" />
        {state.active && <path d="m4 4 16 16" />}
      </svg>
    </button>
  );
}

export function VoiceCallStatus({ state, status }: { state: VoiceCallState; status: CharacterStatus }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!state.startedAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.startedAt]);
  if (!state.active && !state.message) return null;
  const seconds = state.startedAt ? Math.max(0, Math.floor((now - state.startedAt) / 1000)) : 0;
  const duration = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  const message = state.message || (
    state.phase === 'recording' ? '正在听你说 · 停顿后自动发送' :
    state.phase === 'recognizing' ? '正在识别 · 仍可继续说话' :
    status === 'speaking' ? 'Mira 正在说 · 可以直接插话' :
    status === 'thinking' || status === 'narrating' ? 'Mira 正在回应 · 可以直接插话' :
    '麦克风已开启 · 直接说话即可'
  );
  return (
    <div id="voice-call-status" className={'call-status ' + (state.active ? 'connected' : '')}>
      <span className="call-indicator" aria-hidden="true" />
      <span className="call-message" role="status">{message}</span>
      {state.startedAt && <time aria-label="通话时长">{duration}</time>}
    </div>
  );
}
