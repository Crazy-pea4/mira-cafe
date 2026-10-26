import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestAudit, MemoryAuditStore, FileAuditStore } from '../server/request-audit';
import { auditDialogue, auditSpeech } from '../server/audit-providers';
import { logFacts } from '../server/safe-log';
import { buildApp } from '../server/app';
import { mockStoryReply } from '../server/story-mock';
import { resolveConfig } from '../server/config';
const signal = () => new AbortController().signal;
const input = {
  sessionId: crypto.randomUUID(),
  turnId: 1,
  text: '谢谢，我先暖暖手。',
  history: [],
  fault: 'none' as const,
};
describe('non-blocking request audit after user removed local limits', () => {
  it('continues all three provider kinds beyond both historical amount and count thresholds', async () => {
    const audit = new RequestAudit(new MemoryAuditStore());
    for (let i = 0; i < 65; i++) audit.record('deepseek', signal());
    const reply = vi.fn(async () => ({
      segments: [{ text: '可以。', emotion: 'curious' as const, action: 'idle' as const }],
    }));
    const openAsr = vi.fn(() => ({
        ready: Promise.resolve(),
        append: vi.fn(),
        commit: async () => '测试',
        cancel: vi.fn(),
      })),
      synthesize = vi.fn(async () => {});
    await auditDialogue({ kind: 'deepseek', reply }, audit).reply(input, signal());
    const speech = auditSpeech({ openAsr, synthesize }, audit);
    await speech.openAsr(signal()).commit();
    await speech.synthesize('测试', signal(), vi.fn());
    expect(reply).toHaveBeenCalledOnce();
    expect(openAsr).toHaveBeenCalledOnce();
    expect(synthesize).toHaveBeenCalledOnce();
    expect(audit.status()).toMatchObject({
      limitsEnforced: false,
      totalRequests: 68,
      actualBilledCny: null,
      requests: { deepseek: 66, asr: 1, tts: 1 },
    });
  });
  it('does not count or dispatch already cancelled work', async () => {
    const audit = new RequestAudit(new MemoryAuditStore()),
      controller = new AbortController(),
      reply = vi.fn();
    controller.abort();
    await expect(
      auditDialogue({ kind: 'deepseek', reply }, audit).reply(input, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(reply).not.toHaveBeenCalled();
    expect(audit.status().totalRequests).toBe(0);
  });
  it('keeps existing counts on restart and counts failures without refund or zeroing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mira-audit-')),
      path = join(dir, 'budget.json');
    try {
      const historical = {
        version: 1,
        requests: { deepseek: 37, asr: 4, tts: 12 },
        reservedMicros: 7960000,
      };
      writeFileSync(path, JSON.stringify(historical));
      const audit = new RequestAudit(new FileAuditStore(path));
      expect(audit.status().totalRequests).toBe(53);
      const original = readFileSync(path, 'utf8');
      audit.status();
      expect(readFileSync(path, 'utf8')).toBe(original);
      await expect(
        auditDialogue(
          {
            kind: 'deepseek',
            reply: async () => {
              throw new Error('fake upstream failure');
            },
          },
          audit,
        ).reply(input, signal()),
      ).rejects.toThrow('fake upstream failure');
      expect(new RequestAudit(new FileAuditStore(path)).status()).toMatchObject({
        totalRequests: 54,
        requests: { deepseek: 38, asr: 4, tts: 12 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each(['locked', 'broken', 'inconsistent'])(
    'never blocks providers or overwrites a %s statistics file',
    async (mode) => {
      const dir = mkdtempSync(join(tmpdir(), 'mira-audit-')),
        path = join(dir, 'budget.json');
      try {
        const content =
          mode === 'broken'
            ? 'broken'
            : JSON.stringify({
                version: 1,
                requests: { deepseek: 1, asr: 0, tts: 0 },
                reservedMicros: mode === 'inconsistent' ? 0 : 200000,
              });
        writeFileSync(path, content);
        if (mode === 'locked') writeFileSync(path + '.lock', 'existing');
        const audit = new RequestAudit(new FileAuditStore(path)),
          reply = vi.fn(async () => ({ segments: [] }));
        await auditDialogue({ kind: 'deepseek', reply }, audit).reply(input, signal());
        expect(reply).toHaveBeenCalledOnce();
        expect(audit.status().available).toBe(false);
        expect(readFileSync(path, 'utf8')).toBe(content);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it('keeps speech available and sends suggestion/free text through the same app route above old limits', async () => {
    const audit = new RequestAudit(new MemoryAuditStore());
    for (let i = 0; i < 61; i++) audit.record('deepseek', signal());
    const reply = vi.fn(async (request: any) => mockStoryReply(request, request.storyContext));
    const app = buildApp(
      auditDialogue({ kind: 'deepseek', reply }, audit),
      18000,
      { openAsr: vi.fn(), synthesize: vi.fn() },
      audit,
    );
    try {
      const health = (await app.inject('/api/health')).json();
      expect(health).toMatchObject({
        speechAvailable: true,
        usagePolicy: { localLimits: false },
        usage: { limitsEnforced: false, totalRequests: 61 },
      });
      expect(health.budget).toBeUndefined();
      for (const text of ['谢谢，外面雨太大了。', '我想先安静坐一会儿。']) {
        const result = await app.inject({
          method: 'POST',
          url: '/api/turn',
          headers: { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3001' },
          payload: { ...input, sessionId: crypto.randomUUID(), text },
        });
        expect(result.statusCode).toBe(200);
      }
      expect(reply).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
  it('retains explicit live configuration and ignores obsolete limit variables', () => {
    expect(
      resolveConfig({ MIRA_ENABLE_LIVE_APIS: 'false', DEEPSEEK_API_KEY: 'fixture' }).configuration,
    ).toBe('mock');
    expect(
      resolveConfig({
        MIRA_ENABLE_LIVE_APIS: 'true',
        MIRA_PROVIDER: 'deepseek',
        DEEPSEEK_API_KEY: 'fixture',
        MIRA_BILLING_CONFIRMED: 'false',
        MIRA_MAX_LIVE_REQUESTS: '0',
      }).deepseek?.model,
    ).toBe('deepseek-flash');
  });
  it('allows only enumerated non-sensitive startup facts', () => {
    expect(
      logFacts({
        event: 'started',
        provider: 'mock',
        port: 3001,
        authorization: 'Bearer secret',
        apiKey: 'secret',
        message: 'private text',
      } as any),
    ).toEqual({ event: 'started', provider: 'mock', port: 3001 });
  });
});
it('rejects foreign-origin requests before a real-provider adapter can run', async () => {
  const reply = vi.fn();
  const app = buildApp({ kind: 'deepseek', reply });
  try {
    const result = await app.inject({
      method: 'POST',
      url: '/api/turn',
      headers: { host: '127.0.0.1:3001', origin: 'https://example.com' },
      payload: input,
    });
    expect(result.statusCode).toBe(403);
    expect(reply).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
