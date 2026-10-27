import { useSyncExternalStore } from 'react';
import { firstReplyAudioMs, type InteractionTiming, type TimingRecord } from './core/interaction-timing';

const KINDS = { asr: '语音识别', model: '模型回复', tts: '语音合成', playback: '语音播放' };
const STATUS = { running: '进行中', complete: '已完成', cancelled: '已取消', error: '失败' };
const MODE = { live: '真实链路', mock: '演示模式', unknown: '配置待确认' };
function duration(ms: number | undefined) {
  return ms === undefined ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
function measurements(record: TimingRecord): [string, number | undefined][] {
  const { points, status, elapsedMs } = record;
  const complete = status === 'complete' ? elapsedMs : undefined;
  if (record.kind === 'asr') return [
    ['连接就绪', points.ready],
    ['识别等待', complete !== undefined && points.commit !== undefined ? complete - points.commit : undefined],
  ];
  if (record.kind === 'model') return [['模型首字', points.firstText], ['完整回复', complete]];
  if (record.kind === 'tts') return [['TTS 首包', points.firstAudio], ['音频接收完成', complete]];
  return [['本句开播等待', points.firstPlayback], ['本句总耗时', complete]];
}
export function TimingDebugPanel({ timing }: { timing: InteractionTiming }) {
  const records = useSyncExternalStore(timing.subscribe, timing.getSnapshot, timing.getSnapshot);
  const latestModel = [...records].reverse().find(record => record.kind === 'model');
  const firstAudio = latestModel?.turnId === undefined ? undefined : firstReplyAudioMs(records, latestModel.turnId);
  return (
    <details className="timing-debug">
      <summary aria-label="语音耗时调试面板">语音耗时</summary>
      <section className="timing-panel" aria-label="语音耗时详情">
        <div className="timing-heading">
          <h2>语音耗时</h2>
          <button type="button" onClick={timing.clear}>清空记录</button>
        </div>
        <p className="timing-description">仅保留本页最近20个阶段，不保存对白和音频。打开面板不会额外请求服务。</p>
        {latestModel && (
          <div className="timing-first-audio">
            <span>最近回复首声 · 第{latestModel.turnId}轮</span>
            <strong>{duration(firstAudio)}</strong>
            <small>从模型请求开始，到播放器首次开播；包含校验、剧情等待和语音准备。</small>
          </div>
        )}
        {!records.length ? <p className="timing-empty">发送一句文字或语音后，这里会显示各阶段耗时。</p> : (
          <ol className="timing-records">
            {[...records].reverse().map(record => (
              <li key={record.id} data-kind={record.kind} data-status={record.status}>
                <div className="timing-record-heading">
                  <strong>{KINDS[record.kind]}</strong>
                  <span>{MODE[record.mode]} · {STATUS[record.status]}</span>
                </div>
                <small>#{record.id}{record.kind !== 'asr' && record.turnId !== undefined ? ` · 第${record.turnId}轮` : ' · 识别片段'}</small>
                <dl>{measurements(record).map(([label, ms]) => (
                  <div key={label}><dt>{label}</dt><dd>{duration(ms)}</dd></div>
                ))}</dl>
              </li>
            ))}
          </ol>
        )}
        <p className="timing-footnote">识别等待从提交录音到最终转写，不含整段讲话时间。首包到达和实际开播分别计时；数值包含网络及代理开销，非服务商纯推理耗时。取消或失败的阶段不会记为成功。刷新后清空。</p>
      </section>
    </details>
  );
}
