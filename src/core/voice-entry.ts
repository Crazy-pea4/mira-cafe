import type { VoiceInput } from './voice-input';
export type VoicePhase = 'idle' | 'preparing' | 'recording' | 'recognizing';
export type VoiceEntryState = {
  mode: 'mock' | 'live'; loaded: boolean; available: boolean; configured: boolean;
  permission: 'needed' | 'pending' | 'ready'; phase: VoicePhase; held: boolean; message: string;
};
type Callbacks = { begin: () => number; text: (text: string) => void; mock: () => void; notice: (message: string) => void; end: () => void };
export class VoiceEntry {
  private snapshot: VoiceEntryState = { mode: 'live', loaded: false, available: false, configured: false, permission: 'needed', phase: 'idle', held: false, message: '正在检查语音服务…' };
  private listeners = new Set<() => void>();
  private generation = 0;
  private selected = false;
  private callbacks?: Callbacks;
  constructor(private voice: Pick<VoiceInput, 'start' | 'finish' | 'cancel'>, private permissionRequest: () => Promise<void>) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<VoiceEntryState>) { this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener(); }
  configure(available: boolean, configured: boolean, reason = '') {
    const mode = this.selected || this.snapshot.loaded ? this.snapshot.mode : available || configured ? 'live' : 'mock';
    if (!available && this.snapshot.available) this.cancel();
    this.update({ loaded: true, available, configured, mode, message: available ? '首次点击启用麦克风；准备好后按住说话，松开识别。' : configured ? reason || '真实语音暂不可用，请稍后重试或输入文字。' : '模拟语音只发送预设台词，不识别讲话。' });
  }
  unavailable() { this.update({ loaded: true, available: false, configured: true, mode: 'live', message: '无法确认语音服务状态，请刷新页面或先输入文字。' }); }
  select(mode: 'live' | 'mock') { this.cancel(); this.selected = true; this.update({ mode, message: mode === 'mock' ? '模拟语音只发送预设台词，不识别讲话。' : this.snapshot.permission === 'ready' ? '麦克风已准备好。按住说话，松开识别。' : '先点击启用麦克风，再按住说话。' }); }
  canHold() { const s = this.snapshot; return s.loaded && (s.mode === 'mock' || (s.available && s.permission === 'ready')); }
  needsPermission() { const s = this.snapshot; return s.loaded && s.mode === 'live' && s.available && s.permission === 'needed'; }
  async prepare(notice: (message: string) => void) {
    if (!this.needsPermission()) return;
    this.cancel(); const token = this.generation;
    this.update({ permission: 'pending', message: '请在浏览器弹窗允许麦克风；允许后再按住说话。' });
    try {
      await this.permissionRequest();
      if (token !== this.generation) return;
      const message = '麦克风已启用。现在按住“按住说话”，看到正在录音后开始说，松开识别。';
      this.update({ permission: 'ready', message }); notice(message);
    } catch (error) {
      if (token !== this.generation) return;
      const message = error instanceof Error ? error.message : '麦克风启用失败，请重试或输入文字。';
      this.update({ permission: 'needed', message }); notice(message);
    }
  }
  press(callbacks: Callbacks) {
    if (!this.canHold() || this.snapshot.held) return;
    this.cancel(); this.callbacks = callbacks; const token = this.generation;
    this.update({ held: true, phase: 'preparing', message: this.snapshot.mode === 'mock' ? '松开将发送预设台词；此入口不录音。' : '正在准备录音，请稍候…' });
    const turn = callbacks.begin();
    if (this.snapshot.mode === 'mock') return;
    void this.voice.start(turn, {
      text: text => { if (token === this.generation) { this.update({ held: false, phase: 'idle', message: '已识别为文字。按住可继续说话。' }); callbacks.text(text); } },
      error: message => { if (token === this.generation) { this.update({ held: false, phase: 'idle', message }); callbacks.notice(message); } },
      state: message => { if (token === this.generation) this.update({ message }); },
      phase: phase => { if (token === this.generation) this.update({ phase }); },
    });
  }
  release() {
    if (!this.snapshot.held) return;
    this.update({ held: false, phase: 'recognizing' });
    if (this.snapshot.mode === 'mock') { this.update({ phase: 'idle' }); this.callbacks?.mock(); }
    else void this.voice.finish();
  }
  cancelHeld() { if (this.snapshot.held) this.cancel('本次录音已取消，请重新按住说话。'); }
  blur() {
    // A permission popup may blur the page. Preparation never starts an ASR session.
    if (this.snapshot.permission === 'pending') return;
    if (this.snapshot.held || this.snapshot.phase !== 'idle') this.cancel('页面失去焦点，本次录音已取消。请重新按住说话。');
  }
  cancel(message?: string) {
    this.generation++; this.voice.cancel();
    const callbacks = this.callbacks; this.callbacks = undefined;
    this.update({ held: false, phase: 'idle', ...(this.snapshot.permission === 'pending' ? { permission: 'needed' as const } : {}), ...(message ? { message } : {}) });
    callbacks?.end(); if (message) callbacks?.notice(message);
  }
}
