import { useEffect, useState, useSyncExternalStore } from 'react';
import { SceneAudio } from './core/scene-audio';
import { bindAudioLifecycle } from './core/audio-lifecycle';
import { VoiceInput } from './core/voice-input';
import { VoiceEntry } from './core/voice-entry';
import { prepareMicrophone } from './core/microphone';
import { voiceButtonView } from './VoiceButton';
import { LocalSpeechTransport } from './core/speech-transport';
import { ConversationEngine } from './core/engine';
import { HttpTransport } from './core/transport';
import { Character } from './Character';
import { ModeBadge } from './ModeBadge';
import { SCENE_ARTWORK } from './scene-artwork';
import { UserMessage, type InputSource } from './UserMessage';
const STATUS = { idle: '在等你开口', listening: '正在倾听', thinking: '正在想怎么说', speaking: '正在说话', error: '连接暂时中断' };
const prompts = ['雨这么大，你怎么还没走？', '你在等谁？', '能看看你的照片吗？'];
export function App() {
  const [{ engine, audio, entry }] = useState(() => {
    const audio = new SceneAudio(), voice = new VoiceInput(new LocalSpeechTransport());
    return { engine: new ConversationEngine(new HttpTransport(), audio), audio, entry: new VoiceEntry(voice, prepareMicrophone) };
  });
  const state = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
  const input = useSyncExternalStore(entry.subscribe, entry.getSnapshot, entry.getSnapshot);
  const voiceButton = voiceButtonView(input);
  const [text, setText] = useState('');
  const [inputSource, setInputSource] = useState<InputSource>('text');
  const [backgroundReady, setBackgroundReady] = useState(false);
  const [audioNotice, setAudioNotice] = useState('');
  const [provider, setProvider] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/health', { signal: controller.signal }).then(r => { if (!r.ok) throw new Error('Unavailable'); return r.json(); }).then(d => {
      setProvider(d.provider);
      entry.configure(d.speechAvailable === true, d.speech === 'qwen', d.budget?.reason);
      audio.live = !!d.speechAvailable;
    }).catch(() => { if (!controller.signal.aborted) entry.unavailable(); });
    const unbindAudio = bindAudioLifecycle(window, document, audio, () => { entry.cancel(); engine.interrupt(); }, setAudioNotice);
    const blur = () => entry.blur();
    window.addEventListener('blur', blur);
    return () => { controller.abort(); unbindAudio(); engine.dispose(); window.removeEventListener('blur', blur); };
  }, [engine, entry, audio]);
  const send = (value: string, source: InputSource = 'text') => {
    if (!value.trim() || value.trim().length > 800) return;
    setInputSource(source); entry.cancel(); setText(''); void engine.submit(value);
  };
  const hold = () => entry.press({
    begin: () => { engine.interrupt(true); return engine.getSnapshot().turnId; },
    text: value => send(value, 'asr'),
    mock: () => { const latest = engine.getSnapshot(); send(prompts[latest.photo ? 0 : latest.completed ? 2 : 1], 'mock-voice'); },
    notice: message => engine.inputNotice(message),
    end: () => engine.endListening(),
  });
  const active = state.status === 'speaking' || state.status === 'thinking';
  return <main className={`app scene-${state.scene}`}>
    <div className="ambient-grain"/>
    <header className="topbar">
      <a className="brand" href="/" aria-label="Mira Café 首页"><span className="brand-icon">☾</span><span>MIRA <b>CAFÉ</b></span></a>
      <div className="top-actions"><ModeBadge provider={provider}/></div>
    </header>
    <section className={'stage ' + (backgroundReady ? 'illustrated-stage' : '')} aria-label="夜雨咖啡馆互动场景">
      <img className="scene-illustration" src={SCENE_ARTWORK.src} alt={SCENE_ARTWORK.description}
        width={SCENE_ARTWORK.width} height={SCENE_ARTWORK.height}
        onLoad={() => setBackgroundReady(true)} onError={() => setBackgroundReady(false)} fetchPriority="high"/>
      {backgroundReady && <div className="illustration-rain"><div className="rain"/></div>}
      <div className="window-frame"><div className="city"><span/><span/><span/><span/><span/><span/></div><div className="moon"/><div className="rain"/><div className="window-bar horizontal"/><div className="window-bar vertical"/></div>
      <div className="hanging-light"><span/></div><div className="warm-light"/>
      <div className="story-heading"><span className="eyebrow">CHAPTER 01 · 雨夜来客</span><h1>雨停之前</h1><p>有些故事，适合从一杯热咖啡开始。</p></div>
      <div className="place-label"><span className="tiny-star">✦</span> 23:47 <span>·</span> 城市一隅</div>
      <div className="character-wrap"><Character state={state}/></div>
      <div className="table"><div className="coffee"><i/><i/><span/></div><div className="table-note">stay a little longer.</div></div>
      {state.photo && <div className="memory-card" role="img" aria-label="Mira 展示的照片：雨后的山间与一束光"><div className="photo-landscape"><i/><b/></div><p>雨停的那一天 <span>09 / 12</span></p></div>}
      <div className="dialogue-area">
        <div className="character-meta"><div><span className="name">Mira</span><span className="descriptor">旅行摄影师 · 26</span></div><span className={`state-badge ${state.status}`} data-testid="state"><i/>{STATUS[state.status]}</span></div>
        <div className="subtitle-box">
          {state.status === 'error' ? <div className="error-content" role="alert"><span>{state.error}</span><button onClick={() => void engine.retry()}>{provider === 'deepseek' ? '重新请求（会计费）' : '重试这一句 ↻'}</button></div>
            : <p aria-live="polite" data-testid="subtitle">{state.status === 'listening' ? (input.mode === 'live' ? '我在听。' : '松开后，就从这个话题聊起吧。') : state.subtitle || (state.status === 'thinking' ? <span className="thinking-dots"><i/><i/><i/></span> : '你可以继续说，我在这里。')}</p>}
          {active && <button className="interrupt" onClick={() => engine.interrupt()} aria-label="立即打断当前回复">■ 打断</button>}
        </div>
        {state.notice && !(input.showMessage && state.notice === input.message) && <div className="notice" role="status">{state.notice}</div>}
        {audioNotice && !state.notice.includes(audioNotice) && <div className="notice" role="status">{audioNotice}</div>}
      </div>
    </section>
    <section className="interaction" aria-label="与 Mira 对话">
      <UserMessage text={state.lastInput} source={inputSource}/>
      <div className="suggestions">{prompts.map((prompt, index) => <button key={prompt} onClick={() => send(prompt)}><span>0{index + 1}</span>{prompt}<b>↗</b></button>)}</div>
      <form className="composer" onSubmit={event => { event.preventDefault(); send(text); }}>
        <input value={text} onChange={event => setText(event.target.value)} aria-label="对 Mira 说点什么" placeholder="对 Mira 说点什么…" maxLength={800}/>
        <button className="send" type="submit" disabled={!text.trim()} aria-label="发送文字">↑</button>
        <div className="composer-divider"/>
        <button type="button" className={'talk ' + (input.held ? 'holding' : '')} disabled={voiceButton.disabled}
          onClick={() => { if (entry.needsPermission()) void entry.prepare(message => engine.inputNotice(message)); }}
          onPointerDown={event => { if (entry.canHold()) { event.currentTarget.setPointerCapture(event.pointerId); hold(); } }}
          onPointerUp={() => entry.release()} onPointerCancel={() => entry.cancelHeld()} onLostPointerCapture={() => entry.cancelHeld()}
          onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat && entry.canHold()) { event.preventDefault(); hold(); } }}
          onKeyUp={event => { if ((event.key === ' ' || event.key === 'Enter') && entry.canHold()) { event.preventDefault(); entry.release(); } }}
          onBlur={() => entry.cancelHeld()} aria-label={input.mode === 'mock' ? '体验对白（示例，不使用麦克风）' : entry.needsPermission() ? '启用麦克风（授权后再按住说话）' : voiceButton.label + '，' + voiceButton.detail}>
          <span className="mic-icon">♩</span><span>{voiceButton.label}<small>{voiceButton.detail}</small></span>
        </button>
      </form>
      {input.showMessage && <p className="voice-help" role="status" data-testid="voice-help" data-recording={input.phase === 'recording'}>{input.message}</p>}
    </section>
    <footer className="page-footer"><span>A LITTLE RAIN. A LITTLE COMPANY.</span></footer>
  </main>;
}

