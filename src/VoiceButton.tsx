import type { VoiceEntryState } from './core/voice-entry';
export function voiceButtonView(state: VoiceEntryState) {
  if (!state.loaded) return { label: '检查语音…', detail: '请稍候', disabled: true };
  if (state.mode === 'mock') return { label: state.held ? '松开发送' : '模拟台词', detail: '不识别讲话', disabled: false };
  if (!state.available) return { label: '语音暂不可用', detail: '可输入文字', disabled: true };
  if (state.permission === 'pending') return { label: '等待授权…', detail: '请允许麦克风', disabled: true };
  if (state.permission !== 'ready') return { label: '启用麦克风', detail: '首次点击授权', disabled: false };
  return { label: state.phase === 'recognizing' ? '识别中…' : state.phase === 'preparing' ? '准备录音…' : state.held ? '松开识别' : '按住说话', detail: '真实语音转文字', disabled: false };
}
