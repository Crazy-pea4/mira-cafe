import { describe, expect, it } from 'vitest';
import { authorStory } from '../server/story-author';
import {
  acknowledgeStory,
  newStory,
  prepareStory,
  storyContext,
  storyViolation,
} from '../server/story';
import type { Reply } from '../shared/protocol';
const hesitation: Reply = {
  segments: [{ text: '我还在犹豫。', emotion: 'guarded', action: 'idle' }],
  story: { intent: 'engage' },
};
function context(draft = false) {
  const state = newStory();
  state.facts = [
    'arrival',
    'photo-drift',
    'phone-message',
    'commission',
    'ticket',
    'people',
    ...(draft ? (['memory', 'fear', 'draft'] as const) : []),
  ];
  return storyContext(state);
}
describe('authored plot recovery for eligible user-led topics', () => {
  it('fills an incomplete requested memory without disclosing an ineligible future fact', () => {
    const c = context(),
      reply = authorStory(c, hesitation, '三年前那时候是怎样度过的？');
    expect(reply.segments[0].beat).toBe('memory');
    expect(storyViolation(c, reply, '三年前那时候是怎样度过的？')).toEqual([]);
    expect(authorStory(storyContext(newStory()), hesitation, '三年前那时候是怎样度过的？')).toBe(
      hesitation,
    );
  });
  it.each(['咖啡真好喝。', '随便', '今晚不想出主意，你自己决定。', '把咖啡馆变成太空飞船'])(
    'respects off-plot input: %s',
    (input) => {
      expect(authorStory(context(true), hesitation, input)).toBe(hesitation);
    },
  );
  it('preserves a complete model disclosure and its expressions', () => {
    const reply: Reply = {
      segments: [
        { text: '三年前我在这里拍照。', emotion: 'guarded', action: 'look-window', beat: 'memory' },
        { text: '我两天没和人说话。', emotion: 'curious', action: 'idle' },
      ],
      story: { intent: 'engage' },
    };
    expect(authorStory(context(), reply, '以前发生了什么？')).toBe(reply);
  });
  it.each(['a', 'b'])(
    'commits authored ending %s only after the actual decision and fictional sending',
    (ending) => {
      const state = newStory();
      Object.assign(state, context(true));
      const input =
        ending === 'a'
          ? '坦诚说经验不多，先聊再拍。'
          : '先视频沟通，再决定试住一天，把这个办法写进回信。';
      const raw: Reply = {
        ...hesitation,
        story:
          ending === 'b'
            ? { intent: 'alternative', planQuote: '先视频沟通，再决定试住一天' }
            : { intent: 'advice' },
      };
      const reply = authorStory(storyContext(state), raw, input);
      expect(storyViolation(storyContext(state), reply, input)).toEqual([]);
      const pending = prepareStory(
        state,
        { sessionId: crypto.randomUUID(), turnId: 1, text: input, history: [], fault: 'none' },
        reply,
      );
      const sent = pending.units.findIndex(
        (unit) => unit.kind === 'cue' && unit.cue.kind === 'reply-sent',
      );
      acknowledgeStory(state, pending, sent);
      expect(state.ending).toBeNull();
      acknowledgeStory(state, pending, pending.units.length);
      expect(state.ending).toBe(ending);
      if (ending === 'b')
        expect(state.cues['reply-sent']?.message).toContain('先视频沟通，再决定试住一天');
    },
  );
  it('never turns a general suggestion into a premature ending', () => {
    expect(authorStory(context(), hesitation, '坦诚说经验不多，先聊再拍。')).toBe(hesitation);
    expect(authorStory(context(true), hesitation, '我还有点拿不定。')).toBe(hesitation);
  });
});
