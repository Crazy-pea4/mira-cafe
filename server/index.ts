import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import staticPlugin from '@fastify/static';
import { buildApp } from './app';
import { DeepSeekProvider, MockProvider } from './providers';
import { resolveConfig } from './config';
import { QwenSpeechProvider } from './qwen';
import { BudgetGuard, FileBudgetStore } from './budget';
import { budgetDialogue, budgetSpeech } from './budget-providers';
import { logFacts } from './safe-log';
import { retryDialogue } from './retry-dialogue';
import { writeReplyDiagnostic } from './reply-diagnostics';
// .env is loaded only by the separate, explicitly selected start:configured command.
const config = resolveConfig(process.env);
const budget = new BudgetGuard(new FileBudgetStore(resolve('.local/budget.json')), {
  confirmed: process.env.MIRA_BILLING_CONFIRMED === 'true',
  modelSupported: (!config.deepseek || config.deepseek.model === 'deepseek-flash') &&
    (!config.qwen || (config.qwen.region === 'cn-beijing' && config.qwen.asrModel === 'qwen3-asr-flash-realtime' && config.qwen.ttsModel === 'qwen3-tts-flash-realtime')),
  maxRequests: Number(process.env.MIRA_MAX_LIVE_REQUESTS ?? 60),
});
const provider = config.deepseek ? retryDialogue(budgetDialogue(new DeepSeekProvider(config.deepseek.apiKey, config.deepseek.model, fetch, writeReplyDiagnostic), budget)) : new MockProvider();
const speech = config.qwen ? budgetSpeech(new QwenSpeechProvider(config.qwen), budget) : undefined;
const app = buildApp(provider, 18000, speech, budget);
const dist = resolve('dist');
if (existsSync(dist)) await app.register(staticPlugin, { root: dist });
const port = Number(process.env.PORT ?? 3001);
try { await app.listen({ port, host: '127.0.0.1' }); console.log(JSON.stringify(logFacts({ event: 'started', provider: provider.kind, port }))); }
catch { console.error(JSON.stringify(logFacts({ event: 'start_failed', port }))); process.exit(1); }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });

