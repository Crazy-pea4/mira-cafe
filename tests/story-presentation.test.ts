import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { ConversationEngine } from '../src/core/engine';
import { HttpTransport, type Transport } from '../src/core/transport';
import { Suggestions } from '../src/Suggestions';
import { INITIAL_SUGGESTIONS, STORY_OPENING, type PresentationResponse } from '../shared/story';
const story = {
  act: 'invitation' as const,
  facts: [],
  ending: null,
  planQuote: '',
  declined: false,
};
const offered = ['你为什么犹豫？', '慢慢讲，不着急。', '也可以换个话题。'];
const result = {
  turnId: 1,
  provider: 'mock' as const,
  segments: [{ text: '这一句。下一句。', emotion: 'curious' as const, action: 'idle' as const }],
  suggestions: offered,
};
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
afterEach(() => vi.unstubAllGlobals());
describe('three optional contextual suggestions and presentation timing', () => {
  it('shows the new opening without a request; clicking a suggestion sends exactly that optional text', () => {
    const turn = vi.fn();
    const e = new ConversationEngine(
      { turn, cancel: async () => {} },
      { play: async () => {}, stop() {} },
    );
    expect(e.getSnapshot().subtitle).toBe(STORY_OPENING);
    expect(e.getSnapshot().suggestions).toEqual(INITIAL_SUGGESTIONS);
    expect(turn).not.toHaveBeenCalled();
    const choose = vi.fn();
    const view = Suggestions({ values: offered, onChoose: choose })!;
    const buttons = view.props.children as any[];
    expect(buttons).toHaveLength(3);
    buttons[1].props.onClick();
    expect(choose).toHaveBeenCalledExactlyOnceWith(offered[1]);
    const html = renderToStaticMarkup(
      createElement(Suggestions, { values: offered, onChoose: choose }),
    );
    expect(html).toContain('建议回应：');
    expect(html).not.toContain('必须');
    expect(Suggestions({ values: [], onChoose: choose })).toBeNull();
    e.dispose();
  });
  it('waits for every presented sentence before revealing suggestions from that reply', async () => {
    const played: ReturnType<typeof deferred<void>>[] = [];
    const receipts: number[] = [];
    const transport: Transport = {
      turn: async () => result,
      cancel: async () => {},
      presented: async (r) => {
        receipts.push(r.through);
        return {
          turnId: r.turnId,
          through: r.through,
          story,
          ...(r.through === 2 ? { suggestions: offered } : {}),
        };
      },
    };
    const engine = new ConversationEngine(transport, {
      play: async (_text, _signal, start) => {
        start();
        const task = deferred<void>();
        played.push(task);
        await task.promise;
      },
      stop() {},
    });
    const work = engine.submit('我愿意听');
    await flush();
    expect(engine.getSnapshot().suggestions).toEqual([]);
    expect(receipts).toEqual([]);
    played[0].resolve();
    await flush();
    expect(receipts).toEqual([1]);
    expect(engine.getSnapshot().suggestions).toEqual([]);
    played[1].resolve();
    await work;
    expect(engine.getSnapshot().suggestions).toEqual(offered);
    expect(receipts).toEqual([1, 2]);
    engine.interrupt();
    expect(engine.getSnapshot().suggestions).toEqual([]);
    engine.dispose();
  });
  it('does not reveal late suggestions after cancellation while a completed-line receipt is in flight', async () => {
    const ack = deferred<PresentationResponse>();
    const transport: Transport = {
      turn: async () => ({ ...result, segments: [result.segments[0]] }),
      cancel: async () => {},
      presented: () => ack.promise,
    };
    const engine = new ConversationEngine(transport, {
      play: async (_text, _signal, start) => start(),
      stop() {},
    });
    const work = engine.submit('继续');
    await flush();
    engine.interrupt();
    ack.resolve({
      turnId: 1,
      through: 1,
      story,
      suggestions: ['已经接受委托了。', '这封回信写完了。', '明天就出发吧。'],
    });
    await work;
    expect(engine.getSnapshot().suggestions).toEqual([]);
    expect(engine.getSnapshot().story).toBeUndefined();
    expect(engine.getSnapshot().completed).toBe(0);
  });
  it('creates a new server session on reset and restores only opening suggestions', () => {
    const engine = new ConversationEngine(
      { turn: vi.fn(), cancel: async () => {} },
      { play: async () => {}, stop() {} },
    );
    const id = engine.sessionId;
    engine.reset();
    expect(engine.sessionId).not.toBe(id);
    expect(engine.getSnapshot().suggestions).toEqual(INITIAL_SUGGESTIONS);
    expect(engine.getSnapshot().story).toBeUndefined();
  });
});
describe('non-billable presentation receipts ordered before cancellation and the next paid turn', () => {
  it('serializes receipt → cancel → new turn, preserving completed facts without reviving old suggestions', async () => {
    const ack = deferred<Response>(),
      paths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        paths.push(url);
        if (url === '/api/presented') return ack.promise;
        if (url === '/api/cancel') return new Response('{}');
        return new Response(JSON.stringify({ ...result, turnId: 2 }));
      }),
    );
    const t = new HttpTransport(),
      sessionId = crypto.randomUUID();
    const receipt = t.presented({ sessionId, turnId: 1, through: 1 });
    await flush();
    const cancel = t.cancel(sessionId, 1);
    const next = t.turn(
      { sessionId, turnId: 2, text: '新问题', history: [], fault: 'none' },
      new AbortController().signal,
    );
    expect(paths).toEqual(['/api/presented']);
    ack.resolve(new Response(JSON.stringify({ turnId: 1, through: 1, story })));
    await Promise.all([receipt, cancel, next]);
    expect(paths).toEqual(['/api/presented', '/api/cancel', '/api/turn']);
  });
  it('does not send a new paid turn after a failed synchronization or a cancelled queue wait', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', f);
    const t = new HttpTransport(),
      sessionId = crypto.randomUUID();
    await expect(t.presented({ sessionId, turnId: 1, through: 1 })).rejects.toThrow('同步');
    await expect(
      t.turn(
        { sessionId, turnId: 2, text: '继续', history: [], fault: 'none' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('同步');
    expect(f).toHaveBeenCalledOnce();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      new HttpTransport().turn(
        { sessionId, turnId: 3, text: '继续', history: [], fault: 'none' },
        aborted.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(f).toHaveBeenCalledOnce();
  });
});
