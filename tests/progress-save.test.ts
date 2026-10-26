import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { buildApp } from '../server/app';
import { mockStoryReply } from '../server/story-mock';
import { loadStorySaveKey, storySaves } from '../server/story-save';
import { newStory } from '../server/story';
import { ConversationEngine } from '../src/core/engine';
import { HttpTransport, type Transport } from '../src/core/transport';
import { LocalProgressStorage } from '../src/core/progress-storage';
import { STORY_OPENING } from '../shared/story';
import type { DialogueRequest } from '../server/providers';

function memoryStorage() {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
  return { values, storage, saves: new LocalProgressStorage(() => storage) };
}
const silentAudio = {
  async play(_text: string, _signal: AbortSignal, start: () => void) {
    start();
  },
  stop() {},
};
const engineWith = (transport: Transport, saves: LocalProgressStorage) =>
  new ConversationEngine(
    transport,
    silentAudio,
    undefined,
    () => 0,
    () => 0,
    saves,
  );
afterEach(() => vi.unstubAllGlobals());

describe('browser progress with authoritative server context', () => {
  it('restores props, choices, timeline and dialogue context into a new page and restarted server, then resets everything', async () => {
    const contexts: DialogueRequest[] = [];
    const provider = {
      kind: 'mock' as const,
      async reply(input: DialogueRequest) {
        contexts.push(structuredClone(input));
        return mockStoryReply(input, input.storyContext!);
      },
    };
    let app = buildApp(provider, 18000, undefined, undefined, undefined, 'stable-test-key');
    const pending: Promise<unknown>[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const work = app.inject({ method: 'POST', url, payload: JSON.parse(init.body as string) });
      pending.push(work);
      const response = await work;
      return new Response(response.body, { status: response.statusCode });
    });
    const { saves, values } = memoryStorage();
    const first = engineWith(new HttpTransport(), saves);
    try {
      for (const text of ['谢谢，外面雨好大', '你桌上是照片吗', '给你，别沾水', '是什么委托'])
        await first.submit(text);
      const before = first.getSnapshot();
      expect(before.story?.facts).toContain('commission');
      expect(before.location).toBe('lodge');
      expect(values.size).toBe(1);
      await Promise.all(pending);
      await app.close();
      app = buildApp(provider, 18000, undefined, undefined, undefined, 'stable-test-key');
      const restored = engineWith(new HttpTransport(), saves);
      expect(restored.sessionId).not.toBe(first.sessionId);
      expect(restored.getSnapshot()).toMatchObject({
        story: before.story,
        stageProps: before.stageProps,
        suggestions: before.suggestions,
        subtitle: before.subtitle,
        location: 'lodge',
        lastInput: before.lastInput,
        status: 'idle',
        presentation: 'none',
      });
      restored.interrupt(true);
      restored.endListening();
      await restored.submit('你已经决定要去了吗？');
      expect(restored.getSnapshot().story?.facts).toContain('ticket');
      const last = contexts.at(-1)!;
      expect(last.storyContext!.facts).toContain('commission');
      expect(last.storyContext!.summary).toContain('明早需要去车站接你吗');
      expect(last.history.some((h) => h.content.includes('是什么委托'))).toBe(true);
      for (const text of [
        '他们希望拍什么？',
        '以前去过那里吗？',
        '拍人让你担心什么？',
        '能看看你写的草稿吗？',
      ])
        await restored.submit(text);
      expect(restored.getSnapshot().story?.facts).toContain('draft');
      expect(restored.getSnapshot().location).toBe('cafe');
      await restored.submit('先视频聊十分钟，再决定试住一天');
      const ending = engineWith(new HttpTransport(), saves);
      expect(ending.getSnapshot()).toMatchObject({
        story: { ending: 'b', planQuote: '先视频聊十分钟，再决定试住一天' },
        stageProps: { phone: 'sent' },
        scene: 'warm',
        location: 'cafe',
        status: 'idle',
      });
      await ending.submit('谢谢');
      expect(contexts.at(-1)!.storyContext!.ending).toBe('b');
      restored.reset();
      expect(values.size).toBe(0);
      expect(restored.getSnapshot()).toMatchObject({
        story: undefined,
        subtitle: STORY_OPENING,
        lastInput: '',
        stageProps: { phone: 'none', photoPose: 'aside' },
        location: 'cafe',
      });
      await restored.submit('你好');
      expect(contexts.at(-1)!.storyContext!.facts).toEqual([]);
      expect(contexts.at(-1)!.history).toEqual([]);
      expect(engineWith(new HttpTransport(), saves).getSnapshot().story?.facts).toEqual([
        'arrival',
      ]);
      const legacy = saves.load()!;
      const { location: _location, ...oldView } = legacy.view;
      values.set([...values.keys()][0], JSON.stringify({ ...legacy, view: oldView }));
      expect(engineWith(new HttpTransport(), saves).getSnapshot()).toMatchObject({
        location: 'cafe', story: { facts: ['arrival'] }, saveNotice: '',
      });
    } finally {
      await Promise.all(pending);
      await app.close();
    }
  });

  it('never saves an unfinished sentence or lets a late receipt resurrect progress after reset', async () => {
    let finish!: () => void;
    let acknowledge!: (value: any) => void;
    const presented = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const { saves, values } = memoryStorage();
    const engine = new ConversationEngine(
      {
        async turn(r) {
          return {
            turnId: r.turnId,
            provider: 'mock',
            segments: [{ text: '尚未听完。', emotion: 'curious', action: 'idle' }],
          };
        },
        cancel: async () => {},
        presented,
      },
      {
        async play(_text, _signal, start) {
          start();
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
        stop() {},
      },
      undefined,
      undefined,
      undefined,
      saves,
    );
    const run = engine.submit('你好');
    await vi.waitFor(() => expect(engine.getSnapshot().status).toBe('speaking'));
    expect(values.size).toBe(0);
    expect(presented).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(presented).toHaveBeenCalledOnce());
    expect(values.size).toBe(0);
    engine.reset();
    acknowledge({ turnId: 1, through: 1, story: newStory(), checkpoint: 'old' });
    await run;
    expect(values.size).toBe(0);
    expect(engine.getSnapshot().subtitle).toBe(STORY_OPENING);
  });

  it('handles corrupt/unknown saves and unavailable storage without breaking dialogue', async () => {
    const { storage, saves } = memoryStorage();
    const transport: Transport = {
      async turn(r) {
        return {
          turnId: r.turnId,
          provider: 'mock',
          segments: [{ text: '坐吧。', emotion: 'curious', action: 'idle' }],
        };
      },
      async presented(r) {
        return { turnId: r.turnId, through: r.through, story: newStory(), checkpoint: 'test' };
      },
      async cancel() {},
    };
    storage.setItem('mira-cafe:progress:v1:/', '{invalid');
    expect(engineWith(transport, saves).getSnapshot().saveNotice).toContain('无法读取');
    storage.setItem('mira-cafe:progress:v1:/', JSON.stringify({ version: 99 }));
    expect(engineWith(transport, saves).getSnapshot().subtitle).toBe(STORY_OPENING);
    const unavailable = new LocalProgressStorage(() => {
      throw new Error('denied');
    });
    const engine = engineWith(transport, unavailable);
    await engine.submit('你好');
    expect(engine.getSnapshot()).toMatchObject({ status: 'idle', completed: 1 });
    expect(engine.getSnapshot().saveNotice).toContain('未能保存');
  });

  it('starts a new session after failed receipt sync, so reset can recover', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith('/presented')) return new Response('{}', { status: 409 });
        const r = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({
            turnId: r.turnId,
            provider: 'mock',
            segments: [{ text: '坐吧。', emotion: 'curious', action: 'idle' }],
          }),
        );
      }),
    );
    const transport = new HttpTransport();
    const id = crypto.randomUUID();
    await expect(transport.presented({ sessionId: id, turnId: 1, through: 1 })).rejects.toThrow(
      '同步',
    );
    const engine = engineWith(transport, memoryStorage().saves);
    engine.sessionId = id;
    engine.reset();
    await engine.submit('你好');
    expect(engine.getSnapshot().status).toBe('idle');
  });
});

