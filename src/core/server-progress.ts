import { appPath } from './app-path';
import { LocalProgressStorage } from './progress-storage';
import { progressSchema, type SavedProgress } from '../../shared/progress';

export async function loadServerProgress(signal: AbortSignal): Promise<{ progress: SavedProgress | null; notice: string }> {
  const response = await fetch(appPath('api/progress'), { signal });
  if (!response.ok) throw new Error('无法加载已保存进度，请检查连接后重试。');
  const data = await response.json();
  if (data.progress) return { progress: progressSchema.parse(data.progress), notice: '' };
  let legacy: SavedProgress | null = null;
  try { legacy = new LocalProgressStorage().load(); } catch { /* A bad browser cache is not the source of truth. */ }
  if (!legacy) return { progress: null, notice: '' };
  const imported = await fetch(appPath('api/progress'), {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(legacy),
  });
  if (imported.status === 400) return { progress: null, notice: '旧存档不适用于当前模式，已回到开场。' };
  if (!imported.ok) throw new Error('旧存档暂时未能迁移，请稍后重试。');
  const result = await imported.json();
  return { progress: result.progress ? progressSchema.parse(result.progress) : null, notice: result.progress ? '已将本机旧存档迁入数据库。' : '' };
}
