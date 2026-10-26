// One-off release acceptance. Explicit opt-in, fixed ceilings and a non-replayable record.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveConfig } from '../server/config';
import { DeepSeekProvider, ProviderError } from '../server/providers';
import { retryDialogue } from '../server/retry-dialogue';
import { buildApp } from '../server/app';
import { ConversationEngine } from '../src/core/engine';
import { turnResponseSchema } from '../shared/protocol';
import { presentationResponseSchema, type StoryView } from '../shared/story';
import { RequestAudit, FileAuditStore } from '../server/request-audit';
import { auditDialogue } from '../server/audit-providers';

const finalRun = process.argv[2] === '--authorized-release-final';
const followup = finalRun || process.argv[2] === '--authorized-release-followup';
const marker = resolve(
  finalRun
    ? '.local/release-live-final-2026-10-26.json'
    : followup
      ? '.local/release-live-followup-2026-10-26.json'
      : '.local/release-live-2026-10-26.json',
);
const ceiling = finalRun ? 26 : followup ? 32 : 40;
async function main() {
  if (!followup && process.argv[2] !== '--authorized-release')
    throw Error('Explicit release opt-in required');
  if (existsSync(marker)) throw Error('Release run already exists; replay is blocked');
  const config = resolveConfig(process.env);
  if (!config.deepseek || config.deepseek.model !== 'deepseek-flash')
    throw Error('Expected provider not configured');
  const record: any = {
    startedAt: new Date().toISOString(),
    ceiling,
    requests: [],
    routes: [],
    microphone: false,
    speaker: false,
    speechRequests: 0,
  };
  mkdirSync(resolve('.local'), { recursive: true, mode: 0o700 });
  writeFileSync(marker, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  const save = () => writeFileSync(marker, JSON.stringify(record, null, 2), { mode: 0o600 });
  let current: any;
  const boundedFetch: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (
      String(url) !== 'https://api.deepseek.com/chat/completions' ||
      record.requests.length >= ceiling ||
      Buffer.byteLength(String(init?.body)) > 30000 ||
      body.max_tokens > 650
    )
      throw new ProviderError('UNAVAILABLE', 'Release acceptance ceiling reached');
    current = { attempt: record.requests.length + 1 };
    record.requests.push(current);
    save();
    const response = await fetch(url, { ...init, redirect: 'error' });
    const data = await response.clone().json();
    Object.assign(current, {
      status: response.status,
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      finishReason: data.choices?.[0]?.finish_reason,
    });
    try {
      current.syntheticReply = JSON.parse(data.choices?.[0]?.message?.content);
    } catch {
      /* diagnostic lengths remain available */
    }
    save();
    return response;
  };
  const audit = new RequestAudit(new FileAuditStore(resolve('.local/budget.json')));
  const provider = retryDialogue(
    auditDialogue(
      new DeepSeekProvider(config.deepseek.apiKey, config.deepseek.model, boundedFetch, (facts) => {
        if (current) {
          current.diagnostic = facts;
          save();
        }
      }),
      audit,
    ),
  );
  const app = buildApp(provider);
  await app.ready();
  const transport = {
    async turn(input: any, _signal: AbortSignal) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/turn',
        headers: { origin: 'http://127.0.0.1:3001', host: '127.0.0.1:3001' },
        payload: input,
      });
      const data = response.json();
      if (response.statusCode !== 200) throw Error(data.error?.message ?? 'Turn failed');
      return turnResponseSchema.parse(data);
    },
    async presented(input: any) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/presented',
        headers: { origin: 'http://127.0.0.1:3001', host: '127.0.0.1:3001' },
        payload: input,
      });
      return presentationResponseSchema.parse(response.json());
    },
    async cancel(sessionId: string, throughTurnId: number) {
      await app.inject({
        method: 'POST',
        url: '/api/cancel',
        payload: { sessionId, throughTurnId },
      });
    },
  };
  function next(story: StoryView | undefined, ending: string) {
    const known = new Set(story?.facts ?? []);
    if (!known.has('arrival')) return '谢谢，外面雨太大了。';
    if (!known.has('photo-drift')) return '风把你桌上的照片吹过来了，这是在哪里拍的？';
    if (!known.has('phone-message')) return '给你，照片别沾到水。';
    if (!known.has('commission')) return '旅馆为什么明早来车站接你？是什么事让你迟迟没回信？';
    if (ending === 'c') return '今晚我不想再替你出主意，你自己决定吧，我想安静坐一会儿。';
    if (!known.has('ticket')) return '你已经买好明天的车票了吗？';
    if (!known.has('people')) return '他们除了风景，还希望你拍什么？';
    if (!known.has('memory')) return '你三年前在那里拍这张照片的时候，是怎样度过的？';
    if (!known.has('fear')) return '拍人让你担心的是什么？和拍风景有什么不同？';
    if (!known.has('draft')) return '能看看你手机里那条还没发出去的回信草稿吗？';
    return ending === 'a'
      ? '坦诚说拍人的经验不多，明天先聊再拍。你愿意这样改回信，自己决定去试试吗？'
      : '我的办法是先视频沟通，再决定试住一天。你可以把这个办法写进回信，自己决定。';
  }
  try {
    for (const ending of followup ? ['a', 'b'] : ['c', 'a', 'b']) {
      const row: any = { expected: ending, turns: [] };
      record.routes.push(row);
      save();
      const engine = new ConversationEngine(
        transport,
        {
          async play(_text, signal, start) {
            if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
            start();
          },
          stop() {},
        },
        crypto.randomUUID(),
        () => 0,
        () => 0,
      );
      try {
        for (let n = 0; n < 13 && record.requests.length < ceiling; n++) {
          const input = next(engine.getSnapshot().story, ending);
          await engine.submit(input);
          const state = engine.getSnapshot();
          const turn = {
            input,
            status: state.status,
            story: state.story,
            subtitle: state.subtitle,
            scene: state.scene,
            phone: state.stageProps.phone,
            suggestions: state.suggestions,
            error: state.error,
          };
          row.turns.push(turn);
          save();
          console.log(JSON.stringify({ route: ending, turn: n + 1, ...turn }));
          if (state.status === 'error' || state.story?.ending) break;
        }
        const state = engine.getSnapshot();
        row.passed =
          state.story?.ending === ending &&
          state.stageProps.phone === 'sent' &&
          state.scene === 'warm';
      } finally {
        engine.dispose();
      }
    }
  } finally {
    await app.close();
    record.finishedAt = new Date().toISOString();
    record.passed =
      record.routes.length === (followup ? 2 : 3) &&
      record.routes.every((route: any) => route.passed);
    record.promptTokens = record.requests.reduce(
      (sum: number, row: any) => sum + (row.promptTokens ?? 0),
      0,
    );
    record.completionTokens = record.requests.reduce(
      (sum: number, row: any) => sum + (row.completionTokens ?? 0),
      0,
    );
    save();
    console.log(
      JSON.stringify({
        passed: record.passed,
        attempts: record.requests.length,
        routes: record.routes.map((row: any) => ({
          expected: row.expected,
          passed: row.passed,
          turns: row.turns.length,
        })),
      }),
    );
  }
}
main().catch(() => {
  console.error(
    'Release acceptance stopped. Inspect the private bounded record; no automatic replay.',
  );
  process.exitCode = 1;
});
