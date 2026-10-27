import {
  newStory,
  storyContext,
  storyViolation,
  prepareStory,
  acknowledgeStory,
  type StoryState,
  type PendingStory,
} from './story';
import { presentationSchema } from '../shared/story';
import Fastify from 'fastify';
import { registerAccess } from './access';
import { originAllowed, type Deployment } from './deployment';
import { withBasePath } from '../shared/base-path';
import type { RequestAudit } from './request-audit';
import { registerSpeech } from './speech-routes';
import type { SpeechProvider } from './speech';
import { cancelSchema, replySchema, turnRequestSchema, type TurnStreamEvent } from '../shared/protocol';
import { PassThrough } from 'node:stream';
import { isAbort } from '../shared/async';
import { withAbort } from '../shared/abortable';
import { randomBytes } from 'node:crypto';
import { storySaves } from './story-save';
import { type DialogueProvider, MockProvider, ProviderError } from './providers';
import { AppDatabase, StorageConflict, type StoredConversation } from './database';
import { confirmedProgress } from './persisted-progress';
import { progressSchema } from '../shared/progress';
import { timingBatchSchema } from '../shared/timing';
type Session = {
  owner: string | null;
  latest: number;
  touched: number;
  started: boolean;
  active?: AbortController;
  story: StoryState;
  pending?: PendingStory;
  stored?: StoredConversation;
};
export function buildApp(
  provider: DialogueProvider = new MockProvider(),
  timeoutMs = 18000,
  speechProvider?: SpeechProvider,
  audit?: RequestAudit,
  deployment: Deployment = { basePath: '' },
  saveKey = randomBytes(32).toString('hex'),
  database?: AppDatabase,
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 64000,
    trustProxy: deployment.auth ? '127.0.0.1' : false,
  });
  const path = (suffix: string) => withBasePath(deployment.basePath, suffix);
  const access = registerAccess(app, deployment, database);
  registerSpeech(app, speechProvider, {
    basePath: deployment.basePath,
    publicOrigin: deployment.publicOrigin,
    access,
  });
  const origin = (value: string | undefined, host: string | undefined) =>
    originAllowed(value, host, deployment.publicOrigin);
  const sessionKey = (id: string, owner: string | null) => (owner ?? 'local') + ':' + id;
  const sessions = new Map<string, Session>();
  const scope = deployment.basePath + ':' + provider.kind;
  const saves = storySaves(
    deployment.auth?.passwordHash ?? saveKey,
    scope,
  );
  function getSession(id: string, owner: string | null) {
    const key = sessionKey(id, owner);
    let session = sessions.get(key);
    if (!session) {
      if (sessions.size >= 100) {
        const oldest = [...sessions].sort((a, b) => a[1].touched - b[1].touched)[0];
        oldest[1].active?.abort();
        sessions.delete(oldest[0]);
      }
      const stored = database && owner ? database.current(owner, scope) : undefined;
      session = { owner, latest: 0, touched: Date.now(), started: false, story: stored?.state ?? newStory(), stored };
      sessions.set(key, session);
    }
    session.touched = Date.now();
    return session;
  }
  if (database) {
    app.setErrorHandler((error, _request, reply) => {
      const status = (error as { statusCode?: number }).statusCode;
      return reply.code(status === 400 || status === 413 ? status : 503).send({ error: { code: 'STORAGE_UNAVAILABLE', message: '数据暂时无法处理，请刷新后重试。' } });
    });
    app.addHook('preHandler', async (request, reply) => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !origin(request.headers.origin, request.headers.host))
        return reply.code(403).send({ error: { code: 'ORIGIN' } });
    });
    app.get(path('api/progress'), async request => ({ progress: database.current(request.miraOwner!, scope).progress }));
    app.post(path('api/progress'), async (request, reply) => {
      const parsed = progressSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_SAVE' } });
      const restored = saves.open(parsed.data.checkpoint);
      if (!restored) return reply.code(400).send({ error: { code: 'INVALID_SAVE' } });
      const current = database.current(request.miraOwner!, scope);
      if (current.revision > 0 || current.progress || !database.canImport(request.miraOwner!, scope)) return { progress: current.progress };
      const progress = { ...parsed.data, view: { ...parsed.data.view, story: { act: restored.act, facts: restored.facts, ending: restored.ending, planQuote: restored.planQuote, declined: restored.declined }, suggestions: restored.lastSuggestions } };
      try { database.save(current, restored, progress); }
      catch (error) { if (!(error instanceof StorageConflict)) throw error; }
      return { progress: database.current(request.miraOwner!, scope).progress };
    });
    app.delete(path('api/progress'), async request => {
      for (const [key, session] of sessions) if (session.owner === request.miraOwner) { session.active?.abort(); sessions.delete(key); }
      database.reset(request.miraOwner!, scope);
      return { ok: true };
    });
    app.post(path('api/timings'), async (request, reply) => {
      const parsed = timingBatchSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_TIMING' } });
      database.timings(request.miraOwner!, scope, parsed.data.pageId, parsed.data.records);
      return { ok: true };
    });
    app.get(path('api/timings'), async request => ({ records: database.timingHistory(request.miraOwner!, scope) }));
  }
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions)
      if (Date.now() - session.touched > 30 * 60_000) {
        session.active?.abort();
        sessions.delete(id);
      }
  }, 60_000).unref();
  app.addHook('onClose', async () => {
    clearInterval(cleanup);
    for (const session of sessions.values()) session.active?.abort();
  });
  app.get(path('api/health'), async () => ({
    ok: true,
    provider: provider.kind,
    phase: 2,
    authentication: { required: access.enabled },
    speech: speechProvider ? 'qwen' : 'mock',
    speechAvailable: !!speechProvider,
    usagePolicy: { localLimits: false },
    ...(audit ? { usage: audit.status() } : {}),
    ...(database ? { storage: { engine: 'sqlite', schemaVersion: 1 } } : {}),
  }));
  app.post(path('api/cancel'), async (request, reply) => {
    const parsed = cancelSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: '取消请求格式不正确。' } });
    const session = getSession(parsed.data.sessionId, request.miraOwner ?? request.miraSession);
    if (parsed.data.throughTurnId >= session.latest) {
      session.active?.abort();
      session.pending = undefined;
      session.latest = parsed.data.throughTurnId;
    }
    return { ok: true };
  });
  app.post(path('api/presented'), async (request, reply) => {
    if (provider.kind === 'deepseek' && !origin(request.headers.origin, request.headers.host))
      return reply.code(403).send({ error: { code: 'ORIGIN' } });
    const parsed = presentationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'BAD_PRESENTATION' } });
    const session = sessions.get(sessionKey(parsed.data.sessionId, request.miraOwner ?? request.miraSession));
    if (
      !session?.pending ||
      session.latest !== parsed.data.turnId ||
      session.pending.turnId !== parsed.data.turnId
    )
      return reply.code(409).send({ error: { code: 'STALE_TURN' } });
    const from = session.pending.through;
    const previous = database ? structuredClone(session.story) : undefined;
    const ack = acknowledgeStory(session.story, session.pending, parsed.data.through);
    if (!ack) return reply.code(400).send({ error: { code: 'BAD_PRESENTATION' } });
    if (database && session.stored && from < session.pending.through) {
      const progress = confirmedProgress(session.story, saves.seal(session.story), session.pending, from, session.stored.progress);
      try {
        session.stored = database.save(session.stored, session.story, progress, session.pending.historyEntry ? {
          key: parsed.data.sessionId + ':' + parsed.data.turnId,
          user: session.pending.input, assistant: session.pending.historyEntry.content,
        } : undefined);
      } catch (error) {
        session.story = previous!; session.pending = undefined;
        if (error instanceof StorageConflict) return reply.code(409).send({ error: { code: 'PROGRESS_CHANGED', message: '其他页面已更新进度，请刷新后继续。' } });
        throw error;
      }
    }
    session.touched = Date.now();
    return { ...ack, checkpoint: saves.seal(session.story) };
  });
  app.post(path('api/turn'), async (request, reply) => {
    if (provider.kind === 'deepseek' && !origin(request.headers.origin, request.headers.host))
      return reply
        .code(403)
        .send({ error: { code: 'ORIGIN', message: '请从当前应用页面发起请求。' } });
    const parsed = turnRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: '请输入 1–800 字内容。' } });
    const input = parsed.data;
    // Each page load owns a fresh session. Only a signed, already acknowledged
    // checkpoint can seed its authoritative history, including after eviction,
    // server restart or invitation re-login. Pending replies are never restored.
    const restored = input.checkpoint ? saves.open(input.checkpoint) : undefined;
    if (input.checkpoint && !restored)
      return reply.code(400).send({
        error: {
          code: 'INVALID_SAVE',
          message: '这份剧情存档无法恢复，请点击“重置剧情”重新开始。',
        },
      });
    const session = getSession(input.sessionId, request.miraOwner ?? request.miraSession);
    const stale = () =>
      reply.code(409).send({ error: { code: 'STALE_TURN', message: '这轮对话已经结束。' } });
    if (input.turnId <= session.latest) return stale();
    // A microphone press / page cleanup may have sent cancellation before the
    // first turn. That tombstone must not prevent checkpoint hydration.
    if (!session.started && restored && !session.stored) session.story = restored;
    if (!session.started && database && session.owner) {
      session.stored = database.current(session.owner, scope);
      session.story = session.stored.state;
    }
    session.started = true;
    session.active?.abort();
    session.pending = undefined;
    session.latest = input.turnId;
    const controller = new AbortController();
    session.active = controller;
    const unwatch = access.watch(request.miraSession, () => controller.abort());
    const stream = request.headers.accept?.includes('text/event-stream') ? new PassThrough() : undefined;
    const send = (event: TurnStreamEvent) => {
      if (stream && !stream.destroyed && !stream.writableEnded)
        stream.write('data: ' + JSON.stringify(event) + '\n\n');
    };
    const failed = (status: number, code: string, message: string) => {
      if (stream) {
        send({ type: 'error', turnId: input.turnId, error: { code, message } });
        return reply;
      }
      return reply.code(status).send({ error: { code, message } });
    };
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const disconnect = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    request.raw.on('aborted', disconnect);
    reply.raw.on('close', disconnect);
    if (stream) {
      reply
        .type('text/event-stream; charset=utf-8')
        .header('Cache-Control', 'no-cache, no-transform')
        .header('X-Accel-Buffering', 'no')
        .send(stream);
      send({ type: 'start', turnId: input.turnId });
    }
    try {
      const result = await withAbort(
        provider.reply(
          { ...input, history: session.story.history, storyContext: storyContext(session.story) },
          controller.signal,
          undefined,
          stream ? (text) => {
            if (session.latest === input.turnId && !controller.signal.aborted)
              send({ type: 'text', turnId: input.turnId, text: text.slice(0, 241) });
          } : undefined,
        ),
        controller.signal,
      );
      if (session.latest !== input.turnId) return failed(409, 'STALE_TURN', '这轮对话已经结束。');
      if (timedOut) throw new ProviderError('TIMEOUT', '等待回复超时，请重试。');
      if (controller.signal.aborted) return failed(409, 'STALE_TURN', '这轮对话已经结束。');
      const checked = replySchema.safeParse(result);
      if (!checked.success) throw new ProviderError('INVALID_REPLY', '角色回复格式异常，请重试。');
      const violations = storyViolation(storyContext(session.story), checked.data, input.text);
      if (violations.length)
        throw new ProviderError('INVALID_REPLY', '剧情没有衔接上，请换一句话继续。', violations);
      session.pending = prepareStory(session.story, input, checked.data);
      const { suggestions: _pendingSuggestions, ...visible } = session.pending.reply;
      const response = { turnId: input.turnId, provider: provider.kind, ...visible };
      if (stream) {
        send({ type: 'reply', reply: response });
        return reply;
      }
      return response;
    } catch (error) {
      if (timedOut && session.latest === input.turnId)
        return failed(504, 'TIMEOUT', '等待回复超时，请重试。');
      if (isAbort(error) || controller.signal.aborted || session.latest !== input.turnId)
        return failed(409, 'STALE_TURN', '这轮对话已经结束。');
      const known =
        error instanceof ProviderError
          ? error
          : new ProviderError('UNAVAILABLE', '暂时无法连接角色，请重试。');
      return failed(known.code === 'TIMEOUT' ? 504 : 503, known.code, known.message);
    } finally {
      unwatch();
      clearTimeout(timeout);
      request.raw.off('aborted', disconnect);
      reply.raw.off('close', disconnect);
      if (session.active === controller) session.active = undefined;
      stream?.end();
    }
  });
  return app;
}
