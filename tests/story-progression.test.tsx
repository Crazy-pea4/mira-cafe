import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { progressTarget, guidedSuggestions } from '../shared/story-progression';
import { authorStory } from '../server/story-author';
import {
  newStory,
  storyContext,
  storyViolation,
  prepareStory,
  acknowledgeStory,
} from '../server/story';
import { Suggestions } from '../src/Suggestions';
import { modelReplySchema, type Reply } from '../shared/protocol';
import { suggestionSchema } from '../shared/story';

const stalled: Reply = {
  segments: [{ text: '我还在想怎么回。', emotion: 'guarded', action: 'idle' }],
  story: { intent: 'clarify' },
  suggestions: ['咖啡真香。', '我就坐一会儿。', '要换个话题吗？'],
};
function present(state: ReturnType<typeof newStory>, input: string) {
  const raw = authorStory(storyContext(state), stalled, input);
  expect(modelReplySchema.safeParse({ segments: raw.segments, story: raw.story }).success).toBe(
    true,
  );
  expect(storyViolation(storyContext(state), raw, input)).toEqual([]);
  const before = JSON.stringify(state);
  const pending = prepareStory(
    state,
    { sessionId: crypto.randomUUID(), turnId: 1, text: input, history: [], fault: 'none' },
    raw,
  );
  expect(JSON.stringify(state)).toBe(before);
  const ack = acknowledgeStory(state, pending, pending.units.length)!;
  expect(suggestionSchema.safeParse(ack.suggestions).success).toBe(true);
  return ack;
}
describe('reliable optional progression and shared input intent', () => {
  it('reaches a complete decision by following highlighted options, even if the model only hesitates', () => {
    const state = newStory();
    let choices = ['谢谢，外面雨太大了。', '我就坐一会儿。', '咖啡真香。'];
    for (let turn = 0; turn < 11 && !state.ending; turn++) {
      const value = choices.find((value) => progressTarget(state, value));
      expect(value).toBeTruthy();
      const target = progressTarget(state, value!)!;
      const ack = present(state, value!);
      if (target.beat.startsWith('ending-')) expect(state.ending).toBe(target.beat.slice(-1));
      else expect(state.facts).toContain(target.beat);
      choices = ack.suggestions!;
    }
    expect(state.ending).toBe('a');
    expect(state.cues['reply-sent']).toBeDefined();
  });
  it('recognizes free paraphrases through all facts without skipping prerequisites or requiring menu text', () => {
    const state = newStory();
    const inputs = [
      '你好，我刚进来躲雨',
      '门被风吹得好响，桌上那张相片是你的吧',
      '我把照片递给你，边上有点水',
      '你盯着屏幕半天了，是遇到什么事了吗',
      '那明天行程已经定下来了吗',
      '这份工作对拍摄内容有什么要求',
      '你以前在那个地方有什么经历',
      '你的顾虑具体是什么',
      '让我看看你在手机上写了什么',
      '可以坦白告诉对方，自己经验不多，到了先聊再拍',
    ];
    for (const input of inputs) {
      expect(progressTarget(state, input)).toBeDefined();
      present(state, input);
    }
    expect(state.ending).toBe('a');
    expect(state.facts).toHaveLength(9);
  });
  it.each([
    '咖啡真好喝',
    '先别讲草稿',
    '换个话题吧',
    '不要继续往下说',
    '我没让你继续说',
    '随便',
    '我喜欢拍风景',
    '拍人时我也会有点紧张',
  ])('does not label boundaries or personal answers as guaranteed progression: %s', (input) => {
    const state = newStory();
    state.facts = [
      'arrival',
      'photo-drift',
      'phone-message',
      'commission',
      'ticket',
      'people',
      'memory',
      'fear',
    ];
    expect(progressTarget(state, input)).toBeUndefined();
  });
  it('lets model semantic intent fill a requested eligible fact beyond the local phrase recognizer', () => {
    const state = newStory();
    state.facts = ['arrival', 'photo-drift', 'phone-message', 'commission', 'ticket', 'people'];
    const input = '那段和人隔绝的旅程，愿意讲讲吗？';
    expect(progressTarget(state, input)).toBeUndefined();
    const reply = authorStory(
      storyContext(state),
      {
        ...stalled,
        story: { intent: 'engage' },
        segments: [{ ...stalled.segments[0], beat: 'memory' }],
      },
      input,
    );
    expect(reply.segments[0].text).toContain('两天没和人说话');
    expect(storyViolation(storyContext(state), reply, input)).toEqual([]);
  });
  it('keeps an explicit pause from moving props or committing a model beat', () => {
    const state = newStory();
    state.facts = ['arrival'];
    const input = '先别聊照片了';
    const reply = authorStory(
      storyContext(state),
      {
        ...stalled,
        segments: [{ ...stalled.segments[0], beat: 'photo-drift', event: 'reveal-photo' }],
      },
      input,
    );
    const pending = prepareStory(
      state,
      { sessionId: crypto.randomUUID(), turnId: 1, text: input, history: [], fault: 'none' },
      reply,
    );
    acknowledgeStory(state, pending, pending.units.length);
    expect(state.facts).toEqual(['arrival']);
    expect(state.cues).toEqual({});
  });
  it('offers an explicit way back from an early quiet choice, without changing the story until clicked', () => {
    const state = newStory();
    state.declined = true;
    const values = guidedSuggestions(state, [
      '那就坐一会儿吧。',
      '我们聊聊雨吧。',
      '不用急着决定。',
    ]);
    expect(progressTarget(state, values[0])?.beat).toBe('arrival');
    expect(state.facts).toEqual([]);
    expect(state.declined).toBe(true);
    present(state, values[0]);
    expect(state.facts).toEqual(['arrival']);
    expect(state.declined).toBe(false);
  });
  it('keeps a main-story option when the only generated advancement would close an early refusal ending', () => {
    const state = newStory();
    state.facts = ['arrival', 'photo-drift', 'phone-message', 'commission'];
    const values = guidedSuggestions(state, ['你自己决定吧。', '咖啡真香。', '我先暖暖手。']);
    expect(progressTarget(state, values[0])?.beat).toBe('ticket');
    expect(values).toContain('你自己决定吧。');
  });
  it.each(['我建议先电话确认拍摄范围再决定。', '如果不想接，也可以拒绝。'])(
    'understands a personal new plan or refusal only at the decision: %s',
    (input) => {
      const state = newStory();
      state.facts = [
        'arrival',
        'photo-drift',
        'phone-message',
        'commission',
        'ticket',
        'people',
        'memory',
        'fear',
        'draft',
      ];
      const ack = present(state, input);
      expect(ack.story.ending).toBe(input.includes('电话') ? 'b' : 'c');
      if (state.ending === 'b')
        expect(state.cues['reply-sent']?.message).toContain('先电话确认拍摄范围再决定');
    },
  );
  it('keeps the actual saved proposal when the user confirms it in their own words', () => {
    const state = newStory();
    state.facts = [
      'arrival',
      'photo-drift',
      'phone-message',
      'commission',
      'ticket',
      'people',
      'memory',
      'fear',
      'draft',
    ];
    state.planQuote = '先电话确认拍摄范围再决定';
    const ack = present(state, '这个办法就按刚才的来吧。');
    expect(ack.story.ending).toBe('b');
    expect(state.cues['reply-sent']?.message).toContain(state.planQuote);
    expect(state.cues['reply-sent']?.message).not.toContain('按刚才的来吧');
  });
  it('highlights only eligible inputs, keeps text submission unchanged and does not show future disclosures', () => {
    const state = newStory();
    state.facts = ['arrival', 'photo-drift', 'phone-message'];
    const html = renderToStaticMarkup(
      <Suggestions
        story={state}
        values={['你为什么还没有回这条消息？', '咖啡真香。', '先停一下。']}
        onChoose={() => {}}
      />,
    );
    expect(html.match(/data-story-progress="true"/g)).toHaveLength(1);
    expect(html).toContain('story-progress');
    expect(html).not.toMatch(/有偿|七点|两天|车票|结局/);
    const choices = guidedSuggestions(state, ['咖啡真香。', '我喜欢加奶。', '换个话题。']);
    expect(choices).toHaveLength(3);
    expect(progressTarget(state, choices[0])?.beat).toBe('commission');
    state.ending = 'c';
    expect(guidedSuggestions(state, choices)).toEqual(choices);
    expect(progressTarget(state, choices[0])).toBeUndefined();
  });
});
