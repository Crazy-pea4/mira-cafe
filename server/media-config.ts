import { readFileSync } from 'node:fs';
import { MediaError, MockMediaProvider, type MediaProvider } from './media';
import { ComfyUiMediaProvider } from './comfyui';

// Used only by the explicit adapter demo / a future media service. server/index.ts
// does not call this factory, so production cannot start GPU jobs through it.
export function createMediaProvider(
  env: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch,
): MediaProvider | undefined {
  const kind = env.MIRA_MEDIA_PROVIDER ?? 'disabled';
  if (kind === 'disabled') return;
  if (kind === 'mock') return new MockMediaProvider();
  if (kind !== 'comfyui' || env.MIRA_ENABLE_MEDIA_APIS !== 'true' ||
      !env.COMFYUI_BASE_URL || !env.COMFYUI_WORKFLOW_SPEC)
    throw new MediaError('NOT_CONFIGURED', 'ComfyUI适配层需要显式启用、服务地址和已验证的工作流配置文件。');
  let spec: unknown;
  try { spec = JSON.parse(readFileSync(env.COMFYUI_WORKFLOW_SPEC, 'utf8')); }
  catch { throw new MediaError('INVALID_WORKFLOW', '无法读取ComfyUI工作流配置文件。'); }
  return new ComfyUiMediaProvider(env.COMFYUI_BASE_URL, spec, fetcher);
}
