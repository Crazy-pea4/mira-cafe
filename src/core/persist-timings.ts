import { appPath } from './app-path';
import type { InteractionTiming } from './interaction-timing';

export function persistTimings(timing: InteractionTiming) {
  const pageId = crypto.randomUUID(), sent = new Set<number>();
  let timer: ReturnType<typeof setTimeout> | undefined, pending = Promise.resolve();
  const flush = () => {
    const records = timing.getSnapshot().filter(record => record.status !== 'running' && !sent.has(record.id));
    if (!records.length) return;
    for (const record of records) sent.add(record.id);
    const retained = new Set(timing.getSnapshot().map(record => record.id));
    for (const id of sent) if (!retained.has(id)) sent.delete(id);
    pending = pending.then(async () => {
      const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(appPath('api/timings'), {
          method: 'POST', signal: controller.signal, keepalive: true,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId, records }),
        });
        if (!response.ok) throw new Error('save');
        timing.setStorageNotice('');
      } catch { timing.setStorageNotice('部分耗时记录未能保存到服务端，本页仍可查看。'); }
      finally { clearTimeout(deadline); }
    });
  };
  const unsubscribe = timing.subscribe(() => {
    clearTimeout(timer); timer = setTimeout(flush, 250);
  });
  return () => { unsubscribe(); clearTimeout(timer); flush(); };
}
