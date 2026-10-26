import { afterEach, describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  newStory,
  prepareStory,
  acknowledgeStory,
  storyContext,
  storyViolation,
} from '../server/story';
import { mockStoryReply } from '../server/story-mock';
import { buildApp } from '../server/app';
import { retryDialogue } from '../server/retry-dialogue';
import { DeepSeekProvider } from '../server/providers';
import { ConversationEngine } from '../src/core/engine';
import { HttpTransport } from '../src/core/transport';
import { Narrative } from '../src/Narrative';
import {
  modelReplySchema,
  presentationUnits,
  type TurnRequest,
  type Reply,
} from '../shared/protocol';
import { STORY_OPENING, INITIAL_SUGGESTIONS } from '../shared/story';
import { OPENING_NARRATION, INITIAL_PROPS } from '../shared/stage';
const request = (text = '继续说吧', turnId = 1): TurnRequest => ({
  sessionId: crypto.randomUUID(),
  turnId,
  text,
  history: [],
  fault: 'none',
});
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function step(state: ReturnType<typeof newStory>, text = '继续说吧') {
  const input = request(text),
    raw = mockStoryReply(input, storyContext(state));
  expect(modelReplySchema.safeParse(raw).success).toBe(true);
  expect(storyViolation(storyContext(state), raw, text)).toEqual([]);
  const pending = prepareStory(state, input, raw);
  acknowledgeStory(state, pending, pending.units.length);
  return pending;
}
function reach(fact: string) {
  const state = newStory();
  for (let i = 0; i < 12 && !state.facts.includes(fact as any); i++) step(state);
  expect(state.facts).toContain(fact);
  return state;
}
afterEach(() => vi.unstubAllGlobals());
describe('event-driven rain shelter, photo, message and rehearsal', () => {
  it('has a spatial opening without surprise audio, model calls or future-message spoilers', () => {
    const play = vi.fn(),
      turn = vi.fn(),
      e = new ConversationEngine({ turn, cancel: async () => {} }, { play, stop() {} });
    expect(e.getSnapshot()).toMatchObject({
      subtitle: '躲雨的？坐吧，这边没漏水。',
      narration: OPENING_NARRATION,
      stageProps: INITIAL_PROPS,
      suggestions: INITIAL_SUGGESTIONS,
    });
    expect(STORY_OPENING + INITIAL_SUGGESTIONS.join('')).not.toMatch(/回信|委托|帮我|车站/);
    expect(play).not.toHaveBeenCalled();
    expect(turn).not.toHaveBeenCalled();
    e.dispose();
  });
  it('requires encounter before wind and phone; external events are acknowledged once, never timer progression', () => {
    const s = newStory();
    expect(storyContext(s).allowedBeats).toEqual(['arrival']);
    step(s, '谢谢，让我暖暖手。');
    const raw = mockStoryReply(request(), storyContext(s)),
      p = prepareStory(s, request(), raw);
    expect(s.facts).toEqual(['arrival']);
    expect(p.units[0]).toMatchObject({ kind: 'cue', cue: { kind: 'photo-drift' } });
    acknowledgeStory(s, p, 1);
    expect(s.facts).toContain('photo-drift');
    expect(s.history).toHaveLength(2);
    expect(s.cues['phone-message']).toBeUndefined();
    const summary = storyContext(s).summary;
    acknowledgeStory(s, p, 1);
    expect(storyContext(s).summary).toBe(summary);
    const next = step(s, '我把杯子挪开，你自己拿吧。');
    expect(next.reply.segments[0].text).toContain('我自己拿');
    expect(s.facts).toContain('phone-message');
    expect(s.cues['phone-message']?.message).toBe('明早需要去车站接你吗？');
    expect(s.facts).not.toContain('commission');
    expect(step(s, '继续说吧').reply.segments.some((x) => x.cue?.kind === 'phone-message')).toBe(
      false,
    );
  });
  it.each(['给你，照片别湿了', '这张照片是你拍的吗', '我不理照片，继续喝咖啡'])(
    'does not require a hand-back password: %s',
    (text) => {
      const s = reach('photo-drift');
      const p = step(s, text);
      expect(s.facts).toContain('phone-message');
      expect(p.reply.segments[0].cue?.kind).toBe('phone-message');
      expect(p.reply.segments[0].cue?.photoReturn).toBe(/递|给你|还给|还你/.test(text));
    },
  );
  it('actually asks an interview question and then responds before rewriting the draft', () => {
    const s = reach('fear'),
      p = step(s, '拿我练习一下，你问我。');
    expect(s.facts).toContain('practice');
    expect(p.reply.segments[0].text).toContain('第一眼看见的是什么？');
    expect(p.reply.segments[0].cue?.kind).toBe('practice');
    const next = step(s, '我第一眼看到的是窗外的光。');
    expect(next.reply.segments[0].text).toContain('刚才听你讲');
    expect(s.facts).toContain('draft');
    expect(next.reply.segments[0].cue?.message).toContain('我很擅长');
    const noQuestion: Reply = {
      segments: [
        { text: '你说得对，就这么做。', emotion: 'curious', action: 'idle', beat: 'practice' },
      ],
      story: { intent: 'engage' },
    };
    expect(storyViolation(storyContext(reach('fear')), noQuestion, '练习吧')).not.toEqual([]);
  });
  it.each([
    ['坦诚承认经验少，先聊再拍。', 'a'],
    ['先视频聊十分钟，再决定试住一天', 'b'],
    ['不想接可以拒绝', 'c'],
  ])('sends a fictional reply only after the decision was presented: %s', (text, ending) => {
    const s = reach('draft'),
      r = mockStoryReply(request(text), storyContext(s)),
      p = prepareStory(s, request(text), r);
    expect(storyViolation(storyContext(s), r, text)).toEqual([]);
    const sendIndex = p.units.findIndex((u) => u.kind === 'cue' && u.cue.kind === 'reply-sent');
    expect(sendIndex).toBeGreaterThan(0);
    acknowledgeStory(s, p, sendIndex);
    expect(s.ending).toBeNull();
    expect(s.cues['reply-sent']).toBeUndefined();
    acknowledgeStory(s, p, sendIndex + 1);
    expect(s.ending).toBe(ending);
    expect(s.cues['reply-sent']?.message).toBeTruthy();
    if (ending === 'b') expect(s.cues['reply-sent']?.message).toContain(text);
    expect(p.units[sendIndex + 1]).toMatchObject({ kind: 'dialogue', text: '雨好像小了。' });
    acknowledgeStory(s, p, p.units.length);
    expect(step(s, '谢谢').reply.segments.some((x) => x.cue)).toBe(false);
  });
  it('refuses unapproved directions from the model and keeps narration out of the model schema', () => {
    const bad = {
      segments: [
        {
          text: '坐吧。',
          emotion: 'curious',
          action: 'idle',
          cue: { kind: 'reply-sent', text: '偷偷发送', placement: 'before' },
        },
      ],
    };
    expect(modelReplySchema.safeParse(bad).success).toBe(false);
    const s = newStory();
    const p = prepareStory(s, request(), bad as Reply);
    expect(p.reply.segments[0].cue).toBeUndefined();
  });
  it('keeps future messages and claimed endings out of early suggestions without model retries', () => {
    const s = newStory(),
      r = mockStoryReply(request(), storyContext(s));
    r.suggestions = ['明早车站接你吗？', '你已经接受委托了。', '回信已经发出了吗？'];
    const p = prepareStory(s, request(), r),
      ack = acknowledgeStory(s, p, p.units.length)!;
    expect(ack.suggestions?.join('')).not.toMatch(/车站|委托|回信/);
  });
  it('rejects late acknowledgements after cancellation and does not replay an already seen external event', async () => {
    const app = buildApp({
      kind: 'mock',
      reply: async (input) => mockStoryReply(input, input.storyContext!),
    });
    const id = crypto.randomUUID();
    const turn = async (n: number) => {
      const input = { ...request('继续', n), sessionId: id };
      return (await app.inject({ method: 'POST', url: '/api/turn', payload: input })).json();
    };
    const ack = async (n: number, through: number) =>
      app.inject({
        method: 'POST',
        url: '/api/presented',
        payload: { sessionId: id, turnId: n, through },
      });
    try {
      const first = await turn(1);
      await ack(1, presentationUnits(first).length);
      const photo = await turn(2);
      expect(photo.segments[0].cue.kind).toBe('photo-drift');
      await ack(2, 1);
      await app.inject({
        method: 'POST',
        url: '/api/cancel',
        payload: { sessionId: id, throughTurnId: 2 },
      });
      expect((await ack(2, presentationUnits(photo).length)).statusCode).toBe(409);
      const next = await turn(3);
      expect(next.segments[0].cue.kind).toBe('phone-message');
      expect(next.suggestions).toBeUndefined();
    } finally {
      await app.close();
    }
  });
  it('renders narration and the fictional phone outside Mira dialogue without technical labels', () => {
    const html = renderToStaticMarkup(
      createElement(Narrative, {
        text: OPENING_NARRATION,
        focus: 'phone',
        props: { ...INITIAL_PROPS, phone: 'incoming', message: '明早需要去车站接你吗？' },
      }),
    );
    expect(html).toContain('Mira 的手机');
    expect(html).toContain('明早需要去车站接你吗');
    expect(html).not.toMatch(/debug|模拟嘴型|测试|Notification/);
  });
});
describe('cue scheduling and interrupt isolation', () => {
  const cueReply: Reply = {
    segments: [
      {
        text: '小心，旁边有水。',
        emotion: 'curious',
        action: 'offer-photo',
        beat: 'photo-drift',
        cue: { kind: 'photo-drift', text: '风把照片吹到手边。', placement: 'before' },
      },
    ],
  };
  it('cancels before narration completion without committing a prop, speaking it or reviving suggestions', async () => {
    const play = vi.fn(async (_text, _signal, start) => start()),
      presented = vi.fn();
    const e = new ConversationEngine(
      {
        turn: async (r) => ({ ...cueReply, turnId: r.turnId, provider: 'mock' }),
        cancel: async () => {},
        presented,
      },
      { play, stop() {} },
      crypto.randomUUID(),
      () => 0,
      () => 5000,
    );
    for (let i = 0; i < 3; i++) {
      const work = e.submit('继续');
      await flush();
      expect(e.getSnapshot().status).toBe('narrating');
      expect(e.getSnapshot().stageProps.photoPose).toBe('near');
      e.interrupt();
      await work;
      expect(e.getSnapshot().stageProps.photoPose).toBe('aside');
      expect(e.getSnapshot().suggestions).toEqual([]);
    }
    expect(play).not.toHaveBeenCalled();
    expect(presented).not.toHaveBeenCalled();
    e.reset();
    expect(e.getSnapshot().narration).toBe(OPENING_NARRATION);
    expect(e.getSnapshot().stageProps).toEqual(INITIAL_PROPS);
  });
  it('uses the real engine/HTTP/server path with a fake model; no narration is ever sent to audio', async () => {
    const requests: any[] = [],
      spoken: string[] = [],
      pending: Promise<unknown>[] = [];
    const provider = {
      kind: 'mock' as const,
      reply: async (input: any) => {
        requests.push(input);
        return mockStoryReply(input, input.storyContext);
      },
    };
    const app = buildApp(provider);
    await app.ready();
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const work = app.inject({ method: 'POST', url, payload: JSON.parse(init.body as string) });
      pending.push(work);
      const r = await work;
      return new Response(r.body, { status: r.statusCode });
    });
    const e = new ConversationEngine(
      new HttpTransport(),
      {
        async play(text, _signal, start) {
          spoken.push(text);
          start();
        },
        stop() {},
      },
      crypto.randomUUID(),
      () => 0,
      () => 0,
    );
    try {
      for (const text of ['谢谢，我暖暖手', '这里真暖和', '给你，照片小心点', '是什么委托'])
        await e.submit(text);
      expect(e.getSnapshot()).toMatchObject({
        status: 'idle',
        completed: 4,
        stageProps: { photoPose: 'returned', phone: 'incoming' },
      });
      expect(e.getSnapshot().story?.facts).toContain('commission');
      expect(spoken.join('')).not.toContain('门被风推开');
      expect(spoken.join('')).not.toContain('桌上的手机亮起');
      expect(requests[3].storyContext.summary).toContain('明早需要去车站接你吗');
      expect(e.getSnapshot().suggestions).toHaveLength(3);
      for (const h of requests[3].history.filter((x: any) => x.role === 'assistant'))
        expect(JSON.parse(h.content).segments.every((x: any) => !x.cue)).toBe(true);
    } finally {
      e.dispose();
      await flush();
      await Promise.all(pending);
      await app.close();
    }
  });
  it('preserves DeepSeek strict JSON and bounded repair with the new event beat using fake fetch', async () => {
    const bodies: any[] = [];
    const bad = {
      segments: [{ text: '先发消息。', emotion: 'curious', action: 'idle', beat: 'phone-message' }],
      story: { intent: 'engage' },
    };
    const good = mockStoryReply(request('谢谢'), storyContext(newStory()));
    const provider = retryDialogue(
      new DeepSeekProvider('fixture', 'deepseek-flash', async (_url, init) => {
        bodies.push(JSON.parse(init!.body as string));
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: { content: JSON.stringify(bodies.length === 1 ? bad : good) },
              },
            ],
          }),
        );
      }),
    );
    const result = await provider.reply(
      { ...request('谢谢'), storyContext: storyContext(newStory()) },
      new AbortController().signal,
    );
    expect(result.segments[0].beat).toBe('arrival');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
    });
    expect(bodies[0].messages[0].content).toContain('不要在text里朗读旁白');
    expect(bodies[1].messages.at(-1).content).toContain('segments.0.beat:invalid_value');
  });
});
