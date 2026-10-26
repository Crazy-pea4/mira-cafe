import type { VoiceInput } from './voice-input';
export type VoicePhase = 'idle' | 'preparing' | 'recording' | 'recognizing';
export type VoiceEntryState = {
  mode: 'mock' | 'live';
  loaded: boolean;
  available: boolean;
  configured: boolean;
  permission: 'needed' | 'pending' | 'ready';
  phase: VoicePhase;
  held: boolean;
  message: string;
  showMessage: boolean;
};
type Callbacks = {
  begin: () => number;
  text: (text: string) => void;
  mock: () => void;
  notice: (message: string) => void;
  end: () => void;
};
export class VoiceEntry {
  private snapshot: VoiceEntryState = {
    mode: 'live',
    loaded: false,
    available: false,
    configured: false,
    permission: 'needed',
    phase: 'idle',
    held: false,
    message: '正在连接语音…',
    showMessage: false,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private selected = false;
  private callbacks?: Callbacks;
  constructor(
    private voice: Pick<VoiceInput, 'start' | 'finish' | 'cancel'>,
    private permissionRequest: () => Promise<void>,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<VoiceEntryState>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  configure(available: boolean, configured: boolean, reason = '') {
    const mode =
      this.selected || this.snapshot.loaded
        ? this.snapshot.mode
        : available || configured
          ? 'live'
          : 'mock';
    if (!available && this.snapshot.available) this.cancel();
    this.update({
      loaded: true,
      available,
      configured,
      mode,
      showMessage: configured && !available,
      message: available
        ? '允许麦克风后，就可以按住说话。'
        : configured
          ? reason || '语音暂时连不上，你可以先打字。'
          : '体验的是固定对白，不会使用麦克风。',
    });
  }
  unavailable() {
    this.update({
      loaded: true,
      available: false,
      configured: true,
      mode: 'live',
      message: '语音暂时连不上，你可以先打字，或刷新后再试。',
      showMessage: true,
    });
  }
  select(mode: 'live' | 'mock') {
    this.cancel();
    this.selected = true;
    this.update({
      mode,
      showMessage: false,
      message:
        mode === 'mock'
          ? '体验的是固定对白，不会使用麦克风。'
          : this.snapshot.permission === 'ready'
            ? '麦克风已准备好。按住说话，松开识别。'
            : '先点击启用麦克风，再按住说话。',
    });
  }
  canHold() {
    const s = this.snapshot;
    return s.loaded && (s.mode === 'mock' || (s.available && s.permission === 'ready'));
  }
  needsPermission() {
    const s = this.snapshot;
    return s.loaded && s.mode === 'live' && s.available && s.permission === 'needed';
  }
  async prepare(notice: (message: string) => void) {
    if (!this.needsPermission()) return;
    this.cancel();
    const token = this.generation;
    this.update({ permission: 'pending', showMessage: true, message: '请允许浏览器使用麦克风。' });
    try {
      await this.permissionRequest();
      if (token !== this.generation) return;
      const message = '麦克风已就绪。现在按住说话，松开结束。';
      this.update({ permission: 'ready', showMessage: true, message });
      notice(message);
    } catch (error) {
      if (token !== this.generation) return;
      const message = error instanceof Error ? error.message : '麦克风启用失败，请重试或输入文字。';
      this.update({ permission: 'needed', showMessage: true, message });
      notice(message);
    }
  }
  press(callbacks: Callbacks) {
    if (!this.canHold() || this.snapshot.held) return;
    this.cancel();
    this.callbacks = callbacks;
    const token = this.generation;
    this.update({
      held: true,
      phase: 'preparing',
      showMessage: true,
      message:
        this.snapshot.mode === 'mock' ? '松开后发送示例对白，不会录音。' : '正在准备录音，请稍候…',
    });
    const turn = callbacks.begin();
    if (this.snapshot.mode === 'mock') return;
    void this.voice.start(turn, {
      text: (text) => {
        if (token === this.generation) {
          this.update({ held: false, phase: 'idle', showMessage: false, message: '' });
          callbacks.text(text);
        }
      },
      error: (message) => {
        if (token === this.generation) {
          this.update({ held: false, phase: 'idle', showMessage: true, message });
          callbacks.notice(message);
        }
      },
      state: (message) => {
        if (token === this.generation) this.update({ message });
      },
      phase: (phase) => {
        if (token === this.generation) this.update({ phase });
      },
    });
  }
  release() {
    if (!this.snapshot.held) return;
    this.update({ held: false, phase: 'recognizing' });
    if (this.snapshot.mode === 'mock') {
      this.update({ phase: 'idle', showMessage: false });
      this.callbacks?.mock();
    } else void this.voice.finish();
  }
  cancelHeld() {
    if (this.snapshot.held) this.cancel('本次录音已取消，请重新按住说话。');
  }
  suspend() {
    // Do not mutate an untouched/idle input when the page is backgrounded.
    // Pending permission and active capture/recognition still lose ownership.
    if (
      this.snapshot.permission === 'pending' ||
      this.snapshot.held ||
      this.snapshot.phase !== 'idle'
    )
      this.cancel();
  }
  blur() {
    // A permission popup may blur the page. Preparation never starts an ASR session.
    if (this.snapshot.permission === 'pending') return;
    if (this.snapshot.held || this.snapshot.phase !== 'idle')
      this.cancel('页面失去焦点，本次录音已取消。请重新按住说话。');
  }
  cancel(message?: string) {
    this.generation++;
    this.voice.cancel();
    const callbacks = this.callbacks;
    this.callbacks = undefined;
    this.update({
      held: false,
      phase: 'idle',
      showMessage: !!message,
      ...(this.snapshot.permission === 'pending' ? { permission: 'needed' as const } : {}),
      ...(message ? { message } : {}),
    });
    callbacks?.end();
    if (message) callbacks?.notice(message);
  }
}
