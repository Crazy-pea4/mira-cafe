import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SceneAudio } from './core/scene-audio';
import { VoiceInput } from './core/voice-input';
import { LocalSpeechTransport } from './core/speech-transport';
import { ConversationEngine } from './core/engine';
import { HttpTransport } from './core/transport';
import type { Fault } from '../shared/protocol';
import { Character } from './Character';
import { SCENE_ARTWORK } from './scene-artwork';
import { UserMessage, type InputSource } from './UserMessage';
const STATUS = { idle: '在等你开口', listening: '正在倾听', thinking: '正在想怎么说', speaking: '正在说话', error: '连接暂时中断' };
const prompts = ['雨这么大，你怎么还没走？', '你在等谁？', '能看看你的照片吗？'];
export function App() {
  const [{ engine, audio, voice }] = useState(() => { const audio = new SceneAudio(); return { engine: new ConversationEngine(new HttpTransport(), audio), audio, voice: new VoiceInput(new LocalSpeechTransport()) }; });
  const state = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const [text, setText] = useState('');
  const [inputSource, setInputSource] = useState<InputSource>('text');
  const [isHolding, setIsHolding] = useState(false);
  const [backgroundReady, setBackgroundReady] = useState(false);
  const [muted, setMuted] = useState(true);
  const [tools, setTools] = useState(false);
  const [fault, setFault] = useState<Fault>('none');
  const [provider, setProvider] = useState('mock');
  const [budget, setBudget] = useState<{capCny:number;reservedCny:number;totalRequests:number;maxRequests:number;reason:string} | null>(null);
  const [speechAvailable, setSpeechAvailable] = useState(false);
  const [inputMode, setInputMode] = useState<'mock' | 'live'>('mock');
  const [voiceMessage, setVoiceMessage] = useState('');
  const holding = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/health', { signal: controller.signal }).then(r => r.json()).then(d => { setProvider(d.provider); setBudget(d.budget ?? null); setSpeechAvailable(!!d.speechAvailable); if (audio.live !== !!d.speechAvailable) { audio.disable(); setMuted(true); } audio.live = !!d.speechAvailable; }).catch(() => {});
    const blur = () => { holding.current = false; setIsHolding(false); voice.cancel(); engine.endListening(); };
    window.addEventListener('blur', blur);
    return () => { controller.abort(); voice.cancel(); audio.disable(); engine.dispose(); window.removeEventListener('blur', blur); };
  }, [engine, voice, audio]);
  useEffect(() => {
    if (!tools) return;
    const controller = new AbortController();
    void fetch('/api/health', { signal: controller.signal }).then(r => r.json()).then(d => setBudget(d.budget ?? null)).catch(() => {});
    return () => controller.abort();
  }, [tools, state.status]);
  const send = (value: string, source: InputSource = 'text') => { if (!value.trim() || value.trim().length > 800) return; setInputSource(source); voice.cancel(); holding.current = false; setIsHolding(false); setText(''); const nextFault = fault; setFault('none'); void engine.submit(value, nextFault); };
  const hold = () => {
    if (holding.current) return;
    holding.current = true; setIsHolding(true); setVoiceMessage(''); voice.cancel(); engine.interrupt(true);
    if (inputMode === 'live' && speechAvailable) {
      const turnId = engine.getSnapshot().turnId;
      void voice.start(turnId, {
        text: value => { if (engine.getSnapshot().turnId === turnId) send(value, 'asr'); },
        error: message => { if (engine.getSnapshot().turnId === turnId) { holding.current = false; setIsHolding(false); engine.inputNotice(message); } },
        state: setVoiceMessage,
      });
    }
  };
  const release = () => {
    if (!holding.current) return; holding.current = false; setIsHolding(false);
    if (inputMode === 'live' && speechAvailable) void voice.finish();
    else send(prompts[state.photo ? 0 : state.completed ? 2 : 1], 'mock-voice');
  };
  const cancelHold = () => { if (!holding.current) return; holding.current = false; setIsHolding(false); voice.cancel(); engine.endListening(); };
  const toggleSound = async () => {
    voice.cancel(); engine.interrupt();
    if (!muted) { audio.disable(); setMuted(true); return; }
    try { await audio.enable(); setMuted(false); }
    catch { audio.disable(); setMuted(true); engine.inputNotice('浏览器尚未允许声音，仍保持静音。'); }
  };
  const active = state.status === 'speaking' || state.status === 'thinking';
  return <main className={`app scene-${state.scene}`}>
    <div className="ambient-grain"/>
    <header className="topbar">
      <a className="brand" href="/" aria-label="Mira Café 首页"><span className="brand-icon">☾</span><span>MIRA <b>CAFÉ</b></span></a>
      <div className="top-actions"><span className="mode-chip"><i/>{provider === 'deepseek' ? 'DeepSeek 文字' : 'MOCK 体验'}</span>
        <button className="icon-button sound-button" aria-pressed={!muted} aria-label={muted ? '开启声音（将播放角色语音）' : '关闭声音并停止当前播放'} onClick={() => void toggleSound()}>{muted ? '声音关闭' : '声音开启'}</button>
      </div>
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
      <div className="asset-note">已确认立绘 · 眨眼模拟 / {state.presentation === 'audio-clock' ? '播放状态嘴型，非音素' : '静音模拟嘴型'}</div>
      <div className="dialogue-area">
        <div className="character-meta"><div><span className="name">Mira</span><span className="descriptor">旅行摄影师 · 26</span></div><span className={`state-badge ${state.status}`} data-testid="state"><i/>{STATUS[state.status]}</span></div>
        <div className="subtitle-box">
          {state.status === 'error' ? <div className="error-content" role="alert"><span>{state.error}</span><button onClick={() => void engine.retry()}>重试这一句 ↻</button></div>
            : <p aria-live="polite" data-testid="subtitle">{state.status === 'listening' ? (inputMode === 'live' ? voiceMessage : '我在听。松开后将发送预设的模拟语音台词。') : state.subtitle || (state.status === 'thinking' ? <span className="thinking-dots"><i/><i/><i/></span> : '你可以继续说，我在这里。')}</p>}
          {active && <button className="interrupt" onClick={() => engine.interrupt()} aria-label="立即打断当前回复">■ 打断</button>}
        </div>
        {state.notice && <div className="notice" role="status">{state.notice}</div>}
      </div>
    </section>
    <section className="interaction" aria-label="与 Mira 对话">
      <UserMessage text={state.lastInput} source={inputSource}/>
      <div className="suggestions">{prompts.map((prompt, index) => <button key={prompt} onClick={() => send(prompt)}><span>0{index + 1}</span>{prompt}<b>↗</b></button>)}</div>
      <form className="composer" onSubmit={event => { event.preventDefault(); send(text); }}>
        <input value={text} onChange={event => setText(event.target.value)} aria-label="对 Mira 说点什么" placeholder="对 Mira 说点什么…" maxLength={800}/>
        <button className="send" type="submit" disabled={!text.trim()} aria-label="发送文字">↑</button>
        <div className="composer-divider"/>
        <button type="button" className={`talk ${state.status === 'listening' ? 'holding' : ''}`}
          onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); hold(); }}
          onPointerUp={release} onPointerCancel={cancelHold} onLostPointerCapture={cancelHold}
          onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); hold(); } }}
          onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); release(); } }}
          onBlur={cancelHold} aria-label={inputMode === 'live' ? '按住录音并发送到 Qwen，松开停止并识别为文字' : '按住体验模拟语音，松开发送预设台词'}>
          <span className="mic-icon">♩</span><span>{state.status === 'listening' ? (isHolding ? (inputMode === 'live' ? '松开识别' : '松开发送') : '识别中…') : inputMode === 'live' ? '按住录音' : '按住体验'}<small>{inputMode === 'live' ? '真实麦克风' : '模拟语音'}</small></span>
        </button>
      </form>
      <div className="interaction-footer"><span>默认静音 <i>·</i> {inputMode === 'live' ? '按住录音 → 松开识别；文字显示为你的消息并发送' : '模拟语音不会录音；开启声音需主动点击'}</span><button onClick={() => setTools(!tools)} aria-expanded={tools}>体验工具 {tools ? '−' : '+'}</button></div>
      {tools && <div className="demo-tools">
        <label>输入模式<select aria-label="输入模式" value={inputMode} onChange={event => { voice.cancel(); holding.current = false; setIsHolding(false); engine.interrupt(); setInputMode(event.target.value as 'mock' | 'live'); }}><option value="mock">模拟语音（不录音）</option><option value="live" disabled={!speechAvailable}>{speechAvailable ? '真实麦克风 → Qwen' : '真实麦克风（未配置）'}</option></select></label>
        <label>下一轮演示<select aria-label="下一轮演示" value={fault} onChange={event => setFault(event.target.value as Fault)}><option value="none">正常回复</option><option value="slow">延迟回复（可打断）</option><option value="timeout">模拟超时</option><option value="error">模拟服务失败</option></select></label>
        <button onClick={() => { audio.failNext = true; send('能看看你的照片吗？'); }}>演示朗读失败</button>
        <button onClick={() => { holding.current = false; setIsHolding(false); voice.cancel(); engine.reset(); }}>重新相遇 ↻</button>
        <span>场景随对话推进 · 已完成 {state.completed} 轮</span>
        {budget && <div className="budget-status" data-testid="budget">测试合计预算 ¥{budget.capCny} · 本地预留 ¥{budget.reservedCny.toFixed(2)} · 请求 {budget.totalRequests}/{budget.maxRequests}
          <small>预留不等于实际账单。{budget.reason || '接近上限会停止新请求；失败与取消不返还预留。'}</small></div>}
      </div>}
    </section>
    <footer className="page-footer"><span>A LITTLE RAIN. A LITTLE COMPANY.</span><span>本地开发预览 / PHASE 02</span></footer>
  </main>;
}

