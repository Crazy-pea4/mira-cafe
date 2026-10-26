import { describe, expect, it } from 'vitest';
import {
  acknowledgeStory,
  newStory,
  prepareStory,
  storyContext,
  storyViolation,
} from '../server/story';
import type { Reply, TurnRequest } from '../shared/protocol';
import { sentences } from '../shared/story';
const request: TurnRequest = {
  sessionId: '55555555-5555-4555-8555-555555555555',
  turnId: 1,
  text: '那时候是怎样度过的？',
  history: [],
  fault: 'none',
};
const segment = (text: string) => ({ text, emotion: 'curious' as const, action: 'idle' as const });
function known() {
  const state = newStory();
  state.facts = ['arrival', 'photo-drift', 'phone-message', 'commission', 'ticket', 'people'];
  return state;
}
describe('split model facts and decisions', () => {
  it('keeps closing quotes with the spoken sentence rather than sending punctuation to TTS', () => {
    expect(sentences('草稿是：“没问题。我很擅长这类拍摄。明天见。”')).toEqual([
      '草稿是：“没问题。',
      '我很擅长这类拍摄。',
      '明天见。”',
    ]);
    expect(sentences('真的吗？！再坐一会儿吧。')).toEqual(['真的吗？！', '再坐一会儿吧。']);
  });
  it.each([0, 1])('counts both presented segments with the beat on segment %i', (index) => {
    const state = known();
    const reply: Reply = {
      segments: [segment('三年前拍这张照片的时候。'), segment('我两天没和人说话。')],
      story: { intent: 'engage' },
    };
    reply.segments[index].beat = 'memory';
    expect(storyViolation(storyContext(state), reply, request.text)).toEqual([]);
    const pending = prepareStory(state, request, reply);
    acknowledgeStory(state, pending, 1);
    expect(state.facts).not.toContain('memory');
    expect(storyContext(state).summary).not.toContain('两天没');
    acknowledgeStory(state, pending, pending.units.length);
    expect(state.facts).toContain('memory');
    const summary = storyContext(state).summary;
    acknowledgeStory(state, pending, pending.units.length);
    expect(storyContext(state).summary).toBe(summary);
  });
  it('does not learn an unpresented second segment, even if its first segment contains a complete fact', () => {
    const state = known();
    const reply: Reply = {
      segments: [
        { ...segment('三年前拍照时，我两天没和人说话。'), beat: 'memory' },
        segment('那时我只想拍山和窗。'),
      ],
      story: { intent: 'engage' },
    };
    const pending = prepareStory(state, request, reply);
    acknowledgeStory(state, pending, 1);
    expect(state.facts).not.toContain('memory');
    expect(state.history[1].content).not.toContain('山和窗');
  });
  it('sends only after a two-segment decision is fully presented, and then commits its ending', () => {
    const state = known();
    state.facts.push('memory', 'fear', 'draft');
    const reply: Reply = {
      segments: [
        { ...segment('我想去，会诚实告诉他们拍人的经验不多。'), beat: 'ending-a', scene: 'warm' },
        segment('明天先聊再拍，我决定这样回信。'),
      ],
      story: { intent: 'advice' },
    };
    expect(storyViolation(storyContext(state), reply, request.text)).toEqual([]);
    const pending = prepareStory(state, request, reply);
    const sent = pending.units.findIndex(
      (unit) => unit.kind === 'cue' && unit.cue.kind === 'reply-sent',
    );
    expect(
      pending.units
        .slice(0, sent)
        .filter((unit) => unit.kind === 'dialogue')
        .map((unit) => unit.text)
        .join(''),
    ).toContain('明天先聊再拍');
    expect(pending.reply.segments.every((segment) => segment.scene === undefined)).toBe(true);
    acknowledgeStory(state, pending, sent);
    expect(state.ending).toBeNull();
    expect(state.cues['reply-sent']).toBeUndefined();
    acknowledgeStory(state, pending, sent + 1);
    expect(state.ending).toBe('a');
  });
});
