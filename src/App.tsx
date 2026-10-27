import { appPath } from './core/app-path';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { StoryTimeline } from './StoryTimeline';
import { bindSceneViewport } from './core/scene-viewport';
import { SceneAudio } from './core/scene-audio';
import { bindAudioLifecycle } from './core/audio-lifecycle';
import { VoiceInput } from './core/voice-input';
import { VoiceEntry } from './core/voice-entry';
import { VoiceCall } from './core/voice-call';
import { VoiceCallButton, VoiceCallStatus } from './VoiceCallControl';
import { prepareMicrophone } from './core/microphone';
import { voiceButtonView } from './VoiceButton';
import { LocalSpeechTransport } from './core/speech-transport';
import { ConversationEngine } from './core/engine';
import { HttpTransport } from './core/transport';
import { LocalProgressStorage } from './core/progress-storage';
import { Character } from './Character';
import { Narrative } from './Narrative';
import { Suggestions } from './Suggestions';
import { ModeBadge } from './ModeBadge';
import { SCENE_ARTWORK } from './scene-artwork';
import { SceneBackground } from './SceneBackground';
import { UserMessage, type InputSource } from './UserMessage';
import { InteractionTiming } from './core/interaction-timing';
import { TimingDebugPanel } from './TimingDebugPanel';
import { PcmSpeechPlayer } from './core/pcm-playback';
const STATUS = {
  idle: '在等你开口',
  listening: '正在倾听',
  thinking: '正在想怎么说',
  speaking: '正在说话',
  narrating: '',
  error: '连接暂时中断',
};
export function App() {
  const [{ engine, audio, entry, call, timing }] = useState(() => {
    const timing = new InteractionTiming();
    const speech = new LocalSpeechTransport(undefined, undefined, timing);
    const audio = new SceneAudio(undefined, new PcmSpeechPlayer(speech), timing),
      voice = new VoiceInput(speech);
    const entry = new VoiceEntry(voice, prepareMicrophone);
    return {
      engine: new ConversationEngine(
        new HttpTransport(timing),
        audio,
        undefined,
        undefined,
        undefined,
        new LocalProgressStorage(),
      ),
      audio,
      entry,
      call: new VoiceCall(speech),
      timing,
    };
  });
  const state = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
  const input = useSyncExternalStore(entry.subscribe, entry.getSnapshot, entry.getSnapshot);
  const callState = useSyncExternalStore(call.subscribe, call.getSnapshot, call.getSnapshot);
  const voiceButton = voiceButtonView(input);
  const sceneRef = useRef<HTMLElement>(null),
    hudRef = useRef<HTMLElement>(null),
    streamRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scene = sceneRef.current,
      hud = hudRef.current;
    if (!scene || !hud) return;
    const unbind = bindSceneViewport(window, scene.style);
    const measure = () => {
      scene.style.setProperty('--hud-height', `${hud.getBoundingClientRect().height}px`);
      if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(hud);
    measure();
    return () => {
      observer.disconnect();
      unbind();
    };
  }, []);
  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
  }, [state.turnId, state.subtitle, state.streamingText, state.narration, state.status]);
  const [text, setText] = useState('');
  const [inputSource, setInputSource] = useState<InputSource>('text');
  const [backgroundReady, setBackgroundReady] = useState(false);
  const [backgroundStatus, setBackgroundStatus] = useState<'ready' | 'loading' | 'failed'>('ready');
  const [backgroundAttempt, setBackgroundAttempt] = useState(0);
  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
  }, [backgroundStatus]);
  const [audioNotice, setAudioNotice] = useState('');
  const [authentication, setAuthentication] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(appPath('api/health'), { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error('Unavailable');
        return r.json();
      })
      .then((d) => {
        setProvider(d.provider);
        setAuthentication(d.authentication?.required === true);
        entry.configure(d.speechAvailable === true, d.speech === 'qwen');
        audio.live = !!d.speechAvailable;
        timing.configure(d.provider === 'deepseek', d.speechAvailable === true);
      })
      .catch(() => {
        if (!controller.signal.aborted) entry.unavailable();
      });
    const unbindAudio = bindAudioLifecycle(
      window,
      document,
      audio,
      () => {
        entry.suspend();
        call.stop();
        engine.suspend();
      },
      setAudioNotice,
      () => {
        entry.suspend();
        if (call.getSnapshot().active) call.stop('页面已进入后台，已暂停收音。点击电话继续。', false);
      },
    );
    const blur = () => { entry.blur(); call.blur(); };
    const offline = () => {
      if (call.getSnapshot().active) call.stop('网络已断开，通话已结束。网络恢复后点击电话继续。');
    };
    window.addEventListener('blur', blur);
    window.addEventListener('offline', offline);
    return () => {
      controller.abort();
      unbindAudio();
      engine.suspend();
      window.removeEventListener('blur', blur);
      window.removeEventListener('offline', offline);
    };
  }, [engine, entry, audio, call, timing]);
  const send = (value: string, source: InputSource = 'text') => {
    if (!value.trim() || value.trim().length > 800) return;
    setInputSource(source);
    call.clearInput();
    entry.cancel();
    setText('');
    void engine.submit(value);
  };
  const hold = () => {
    if (call.getSnapshot().active) return;
    const suggestion = engine.getSnapshot().suggestions[0] ?? '我愿意听，你慢慢说。';
    entry.press({
      begin: () => {
        engine.interrupt(true);
        return engine.getSnapshot().turnId;
      },
      text: (value) => send(value, 'asr'),
      mock: () => send(suggestion, 'mock-voice'),
      notice: (message) => engine.inputNotice(message),
      end: () => engine.endListening(),
    });
  };
  const toggleCall = () => {
    if (call.getSnapshot().active) {
      call.stop('通话已结束，随时可以再聊。');
      return;
    }
    if (!input.loaded || !input.available) return;
    entry.cancel();
    void call.start({
      turnId: () => engine.getSnapshot().turnId,
      responding: () => ['speaking', 'thinking', 'narrating'].includes(engine.getSnapshot().status),
      begin: () => engine.interrupt(true),
      text: (value) => send(value, 'asr'),
      end: () => engine.endListening(),
      stop: () => engine.interrupt(),
    });
  };
  const active =
    state.status === 'speaking' || state.status === 'thinking' || state.status === 'narrating';
  const artwork = SCENE_ARTWORK[state.location];
  return (
    <main ref={sceneRef} className={`app scene-${state.scene} location-${state.location}`}>
      <div className="ambient-grain" />
      <header className="topbar">
        <a className="brand" href={appPath()} aria-label="Mira Café 首页">
          <span className="brand-icon">☾</span>
          <span>
            MIRA <b>CAFÉ</b>
          </span>
        </a>
        <div className="top-actions">
          <ModeBadge provider={provider} />
          <TimingDebugPanel timing={timing} />
          <button
            className="reset-story leave-cafe"
            type="button"
            onClick={() => {
              if (!window.confirm('重置剧情并清除本机存档？将从咖啡馆开场重新开始。')) return;
              entry.cancel();
              call.stop();
              engine.reset();
              setText('');
              setInputSource('text');
            }}
          >
            重置剧情
          </button>
          {authentication && (
            <form
              action={appPath('auth/logout')}
              method="post"
              onSubmit={() => {
                entry.cancel();
                call.stop();
                engine.suspend();
                audio.dispose();
              }}
            >
              <button className="leave-cafe" type="submit">
                离开咖啡馆
              </button>
            </form>
          )}
        </div>
      </header>
      <section
        className={'stage ' + (backgroundReady ? 'illustrated-stage' : '')}
        aria-label={artwork.description}
      >
        <SceneBackground
          location={state.location}
          preloadLodge={state.story?.facts.includes('photo-drift') === true}
          onReadyChange={setBackgroundReady}
          onStatusChange={setBackgroundStatus}
          attempt={backgroundAttempt}
        />
        <div className="window-frame">
          <div className="city">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <div className="moon" />
          <div className="rain" />
          <div className="window-bar horizontal" />
          <div className="window-bar vertical" />
        </div>
        <div className="hanging-light">
          <span />
        </div>
        <div className="warm-light" />
        <div className="story-heading">
          <span className="eyebrow">{artwork.chapter}</span>
          <h1>{artwork.title}</h1>
          <p>有些故事，适合从一杯热咖啡开始。</p>
        </div>
        <div className="place-label">
          <span className="tiny-star">✦</span> {artwork.place}
        </div>
        <div className="character-wrap">
          <Character state={state} />
        </div>
        <div className="table">
          <div className="coffee">
            <i />
            <i />
            <span />
          </div>
          <div className="table-note">stay a little longer.</div>
        </div>

        <div className="scene-props">
          <Narrative text="" props={state.stageProps} focus={state.propFocus} />
        </div>
      </section>
      <StoryTimeline story={state.story} />
      <section ref={hudRef} className="interaction" aria-label="与 Mira 对话">
        <div ref={streamRef} className="dialogue-stream">
          {state.narration && (
            <p className="narration" aria-live="polite">
              {state.narration}
            </p>
          )}
          <UserMessage text={state.lastInput} source={inputSource} />
          <div className="dialogue-area">
            <div className="character-meta">
              <div>
                <span className="name">Mira</span>
                <span className="descriptor">旅行摄影师 · 26</span>
              </div>
              <span className={`state-badge ${state.status}`} data-testid="state">
                <i />
                {state.pendingAudio ? '正在准备语音' : state.streamingText ? '正在回应' : STATUS[state.status]}
              </span>
            </div>
            <div className="subtitle-box">
              {state.status === 'error' ? (
                <div className="error-content" role="alert">
                  <span>{state.error}</span>
                  <button onClick={() => void engine.retry()}>
                    {provider === 'deepseek' ? '重新请求（会计费）' : '重试这一句 ↻'}
                  </button>
                </div>
              ) : (
                <p aria-live="polite" aria-busy={!!state.streamingText} data-testid="subtitle" data-streaming={!!state.streamingText}>
                  {state.status === 'listening'
                    ? input.mode === 'live'
                      ? '我在听。'
                      : '松开后，就从这个话题聊起吧。'
                    : state.streamingText || state.subtitle || (
                        <span className="dialogue-placeholder">
                          {state.pendingAudio
                            ? '正在准备语音…'
                            : state.status === 'narrating'
                              ? '剧情正在继续…'
                              : state.status === 'thinking'
                                ? 'Mira 正在想怎么说…'
                                : '可以继续对 Mira 说话。'}
                        </span>
                      )}
                </p>
              )}
              {active && (
                <button
                  className="interrupt"
                  onClick={() => engine.interrupt()}
                  aria-label="立即打断当前回复"
                >
                  ■ 打断
                </button>
              )}
            </div>
            {state.notice && !(input.showMessage && state.notice === input.message) && (
              <div className="notice" role="status">
                {state.notice}
              </div>
            )}
            {audioNotice && !state.notice.includes(audioNotice) && (
              <div className="notice" role="status">
                {audioNotice}
              </div>
            )}
            {state.saveNotice && (
              <div className="notice" role="status">
                {state.saveNotice}
              </div>
            )}
            {state.location === 'lodge' && backgroundStatus !== 'ready' && (
              <div className="notice scene-notice" role="status">
                {backgroundStatus === 'failed'
                  ? '照片里的风景暂时没能展开，先继续听她说。'
                  : '照片里的风景，正慢慢展开…'}
                {backgroundStatus === 'failed' && (
                  <button
                    className="scene-retry"
                    type="button"
                    onClick={() => setBackgroundAttempt((old) => old + 1)}
                  >
                    重新展开
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <Suggestions
          values={state.suggestions}
          story={state.story}
          onChoose={(value) => send(value)}
        />
        <VoiceCallStatus state={callState} status={state.status} />
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            send(text);
          }}
        >
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-label="对 Mira 说点什么"
            placeholder="对 Mira 说点什么…"
            maxLength={800}
          />
          <button className="send" type="submit" disabled={!text.trim()} aria-label="发送文字">
            ↑
          </button>
          <div className="composer-divider" />
          <button
            type="button"
            className={'talk ' + (input.held ? 'holding' : '')}
            disabled={callState.active || voiceButton.disabled}
            onClick={() => {
              if (entry.needsPermission())
                void entry.prepare((message) => engine.inputNotice(message));
            }}
            onPointerDown={(event) => {
              if (entry.canHold()) {
                event.currentTarget.setPointerCapture(event.pointerId);
                hold();
              }
            }}
            onPointerUp={() => entry.release()}
            onPointerCancel={() => entry.cancelHeld()}
            onLostPointerCapture={() => entry.cancelHeld()}
            onKeyDown={(event) => {
              if (
                (event.key === ' ' || event.key === 'Enter') &&
                !event.repeat &&
                entry.canHold()
              ) {
                event.preventDefault();
                hold();
              }
            }}
            onKeyUp={(event) => {
              if ((event.key === ' ' || event.key === 'Enter') && entry.canHold()) {
                event.preventDefault();
                entry.release();
              }
            }}
            onBlur={() => entry.cancelHeld()}
            aria-label={
              callState.active
                ? '实时通话中，无需按住说话'
                : input.mode === 'mock'
                ? '体验对白（示例，不使用麦克风）'
                : entry.needsPermission()
                  ? '启用麦克风（授权后再按住说话）'
                  : voiceButton.label + '，' + voiceButton.detail
            }
          >
            <span className="mic-icon">♩</span>
            <span>
              {callState.active ? '通话中' : voiceButton.label}
              <small>{callState.active ? '请直接说话' : voiceButton.detail}</small>
            </span>
          </button>
          <VoiceCallButton
            state={callState}
            available={input.available}
            loaded={input.loaded}
            onToggle={toggleCall}
          />
        </form>
        <p
          className="voice-help"
          role="status"
          data-testid="voice-help"
          data-recording={input.showMessage && input.phase === 'recording'}
        >
          {callState.active ? '通话中会持续使用麦克风；点击红色电话挂断。' : input.showMessage ? input.message : ''}
        </p>
      </section>
    </main>
  );
}
