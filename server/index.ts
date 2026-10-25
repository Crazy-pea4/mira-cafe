import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import staticPlugin from '@fastify/static';
import { buildApp } from './app';
import { DeepSeekProvider, MockProvider } from './providers';
import { resolveConfig } from './config';
import { QwenSpeechProvider } from './qwen';
import { RequestAudit, FileAuditStore } from './request-audit';
import { auditDialogue, auditSpeech } from './audit-providers';
import { logFacts } from './safe-log';
import { retryDialogue } from './retry-dialogue';
import { writeReplyDiagnostic } from './reply-diagnostics';
// .env is loaded only by the separate, explicitly selected start:configured command.
const config = resolveConfig(process.env);
const audit = new RequestAudit(new FileAuditStore(resolve('.local/budget.json')));
const provider = config.deepseek ? retryDialogue(auditDialogue(new DeepSeekProvider(config.deepseek.apiKey, config.deepseek.model, fetch, writeReplyDiagnostic), audit)) : new MockProvider();
const speech = config.qwen ? auditSpeech(new QwenSpeechProvider(config.qwen), audit) : undefined;
const app = buildApp(provider, 18000, speech, audit);
const dist = resolve('dist');
if (existsSync(dist)) await app.register(staticPlugin, { root: dist });
const port = Number(process.env.PORT ?? 3001);
try { await app.listen({ port, host: '127.0.0.1' }); console.log(JSON.stringify(logFacts({ event: 'started', provider: provider.kind, port }))); }
catch { console.error(JSON.stringify(logFacts({ event: 'start_failed', port }))); process.exit(1); }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });

