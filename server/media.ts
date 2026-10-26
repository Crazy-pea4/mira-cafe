import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { abortError, delay } from '../shared/async';
import { withAbort } from '../shared/abortable';

// Server-only extension point. The current scene does not create media tasks.
// ComfyUI support is protocol-tested with fixtures, not verified on a real GPU.
export const mediaRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(800),
  negativePrompt: z.string().trim().max(800).optional(),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export type MediaRequest = z.infer<typeof mediaRequestSchema>;
export type MediaState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export type MediaImageRef = { filename: string; subfolder: string; type: 'output' };
export type MediaJob = { id: string; state: MediaState; images: MediaImageRef[] };
export type MediaImage = { bytes: Uint8Array; contentType: string };
export class MediaError extends Error {
  constructor(
    readonly code: 'NOT_CONFIGURED' | 'INVALID_REQUEST' | 'INVALID_WORKFLOW' | 'UNAVAILABLE' |
      'SUBMISSION_UNKNOWN' | 'REJECTED' | 'INVALID_RESPONSE' | 'INVALID_IMAGE' | 'TIMEOUT' | 'FAILED',
    message: string,
    readonly jobId?: string,
  ) { super(message); }
}
export interface MediaProvider {
  readonly kind: 'mock' | 'comfyui';
  submit(request: MediaRequest, signal: AbortSignal): Promise<string>;
  inspect(jobId: string, signal: AbortSignal): Promise<MediaJob>;
  download(image: MediaImageRef, signal: AbortSignal): Promise<MediaImage>;
  cancel(jobId: string, signal: AbortSignal): Promise<{ state: MediaState; stopped: boolean }>;
}
export async function waitForMedia(
  provider: MediaProvider,
  jobId: string,
  signal: AbortSignal,
  options: { timeoutMs?: number; pollMs?: number; onState?: (job: MediaJob) => void } = {},
): Promise<MediaJob> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(cancel, options.timeoutMs ?? 120000);
  let previous: MediaState | undefined;
  try {
    while (true) {
      if (controller.signal.aborted) throw abortError();
      const job = await withAbort(provider.inspect(jobId, controller.signal), controller.signal);
      if (controller.signal.aborted) throw abortError();
      if (job.state !== previous) { previous = job.state; options.onState?.(job); }
      if (job.state === 'succeeded' || job.state === 'cancelled') return job;
      if (job.state === 'failed') throw new MediaError('FAILED', '媒体生成失败，请检查工作流和模型配置。', jobId);
      // A task can finish between history and queue reads: unknown is transient.
      await delay(options.pollMs ?? 1000, controller.signal);
    }
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (controller.signal.aborted) throw new MediaError('TIMEOUT', '等待媒体生成超时，可使用任务ID继续查询。', jobId);
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
// A one-pixel fixture exercises the contract only; it is not a generated photo.
export class MockMediaProvider implements MediaProvider {
  readonly kind = 'mock' as const;
  private jobs = new Map<string, { reads: number; cancelled: boolean }>();
  async submit(request: MediaRequest, signal: AbortSignal) {
    if (signal.aborted) throw abortError();
    if (!mediaRequestSchema.safeParse(request).success)
      throw new MediaError('INVALID_REQUEST', '图片请求格式不正确。');
    const id = randomUUID();
    if (this.jobs.size >= 100) this.jobs.delete(this.jobs.keys().next().value!);
    this.jobs.set(id, { reads: 0, cancelled: false });
    return id;
  }
  async inspect(id: string, signal: AbortSignal): Promise<MediaJob> {
    if (signal.aborted) throw abortError();
    const job = this.jobs.get(id);
    const state = !job ? 'unknown' : job.cancelled ? 'cancelled' : ++job.reads === 1 ? 'queued' : job.reads === 2 ? 'running' : 'succeeded';
    return { id, state, images: state === 'succeeded' ? [{ filename: 'mock-pixel.png', subfolder: '', type: 'output' }] : [] };
  }
  async download(_image: MediaImageRef, signal: AbortSignal): Promise<MediaImage> {
    if (signal.aborted) throw abortError();
    return { contentType: 'image/png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64') };
  }
  async cancel(id: string, signal: AbortSignal) {
    if (signal.aborted) throw abortError();
    const job = this.jobs.get(id);
    if (job && job.reads >= 3 && !job.cancelled) return { state: 'succeeded' as const, stopped: false };
    if (job) job.cancelled = true;
    return { state: job ? 'cancelled' as const : 'unknown' as const, stopped: !!job };
  }
}
