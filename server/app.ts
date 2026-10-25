import Fastify from 'fastify';
import type { BudgetGuard } from './budget';
import { registerSpeech, sameLocalOrigin } from './speech-routes';
import type { SpeechProvider } from './speech';
import { cancelSchema, replySchema, turnRequestSchema } from '../shared/protocol';
import { isAbort } from '../shared/async';
import { withAbort } from '../shared/abortable';
import { type DialogueProvider, MockProvider, ProviderError } from './providers';
type Session = { latest: number; touched: number; active?: AbortController };
export function buildApp(provider: DialogueProvider = new MockProvider(), timeoutMs = 18000, speechProvider?: SpeechProvider, budget?: BudgetGuard) {
  const app = Fastify({ logger: false, bodyLimit: 24000 });
  registerSpeech(app, speechProvider);
  const sessions = new Map<string, Session>();
  function getSession(id: string) {
    let session = sessions.get(id);
    if (!session) {
      if (sessions.size >= 100) {
        const oldest = [...sessions].sort((a, b) => a[1].touched - b[1].touched)[0];
        oldest[1].active?.abort(); sessions.delete(oldest[0]);
      }
      session = { latest: 0, touched: Date.now() }; sessions.set(id, session);
    }
    session.touched = Date.now(); return session;
  }
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions) if (Date.now() - session.touched > 30 * 60_000) {
      session.active?.abort(); sessions.delete(id);
    }
  }, 60_000).unref();
  app.addHook('onClose', async () => { clearInterval(cleanup); for (const session of sessions.values()) session.active?.abort(); });
  app.get('/api/health', async () => ({ ok: true, provider: provider.kind, phase: 2, speech: speechProvider ? 'qwen' : 'mock', speechAvailable: !!speechProvider && (!budget || budget.status().enabled), ...(budget ? { budget: budget.status() } : {}) }));
  app.post('/api/cancel', async (request, reply) => {
    const parsed = cancelSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: '取消请求格式不正确。' } });
    const session = getSession(parsed.data.sessionId);
    if (parsed.data.throughTurnId >= session.latest) { session.active?.abort(); session.latest = parsed.data.throughTurnId; }
    return { ok: true };
  });
  app.post('/api/turn', async (request, reply) => {
    if (provider.kind === 'deepseek' && !sameLocalOrigin(request.headers.origin, request.headers.host)) return reply.code(403).send({ error: { code: 'ORIGIN', message: '请从本机应用页面发起请求。' } });
    const parsed = turnRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: '请输入 1–800 字内容。' } });
    const input = parsed.data;
    const session = getSession(input.sessionId);
    const stale = () => reply.code(409).send({ error: { code: 'STALE_TURN', message: '这轮对话已经结束。' } });
    if (input.turnId <= session.latest) return stale();
    session.active?.abort(); session.latest = input.turnId;
    const controller = new AbortController(); session.active = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(); };
    request.raw.on('aborted', disconnect); reply.raw.on('close', disconnect);
    try {
      const result = await withAbort(provider.reply(input, controller.signal), controller.signal);
      if (session.latest !== input.turnId) return stale();
      if (timedOut) throw new ProviderError('TIMEOUT', '等待回复超时，请重试。');
      if (controller.signal.aborted) return stale();
      const checked = replySchema.safeParse(result);
      if (!checked.success) throw new ProviderError('INVALID_REPLY', '角色回复格式异常，请重试。');
      return { turnId: input.turnId, provider: provider.kind, ...checked.data };
    } catch (error) {
      if (timedOut && session.latest === input.turnId) return reply.code(504).send({ error: { code: 'TIMEOUT', message: '等待回复超时，请重试。' } });
      if (isAbort(error) || controller.signal.aborted || session.latest !== input.turnId) return stale();
      const known = error instanceof ProviderError ? error : new ProviderError('UNAVAILABLE', '暂时无法连接角色，请重试。');
      return reply.code(known.code === 'TIMEOUT' ? 504 : known.code === 'BUDGET_LIMIT' ? 429 : 503).send({ error: { code: known.code, message: known.message } });
    } finally {
      clearTimeout(timeout); request.raw.off('aborted', disconnect); reply.raw.off('close', disconnect);
      if (session.active === controller) session.active = undefined;
    }
  });
  return app;
}