describe('signed story checkpoints', () => {
  it('rejects tampering, other modes, other paths and keys', () => {
    const saves = storySaves('key', '/mira:deepseek');
    const token = saves.seal(newStory());
    expect(saves.open(token)).toEqual(newStory());
    const parts = token.split('.');
    parts[0] = Buffer.from(JSON.stringify({ ...newStory(), ending: 'a' })).toString('base64url');
    expect(saves.open(parts.join('.'))).toBeUndefined();
    for (const other of [
      storySaves('key', '/mira:mock'),
      storySaves('other', '/mira:deepseek'),
      storySaves('key', ':deepseek'),
    ])
      expect(other.open(token)).toBeUndefined();
    expect(saves.open('x'.repeat(40001))).toBeUndefined();
  });
  it('keeps a private key across local process restarts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mira-save-'));
    try {
      const path = join(directory, 'nested', 'story-save.key');
      const key = loadStorySaveKey(path);
      expect(loadStorySaveKey(path)).toBe(key);
      expect(readFileSync(path, 'utf8')).toBe(key);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('uses one complete key when local live and mock processes start together', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mira-save-race-'));
    const path = join(directory, 'story-save.key');
    const children = Array.from({ length: 4 }, () => {
      const child = spawn(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { loadStorySaveKey } from './server/story-save.ts'; process.stdout.write('ready'); process.stdin.once('data', () => { process.stdout.write(loadStorySaveKey(process.argv[1])); process.exit(0); });`,
        path,
      ]);
      const ready = once(child.stdout, 'data');
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      return { child, ready, exited: once(child, 'exit'), output: () => output };
    });
    try {
      await Promise.all(children.map((c) => c.ready));
      for (const { child } of children) child.stdin.end('start');
      expect(await Promise.all(children.map((c) => c.exited))).toEqual(
        Array.from({ length: 4 }, () => [0, null]),
      );
      const key = readFileSync(path, 'utf8');
      expect(key).toMatch(/^[a-f0-9]{64}$/);
      for (const c of children) expect(c.output()).toBe('ready' + key);
    } finally {
      for (const { child } of children) if (child.exitCode === null) child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('rejects an invalid save before making any paid provider call', async () => {
    const reply = vi.fn();
    const app = buildApp({ kind: 'deepseek', reply });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/turn',
        headers: { origin: 'http://localhost', host: 'localhost' },
        payload: { sessionId: crypto.randomUUID(), turnId: 1, text: '继续', checkpoint: 'forged' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_SAVE');
      expect(reply).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
