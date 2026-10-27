import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Character } from './Character';
import { Narrative } from './Narrative';
import { SCENE_ARTWORK } from './scene-artwork';
import type { Snapshot } from './core/engine';
import { ReplayPlayer, type ReplayApi, type ReplayRecorder } from './core/replay';
import { REPLAY_ASSET_VERSION, replayFrame, type ReplayEventType, type ReplaySummary } from '../shared/replay';

const LABELS: Record<ReplayEventType, string> = {
  'recording.started': '记录开始', 'input.accepted': '输入已接收', 'reply.started': '正在回应',
  'subtitle.started': '对白开始呈现', 'cue.started': '剧情演出', 'presentation.confirmed': '呈现已确认',
  'turn.cancelled': '打断与回退', 'turn.failed': '本轮失败', 'turn.completed': '本轮完成', 'story.reset': '剧情重置',
};
const time = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
function Playback({ player }: { player: ReplayPlayer }) {
  const state = useSyncExternalStore(player.subscribe, player.getSnapshot, player.getSnapshot);
  const event = player.data.events[state.index], frame = event.frame;
  const snapshot: Snapshot = { ...frame, streamingText: '', saveNotice: '' };
  return (
    <div className="replay-layout">
      <section className="replay-player" aria-label="无声剧情回放">
        <div className={`replay-preview scene-${frame.scene}`} data-replay-location={frame.location}>
          <img className="replay-background" src={SCENE_ARTWORK[frame.location].src} alt={SCENE_ARTWORK[frame.location].description} />
          <span className="replay-watermark">无声回放 · 不影响当前剧情</span>
          <div className="replay-character"><Character state={snapshot} /></div>
          <div className="replay-props"><Narrative text="" props={frame.stageProps} focus={frame.propFocus} /></div>
        </div>
        <div className="replay-caption" aria-live="polite">
          {frame.lastInput && <small>你：{frame.lastInput}</small>}
          {frame.narration && <p className="replay-narration">{frame.narration}</p>}
          <p>{frame.error || frame.subtitle || (frame.status === 'thinking' ? '正在回应…' : '这一刻没有对白。')}</p>
          <small>{LABELS[event.type]} · 第{event.turnId}轮 · 已确认{frame.story?.facts.length ?? 0}个剧情节点</small>
        </div>
        <div className="replay-controls">
          <button type="button" onClick={() => player.seek(state.index - 1)} disabled={state.index === 0}>上一步</button>
          <button type="button" onClick={() => state.playing ? player.pause() : player.play()}>{state.playing ? '暂停回放' : '播放回放'}</button>
          <button type="button" onClick={() => player.seek(state.index + 1)} disabled={state.index === player.data.events.length - 1}>下一步</button>
          <span>{time(event.atMs)} / {time(player.data.recording.durationMs)}</span>
        </div>
        <input className="replay-seek" aria-label="回放事件位置" type="range" min={0} max={player.data.events.length - 1} value={state.index} onChange={event => player.seek(Number(event.target.value))} />
        {player.data.recording.assetVersion !== REPLAY_ASSET_VERSION && <p className="notice">这段记录使用较早的素材版本，画面可能与当时不同。</p>}
      </section>
      <ol className="replay-events" aria-label="已记录事件">
        {player.data.events.map((item, index) => <li key={item.sequence}>
          <button type="button" aria-current={index === state.index ? 'step' : undefined} onClick={() => player.seek(index)}>
            <span>{time(item.atMs)} · {LABELS[item.type]}</span>
            <small>{item.type === 'input.accepted' ? item.frame.lastInput : item.frame.narration || item.frame.subtitle || `第${item.turnId}轮`}</small>
          </button>
        </li>)}
      </ol>
    </div>
  );
}
export function ReplayPanel({ api, recorder, snapshot, busy }: { api: ReplayApi; recorder: ReplayRecorder; snapshot: Snapshot; busy: boolean }) {
  const recording = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot, recorder.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const [records, setRecords] = useState<ReplaySummary[]>([]), [failure, setFailure] = useState('');
  const [loading, setLoading] = useState(false), [player, setPlayer] = useState<ReplayPlayer | null>(null);
  const operation = useRef(0);
  useEffect(() => () => { player?.dispose(); }, [player]);
  const refresh = async () => { setRecords(await api.list()); };
  const open = async () => {
    dialog.current?.showModal(); setFailure(''); setLoading(true);
    try { await refresh(); } catch { setFailure('轨迹暂时无法读取，请稍后重新打开。'); }
    finally { setLoading(false); }
  };
  const read = async (id: string) => {
    const token = ++operation.current; setFailure(''); setLoading(true);
    try { const data = await api.read(id); if (operation.current === token && dialog.current?.open) setPlayer(new ReplayPlayer(data)); }
    catch { if (operation.current === token) setFailure('这段轨迹暂时无法读取。'); }
    finally { if (operation.current === token) setLoading(false); }
  };
  const close = () => {
    operation.current++; player?.pause();
    if (recorder.getSnapshot().saving && !recorder.getSnapshot().recording) recorder.suspend();
    dialog.current?.close();
  };
  return <>
    <button className={'replay-open leave-cafe' + (recording.recording ? ' is-recording' : '')} type="button"
      disabled={recording.saving || (busy && !recording.recording)}
      aria-label={recording.recording ? '停止剧情轨迹记录' : '打开剧情轨迹与回放'}
      title={recording.recording ? '正在记录，点击停止并保存' : busy ? '回复和录音结束后可打开轨迹' : '记录、查看和回放已呈现的剧情'}
      onClick={() => { if (recording.recording) void recorder.stop(); else void open(); }}>
      {recording.recording ? '停录' : '轨迹'}
    </button>
    <dialog className="replay-dialog" ref={dialog} aria-labelledby="replay-title" onClose={() => {
      operation.current++; player?.pause(); setPlayer(null);
      if (recorder.getSnapshot().saving && !recorder.getSnapshot().recording) recorder.suspend();
    }}>
      <div className="replay-dialog-heading"><h2 id="replay-title">剧情轨迹</h2><button type="button" onClick={close}>关闭轨迹</button></div>
      <p className="replay-intro">明确开启后才记录对白与画面事件，保存在当前浏览器身份对应的数据库中。默认无声回放，不重新调用模型或语音服务。</p>
      <div className="replay-toolbar">
        <button type="button" disabled={busy || recording.saving || recording.recording} onClick={() => {
          void recorder.start(replayFrame(snapshot)).then(() => { if (recorder.getSnapshot().recording) close(); });
        }}>开始记录当前剧情</button>
        <span>最多保留5段，每段50轮或1000个事件</span>
      </div>
      {recording.notice && <p className="notice" role="status">{recording.notice}</p>}
      {failure && <p className="notice" role="alert">{failure}</p>}
      {loading && <p role="status">正在读取轨迹…</p>}
      {!loading && !records.length && <p className="replay-empty">还没有记录。点击开始记录，回到咖啡馆聊几句，再点右上角“停录”。</p>}
      <ul className="replay-library" aria-label="已保存轨迹">
        {records.map(record => <li key={record.id}>
          <div><strong>{new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false })}</strong><small>{record.turns}轮 · {record.count}个事件 · {time(record.durationMs)}{record.status === 'recording' ? ' · 未结束片段' : ''}</small></div>
          <button type="button" disabled={busy || loading} onClick={() => void read(record.id)}>回放这段轨迹</button>
          <button type="button" disabled={loading} onClick={() => {
            if (!window.confirm('删除这段轨迹及其中的对白记录？当前剧情进度不会改变。')) return;
            void api.delete(record.id).then(async () => { if (player?.data.recording.id === record.id) setPlayer(null); await refresh(); }).catch(() => setFailure('删除失败，请稍后重试。'));
          }}>删除</button>
        </li>)}
      </ul>
      {player && <>
        <div className="replay-export"><span>无声回放，只读；JSON导出包含本段对话。</span><button type="button" onClick={() => {
          const blob = new Blob([JSON.stringify(player.data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob), link = document.createElement('a');
          link.href = url; link.download = 'mira-replay-' + player.data.recording.id + '.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>导出对白 JSON</button></div>
        <Playback key={player.data.recording.id} player={player} />
      </>}
    </dialog>
  </>;
}
