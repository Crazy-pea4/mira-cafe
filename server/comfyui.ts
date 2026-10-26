import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { abortError } from '../shared/async';
import { withAbort } from '../shared/abortable';
import { MediaError, type MediaProvider, type MediaRequest, type MediaJob, type MediaImageRef } from './media';
import { validateWorkflow, prepareWorkflow, type ComfyWorkflowSpec } from './comfyui-workflow';

const imageSchema = z.object({
  filename: z.string().min(1).max(255).refine((value) => !/[\\/\x00-\x1f]/.test(value) && value !== '.' && value !== '..'),
  subfolder: z.string().max(512).default('').refine((value) => !/[\\\x00-\x1f]/.test(value) && !value.startsWith('/') && !value.split('/').includes('..')),
  type: z.literal('output'),
});
const historySchema = z.object({
  status: z.object({ status_str: z.enum(['success', 'error']), completed: z.boolean(), messages: z.array(z.unknown()).optional() }),
  outputs: z.record(z.string(), z.unknown()).default({}),
});
const queueSchema = z.object({ queue_running: z.array(z.array(z.unknown())), queue_pending: z.array(z.array(z.unknown())) });
export function comfyBaseUrl(raw: string): URL {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('URL');
    url.pathname = url.pathname.replace(/\/$/, '') + '/';
    return url;
  } catch { throw new MediaError('NOT_CONFIGURED', 'ComfyUI地址需要是无内嵌凭据的HTTP或HTTPS服务地址。'); }
}
// Native self-hosted HTTP API only, not Comfy Cloud. No server is installed here.
// The application deliberately does not instantiate this adapter or expose routes.
export class ComfyUiMediaProvider implements MediaProvider {
  readonly kind = 'comfyui' as const;
  private readonly base: URL;
  private readonly spec: ComfyWorkflowSpec;
  private readonly clientId = randomUUID();
  private cancelled = new Set<string>();
  constructor(
    baseUrl: string,
    workflowSpec: unknown,
    private fetcher: typeof fetch = fetch,
    private requestTimeoutMs = 10000,
  ) {
    this.base = comfyBaseUrl(baseUrl);
    this.spec = validateWorkflow(workflowSpec);
  }
  private id(value: string) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new MediaError('INVALID_REQUEST', '媒体任务ID不正确。');
    return value;
  }
  private async request<T>(path: string, signal: AbortSignal, read: (response: Response, operationSignal: AbortSignal) => Promise<T>, body?: unknown): Promise<T> {
    if (signal.aborted) throw abortError();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = setTimeout(cancel, this.requestTimeoutMs);
    try {
      const response = await withAbort(this.fetcher(new URL(path, this.base), {
        method: body === undefined ? 'GET' : 'POST', signal: controller.signal, redirect: 'error',
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      }), controller.signal);
      if (!response.ok) throw new MediaError(response.status >= 400 && response.status < 500 ? 'REJECTED' : 'UNAVAILABLE', 'ComfyUI请求失败，请检查服务、工作流和模型配置。');
      return await withAbort(read(response, controller.signal), controller.signal);
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (controller.signal.aborted) throw new MediaError('TIMEOUT', 'ComfyUI请求超时。');
      if (error instanceof MediaError) throw error;
      throw new MediaError('UNAVAILABLE', '无法读取ComfyUI响应，请检查服务连接。');
    } finally {
      controller.abort();
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }
  }
  async submit(input: MediaRequest, signal: AbortSignal) {
    if (signal.aborted) throw abortError();
    const workflow = prepareWorkflow(this.spec, input), jobId = randomUUID();
    try {
      // Submit once. A lost POST response may already have queued GPU work.
      const data = await this.request('prompt', signal, (response) => response.json(), {
        prompt: workflow, client_id: this.clientId, prompt_id: jobId,
      });
      if (data && typeof data === 'object' && Object.hasOwn(data, 'error'))
        throw new MediaError('REJECTED', 'ComfyUI拒绝了工作流，请检查节点和模型配置。');
      const checked = z.object({ prompt_id: z.string().min(1).max(100), node_errors: z.record(z.string(), z.unknown()).optional() }).safeParse(data);
      if (!checked.success || !/^[A-Za-z0-9_-]+$/.test(checked.data.prompt_id))
        throw new MediaError('INVALID_RESPONSE', 'ComfyUI没有返回有效的任务ID。');
      if (checked.data.node_errors && Object.keys(checked.data.node_errors).length)
        throw new MediaError('REJECTED', 'ComfyUI工作流包含节点错误，请先在目标环境修正。', checked.data.prompt_id);
      return checked.data.prompt_id;
    } catch (error) {
      if (signal.aborted) throw Object.assign(abortError(), { jobId });
      if (error instanceof MediaError && (error.code === 'UNAVAILABLE' || error.code === 'TIMEOUT' || error.code === 'INVALID_RESPONSE'))
        throw new MediaError('SUBMISSION_UNKNOWN', '提交结果未确认，请先核查任务和队列，避免重复生成。', jobId);
      throw error;
    }
  }
  async inspect(jobId: string, signal: AbortSignal): Promise<MediaJob> {
    const id = this.id(jobId);
    if (signal.aborted) throw abortError();
    if (this.cancelled.has(id)) return { id, state: 'cancelled', images: [] };
    const data = await this.request('history/' + id, signal, (response) => response.json());
    const root = z.record(z.string(), z.unknown()).safeParse(data);
    if (!root.success) throw new MediaError('INVALID_RESPONSE', 'ComfyUI任务历史格式不正确。');
    if (Object.hasOwn(root.data, id)) {
      const history = historySchema.safeParse(root.data[id]);
      if (!history.success) throw new MediaError('INVALID_RESPONSE', 'ComfyUI任务状态格式不正确。');
      const entry = history.data;
      if (entry.status.status_str === 'error') {
        const interrupted = entry.status.messages?.some((item) => Array.isArray(item) && item[0] === 'execution_interrupted');
        return { id, state: interrupted ? 'cancelled' : 'failed', images: [] };
      }
      if (entry.status.completed) {
        const output = z.object({ images: z.array(imageSchema).min(1).max(4) }).safeParse(entry.outputs[this.spec.outputNode]);
        if (!output.success) throw new MediaError('INVALID_IMAGE', '工作流未返回预期输出节点的图片。', id);
        return { id, state: 'succeeded', images: output.data.images };
      }
    }
    const queue = queueSchema.safeParse(await this.request('queue', signal, (response) => response.json()));
    if (!queue.success) throw new MediaError('INVALID_RESPONSE', 'ComfyUI队列格式不正确。');
    return { id, state: queue.data.queue_running.some((item) => item[1] === id) ? 'running' : queue.data.queue_pending.some((item) => item[1] === id) ? 'queued' : 'unknown', images: [] };
  }
  async download(image: MediaImageRef, signal: AbortSignal) {
    const checked = imageSchema.safeParse(image);
    if (!checked.success) throw new MediaError('INVALID_IMAGE', '图片文件引用不正确。');
    const query = new URLSearchParams(checked.data);
    return this.request('view?' + query, signal, async (response, operationSignal) => {
      const contentType = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType) || !response.body)
        throw new MediaError('INVALID_IMAGE', 'ComfyUI没有返回支持的图片格式。');
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let length = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      operationSignal.addEventListener('abort', cancel, { once: true });
      if (operationSignal.aborted) cancel();
      try {
        while (true) {
          const part = await reader.read();
          if (operationSignal.aborted) throw abortError();
          if (part.done) break;
          length += part.value.length;
          if (length > 10 * 1024 * 1024) throw new MediaError('INVALID_IMAGE', '生成图片超过10MiB上限。');
          chunks.push(part.value);
        }
      } finally {
        operationSignal.removeEventListener('abort', cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks);
      const signature = contentType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : contentType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!signature) throw new MediaError('INVALID_IMAGE', '生成图片的文件头与格式不匹配。');
      return { bytes, contentType };
    });
  }
  async cancel(jobId: string, signal: AbortSignal) {
    const job = await this.inspect(jobId, signal);
    if (job.state === 'cancelled') return { state: job.state, stopped: true };
    // Running tasks return stopped:false. Old ComfyUI versions can interpret
    // /interrupt globally. Local abort also cannot prove GPU work was stopped.
    if (job.state !== 'queued') return { state: job.state, stopped: false };
    await this.request('queue', signal, async () => undefined, { delete: [jobId] });
    const after = await this.inspect(jobId, signal);
    if (after.state !== 'unknown') return { state: after.state, stopped: false };
    if (this.cancelled.size >= 100) this.cancelled.delete(this.cancelled.values().next().value!);
    this.cancelled.add(jobId);
    return { state: 'cancelled' as const, stopped: true };
  }
}
