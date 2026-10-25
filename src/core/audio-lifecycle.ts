import { AUDIO_BLOCKED_NOTICE } from './audio';
interface EventSource {
  addEventListener(type: string, listener: EventListener, capture?: boolean): void;
  removeEventListener(type: string, listener: EventListener, capture?: boolean): void;
}
interface AudioLifecycle { unlockFromGesture(): Promise<void>; dispose(): void; }
// No lifecycle effect starts speech, network calls or recording. Only trusted gestures unlock.
export function bindAudioLifecycle(target: EventSource, visibility: EventSource & { readonly hidden: boolean }, audio: AudioLifecycle, cancel: () => void, notice: (text: string) => void) {
  let active = true, generation = 0;
  const gesture: EventListener = event => {
    if (!active || !event.isTrusted || visibility.hidden) return;
    if (event.type === 'keydown' && ['Shift','Control','Alt','Meta','Escape'].includes((event as KeyboardEvent).key)) return;
    const current = generation;
    void audio.unlockFromGesture().then(() => {
      if (active && generation === current) notice('');
    }, () => {
      if (active && generation === current) notice(AUDIO_BLOCKED_NOTICE);
    });
  };
  const leave = () => { generation++; cancel(); audio.dispose(); };
  const hidden = () => { if (visibility.hidden) leave(); };
  for (const name of ['pointerdown','click','keydown']) target.addEventListener(name, gesture, true);
  target.addEventListener('pagehide', leave);
  visibility.addEventListener('visibilitychange', hidden);
  return () => {
    active = false;
    for (const name of ['pointerdown','click','keydown']) target.removeEventListener(name, gesture, true);
    target.removeEventListener('pagehide', leave);
    visibility.removeEventListener('visibilitychange', hidden);
    leave();
  };
}
