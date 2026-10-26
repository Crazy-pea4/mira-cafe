// Explicit, bounded operator check. Never imported by the app or npm test.
// Credentials are loaded in-process by node --env-file; never printed or persisted.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from '../server/app';
import { DeepSeekProvider } from '../server/providers';
import { resolveConfig } from '../server/config';
import { BudgetGuard, FileBudgetStore } from './legacy-test-budget';
import { retryDialogue } from '../server/retry-dialogue';
import { budgetDialogue } from './legacy-test-providers';
import { ConversationEngine } from '../src/core/engine';
import type { Transport } from '../src/core/transport';
import type { AudioPlayer } from '../src/core/audio';
import { abortError } from '../shared/async';

async function main() {
  const phase =
    process.argv[2] === '--authorized-before'
      ? 'before'
      : process.argv[2] === '--authorized-after'
        ? 'after'
        : process.argv[2] === '--authorized-final-two'
          ? 'final-two'
          : process.argv[2] === '--authorized-strict-three'
            ? 'strict-three'
            : undefined;
  if (!phase) {
    console.log('No request sent: explicit authorized phase required.');
    return;
  }
  const marker = resolve('.local/multiturn-2026-10-25-' + phase + '.json');
  if (existsSync(marker)) {
    console.log('REPLAY_BLOCKED: phase already recorded; no request sent.');
    return;
  }
  const config = resolveConfig(process.env);
  if (!config.deepseek || config.deepseek.model !== 'deepseek-flash') throw Error('CONFIGURATION');
  const limit =
    phase === 'strict-three' ? 9 : phase === 'before' ? 3 : phase === 'final-two' ? 2 : 8;
  const budget = new BudgetGuard(new FileBudgetStore(resolve('.local/budget.json')), {
    confirmed: process.env.MIRA_BILLING_CONFIRMED === 'true',
    modelSupported: true,
    maxRequests: Number(process.env.MIRA_MAX_LIVE_REQUESTS ?? 60),
  });
  const before = budget.status();
  if (
    !before.enabled ||
    before.totalRequests + limit > before.maxRequests ||
    before.reservedCny + limit * 0.2 > 8
  )
    throw Error('BUDGET_BLOCKED');
  const record: any = {
    phase,
    startedAt: new Date().toISOString(),
    limit,
    automaticRetries: 0,
    budgetBefore: before,
    requests: [],
    turns: [],
    playedAudio: false,
    recordedMicrophone: false,
    cloudBillVerified: false,
  };
  mkdirSync(resolve('.local'), { recursive: true, mode: 0o700 });
  writeFileSync(marker, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  const save = () => writeFileSync(marker, JSON.stringify(record, null, 2), { mode: 0o600 });
  const realFetch = fetch;
  let active: any;
  const fetcher: typeof fetch = async (url, init) => {
    if (
      String(url) !== 'https://api.deepseek.com/chat/completions' ||
      record.requests.length >= limit
    )
      throw Error('REQUEST_LIMIT');
    const body = JSON.parse(init?.body as string);
    const assistants = body.messages.filter((m: any) => m.role === 'assistant');
    active = {
      number: record.requests.length + 1,
      status: 'pending',
      messageRoles: body.messages.map((m: any) => m.role),
      assistantMessages: assistants.length,
      structuredAssistants: assistants.filter((m: any) => {
        try {
          return Array.isArray(JSON.parse(m.content).segments);
        } catch {
          return false;
        }
      }).length,
      systemPresent: body.messages[0]?.role === 'system',
      thinking: body.thinking?.type,
      responseFormat: body.response_format?.type,
      maxTokens: body.max_tokens,
    };
    record.requests.push(active);
    save();
    const started = Date.now();
    try {
      const result = await realFetch(url, { ...init, redirect: 'error' });
      active.httpStatus = result.status;
      const data = await result.clone().json();
      const c = data.choices?.[0];
      const content = c?.message?.content;
      Object.assign(active, {
        status: 'received',
        finishReason: ['stop', 'length', 'content_filter', 'tool_calls'].includes(c?.finish_reason)
          ? c.finish_reason
          : 'other',
        contentType: typeof content,
        contentLength: typeof content === 'string' ? content.length : 0,
        trimmedLength: typeof content === 'string' ? content.trim().length : 0,
      });
      for (const name of [
        'prompt_tokens',
        'completion_tokens',
        'prompt_cache_hit_tokens',
        'prompt_cache_miss_tokens',
      ])
        if (Number.isFinite(data.usage?.[name])) active[name] = data.usage[name];
      active.estimatedCny =
        ((active.prompt_tokens ?? 0) * 2) / 1e6 + ((active.completion_tokens ?? 0) * 8) / 1e6;
      return result;
    } catch {
      active.status = 'failed_no_retry';
      throw Error('LIVE_REQUEST_FAILED');
    } finally {
      active.elapsedMs = Date.now() - started;
      save();
      console.log(JSON.stringify(active));
    }
  };
  const provider = retryDialogue(
    budgetDialogue(
      new DeepSeekProvider(config.deepseek.apiKey, config.deepseek.model, fetcher, (facts) => {
        if (active) {
          active.diagnostic = facts;
          save();
        }
      }),
      budget,
    ),
  );
  const app = buildApp(provider);
  await app.ready();
  const pending = new Set<Promise<unknown>>();
  const transport: Transport = {
    async turn(request, signal) {
      if (signal.aborted) throw abortError();
      const r = await app.inject({
        method: 'POST',
        url: '/api/turn',
        headers: { origin: 'http://127.0.0.1:3001', host: '127.0.0.1:3001' },
        payload: request,
      });
      const data = r.json();
      if (r.statusCode !== 200) throw Error(data.error?.code ?? 'API_FAILED');
      return data;
    },
    async cancel(sessionId, throughTurnId) {
      const p = app.inject({
        method: 'POST',
        url: '/api/cancel',
        payload: { sessionId, throughTurnId },
      });
      pending.add(p);
      try {
        await p;
      } finally {
        pending.delete(p);
      }
    },
  };
  let interruptOnStart = false;
  let currentEngine: ConversationEngine;
  const audio: AudioPlayer = {
    async play(_text, signal, start) {
      if (signal.aborted) throw abortError();
      start();
      if (interruptOnStart) {
        interruptOnStart = false;
        currentEngine.interrupt();
        throw abortError();
      }
    },
    stop() {},
  };
  const groups =
    phase === 'strict-three'
      ? [['你好，雨这么大，你怎么还没走？', '聊聊你的旅行吧。', '能看看你的照片吗？']]
      : phase === 'final-two'
        ? [['你好，雨这么大，你怎么还没走？', '聊聊你的旅行吧。']]
        : phase === 'before'
          ? [['你好，雨这么大，你怎么还没走？', '聊聊你的旅行吧。', '能看看你的照片吗？']]
          : [
              [
                '你好，我刚从雨里进来，想坐一会儿。',
                '聊聊你的旅行吧。',
                '最近哪一段旅途最让你难忘？',
                '谢谢你，我们再聊聊那杯咖啡吧。',
              ],
              [
                '能看看你的照片吗？',
                '这张照片对你意味着什么？',
                '先停一下，我想换个话题。',
                '我们继续，窗外的雨让你想到什么？',
              ],
            ];
  try {
    for (let g = 0; g < groups.length; g++) {
      currentEngine = new ConversationEngine(transport, audio, crypto.randomUUID(), () => 0);
      for (let n = 0; n < groups[g].length; n++) {
        await Promise.all(pending);
        interruptOnStart = phase === 'after' && g === 1 && n === 2;
        await currentEngine.submit(groups[g][n]);
        await Promise.all(pending);
        const s = currentEngine.getSnapshot();
        const row = {
          group: g + 1,
          turn: n + 1,
          status: s.status,
          error: s.error,
          notice: s.notice,
          completed: s.completed,
          subtitleLength: s.subtitle.length,
          photo: s.photo,
          scene: s.scene,
          interruptionExpected: phase === 'after' && g === 1 && n === 2,
        };
        record.turns.push(row);
        save();
        console.log(JSON.stringify(row));
      }
      currentEngine.dispose();
      await Promise.all(pending);
    }
  } finally {
    await app.close();
    record.budgetAfter = budget.status();
    record.finishedAt = new Date().toISOString();
    record.automaticRetries = record.requests.filter(
      (r: any) => (r.diagnostic?.attempt ?? 1) > 1,
    ).length;
    record.firstAttemptAccepted = record.requests.filter(
      (r: any) =>
        (r.diagnostic?.attempt ?? 1) === 1 &&
        ['accepted', 'normalized'].includes(r.diagnostic?.outcome),
    ).length;
    record.estimatedCny = record.requests.reduce(
      (sum: number, r: any) => sum + (r.estimatedCny ?? 0),
      0,
    );
    save();
    console.log(
      JSON.stringify({
        phase,
        requests: record.requests.length,
        firstAttemptAccepted: record.firstAttemptAccepted,
        automaticRetries: record.automaticRetries,
        estimatedCny: record.estimatedCny,
        budget: record.budgetAfter,
        automaticPaidValidationStopped: true,
      }),
    );
  }
}
main().catch(() => {
  console.log(
    'STOPPED: check the sanitized phase record for attempted request counts; no automatic retry.',
  );
  process.exitCode = 1;
});
