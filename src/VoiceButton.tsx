import type { VoiceEntryState } from './core/voice-entry';
export function voiceButtonView(state: VoiceEntryState) {
  if (!state.loaded) return { label: '正在连接…', detail: '请稍候', disabled: true };
  if (state.mode === 'mock') return { label: state.held ? '松开发送' : '体验对白', detail: '示例，不录音', disabled: false };
  if (!state.available) return { label: '语音暂不可用', detail: '可输入文字', disabled: true };
  if (state.permission === 'pending') return { label: '等待授权…', detail: '请允许麦克风', disabled: true };
  if (state.permission !== 'ready') return { label: '启用麦克风', detail: '允许使用麦克风', disabled: false };
  return { label: state.phase === 'recognizing' ? '识别中…' : state.phase === 'preparing' ? '准备录音…' : state.held ? '松开识别' : '按住说话', detail: state.phase === 'recognizing' ? '稍等片刻' : state.phase === 'preparing' ? '稍等片刻' : state.held ? '正在录音' : '松开结束', disabled: false };
}
