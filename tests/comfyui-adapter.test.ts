import { describe, expect, it, vi } from 'vitest';
import example from '../workflows/comfyui-lodge.example.json';
import { ComfyUiMediaProvider } from '../server/comfyui';
import { createMediaProvider } from '../server/media-config';
import { MediaError, MockMediaProvider, waitForMedia, type MediaProvider } from '../server/media';
import { prepareWorkflow, validateWorkflow } from '../server/comfyui-workflow';

const signal = () => new AbortController().signal;
const image = { filename: '旅馆 preview.png', subfolder: 'mira/preview', type: 'output' as const };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const spec = () => {
  const value = structuredClone(example);
  value.workflow['4'].inputs.ckpt_name = 'fixture-only.safetensors';
  return value;
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const history = (id: string, status = 'success', completed = true, images: unknown = [image]) => ({
  [id]: { status: { status_str: status, completed }, outputs: { '9': { images }, '999': { images: [{ ...image, filename: 'unselected.png' }] } } },
});
function fixture(handler: (path: URL, init?: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => handler(new URL(String(url)), init));
  return { fetcher, provider: new ComfyUiMediaProvider('http://fixture.invalid/comfy/', spec(), fetcher) };
}

describe('optional media boundary and local workflow templates', () => {
  it('is disabled by default and never contacts an upstream without explicit enablement', () => {
    const fetcher = vi.fn();
    expect(createMediaProvider({}, fetcher)).toBeUndefined();
    expect(createMediaProvider({ MIRA_MEDIA_PROVIDER: 'disabled', COMFYUI_WORKFLOW_SPEC: 'missing-file' }, fetcher)).toBeUndefined();
    expect(() => createMediaProvider({ MIRA_MEDIA_PROVIDER: 'comfyui' }, fetcher)).toThrow(MediaError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects unverified model placeholders and wrong bindings before any HTTP call', () => {
    const fetcher = vi.fn();
    expect(() => new ComfyUiMediaProvider('http://fixture.invalid', example, fetcher)).toThrow(expect.objectContaining({ code: 'NOT_CONFIGURED' }));
    const wrong = spec();
    wrong.bindings.positive = 'missing';
    expect(() => validateWorkflow(wrong)).toThrow(expect.objectContaining({ code: 'INVALID_WORKFLOW' }));
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('binds only request fields into a cloned API graph, preserving the configured template', () => {
    const value = validateWorkflow(spec()), before = structuredClone(value);
    const graph = prepareWorkflow(value, { prompt: ' 新构图 ', negativePrompt: '文字', seed: 42 });
    expect(graph['6'].inputs.text).toBe('新构图');
    expect(graph['7'].inputs.text).toBe('文字');
    expect(graph['3'].inputs.seed).toBe(42);
    expect(graph['3'].inputs.model).toEqual(['4', 0]);
    expect(value).toEqual(before);
    expect(() => prepareWorkflow(value, { prompt: '' })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
  it.each(['file:///tmp/comfy', 'http://user:secret@fixture.invalid', 'https://fixture.invalid/?key=secret'])('rejects unsupported service URL %s', (url) => {
    expect(() => new ComfyUiMediaProvider(url, spec())).toThrow(expect.objectContaining({ code: 'NOT_CONFIGURED' }));
  });
  it('runs an explicit offline lifecycle and preserves completed Mock tasks on cancellation', async () => {
    const fetcher = vi.fn();
    const provider = createMediaProvider({ MIRA_MEDIA_PROVIDER: 'mock' }, fetcher)!;
    const id = await provider.submit({ prompt: '旅馆' }, signal()), states: string[] = [];
    const job = await waitForMedia(provider, id, signal(), { pollMs: 1, onState: (job) => states.push(job.state) });
    expect(states).toEqual(['queued', 'running', 'succeeded']);
    expect((await provider.download(job.images[0], signal())).bytes).toEqual(png);
    expect(await provider.cancel(id, signal())).toEqual({ state: 'succeeded', stopped: false });
    const cancelled = await provider.submit({ prompt: '第二张' }, signal());
    expect(await provider.cancel(cancelled, signal())).toEqual({ state: 'cancelled', stopped: true });
    expect((await provider.inspect(cancelled, signal())).images).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('native ComfyUI HTTP adapter with fake network only', () => {
  it('submits once with stable workflow bindings and a traceable client task ID', async () => {
    const { provider, fetcher } = fixture((_url, init) => json({ prompt_id: JSON.parse(init!.body as string).prompt_id, node_errors: {} }));
    const id = await provider.submit({ prompt: 'warm mountain lodge', seed: 123 }, signal());
    const [url, init] = fetcher.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(String(url)).toBe('http://fixture.invalid/comfy/prompt');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(body.prompt_id).toBe(id);
    expect(body.client_id).toMatch(/^[a-f\d-]{36}$/);
    expect(body.prompt['3'].inputs.seed).toBe(123);
    expect(body.prompt['6'].inputs.text).toBe('warm mountain lodge');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('distinguishes queue states, transient absence, success and the selected image output', async () => {
    let state = 'queued';
    const { provider } = fixture((url) => url.pathname.endsWith('/history/job-1')
      ? json(state === 'succeeded' ? history('job-1') : {})
      : json({ queue_running: state === 'running' ? [[0, 'job-1']] : [], queue_pending: state === 'queued' ? [[1, 'job-1']] : [] }));
    for (state of ['queued', 'running', 'unknown', 'succeeded']) {
      const job = await provider.inspect('job-1', signal());
      expect(job.state).toBe(state);
      expect(job.images).toEqual(state === 'succeeded' ? [image] : []);
    }
  });
  it('maps failed and interrupted history without exposing raw upstream exception text', async () => {
    for (const interrupted of [false, true]) {
      const { provider } = fixture(() => json({ 'job-1': {
        status: { status_str: 'error', completed: false, messages: [[interrupted ? 'execution_interrupted' : 'execution_error', { exception_message: 'private upstream content' }]] }, outputs: {},
      } }));
      expect(await provider.inspect('job-1', signal())).toEqual({ id: 'job-1', state: interrupted ? 'cancelled' : 'failed', images: [] });
    }
  });
  it('rejects node errors and HTTP validation failures without resubmission', async () => {
    for (const result of [json({ error: 'invalid graph' }, 400), json({ prompt_id: 'job-1', node_errors: { '4': { secret: 'not installed' } } })]) {
      const { provider, fetcher } = fixture(() => result);
      await expect(provider.submit({ prompt: '旅馆' }, signal())).rejects.toMatchObject({ code: 'REJECTED' });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it('marks a lost submission as uncertain with a recovery ID, never blindly retries', async () => {
    const { provider, fetcher } = fixture(() => { throw new TypeError('lost response'); });
    const error = await provider.submit({ prompt: '旅馆' }, signal()).catch((error) => error);
    expect(error).toMatchObject({ code: 'SUBMISSION_UNKNOWN', jobId: JSON.parse(fetcher.mock.calls[0][1]!.body as string).prompt_id });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('deletes only the specified pending task and reports running tasks as not stopped', async () => {
    let state = 'queued';
    const { provider, fetcher } = fixture((url, init) => {
      if (url.pathname.includes('/history/')) return json({});
      if (init?.method === 'POST') { expect(JSON.parse(init.body as string)).toEqual({ delete: ['job-1'] }); state = 'unknown'; return new Response(null); }
      return json({ queue_running: state === 'running' ? [[0, 'job-1']] : [], queue_pending: state === 'queued' ? [[1, 'job-1']] : [] });
    });
    expect(await provider.cancel('job-1', signal())).toEqual({ state: 'cancelled', stopped: true });
    expect((await provider.inspect('job-1', signal())).state).toBe('cancelled');
    state = 'running';
    const running = fixture((url) => url.pathname.includes('/history/') ? json({}) : json({ queue_running: [[0, 'job-2']], queue_pending: [] }));
    expect(await running.provider.cancel('job-2', signal())).toEqual({ state: 'running', stopped: false });
    expect([...fetcher.mock.calls, ...running.fetcher.mock.calls].some(([url]) => String(url).includes('interrupt'))).toBe(false);
  });
  it('does not falsely mark cancelled when a queued job starts during deletion', async () => {
    let posted = false;
    const { provider } = fixture((url, init) => {
      if (url.pathname.includes('/history/')) return json({});
      if (init?.method === 'POST') { posted = true; return new Response(null); }
      return json({ queue_running: posted ? [[0, 'job-1']] : [], queue_pending: posted ? [] : [[1, 'job-1']] });
    });
    expect(await provider.cancel('job-1', signal())).toEqual({ state: 'running', stopped: false });
  });
  it('encodes output references and returns bounded image bytes', async () => {
    const { provider, fetcher } = fixture(() => new Response(png, { headers: { 'Content-Type': 'image/png' } }));
    expect(await provider.download(image, signal())).toEqual({ bytes: png, contentType: 'image/png' });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe('/comfy/view');
    expect(url.searchParams.get('filename')).toBe(image.filename);
    expect(url.searchParams.get('subfolder')).toBe('mira/preview');
    await expect(provider.download({ ...image, filename: '../private.png' }, signal())).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects wrong output nodes, invalid status and non-image or oversized downloads', async () => {
    const badJobs = [history('job-1', 'success', true, []), { 'job-1': { status: {} } }];
    for (const value of badJobs) await expect(fixture(() => json(value)).provider.inspect('job-1', signal())).rejects.toBeInstanceOf(MediaError);
    for (const body of [new Response('error', { headers: { 'Content-Type': 'text/html' } }), new Response('not PNG', { headers: { 'Content-Type': 'image/png' } }), new Response(new Uint8Array(10 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } })]) {
      await expect(fixture(() => body).provider.download(image, signal())).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    }
  });
  it('times out a stalled download and closes its reader', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const provider = new ComfyUiMediaProvider('http://fixture.invalid', spec(), async () => new Response(body, { headers: { 'Content-Type': 'image/png' } }), 15);
    await expect(provider.download(image, signal())).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('aborts before submit without issuing a request and bounds a non-cooperative status lookup', async () => {
    const controller = new AbortController(); controller.abort();
    const { provider, fetcher } = fixture(() => json({}));
    await expect(provider.submit({ prompt: '旅馆' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
    const stalled: MediaProvider = { ...new MockMediaProvider(), kind: 'mock', submit: vi.fn(), inspect: () => new Promise(() => {}), download: vi.fn(), cancel: vi.fn() };
    await expect(waitForMedia(stalled, 'job-1', signal(), { timeoutMs: 15 })).rejects.toMatchObject({ code: 'TIMEOUT', jobId: 'job-1' });
  });
});
