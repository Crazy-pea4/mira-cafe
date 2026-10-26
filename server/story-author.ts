import type { Reply } from '../shared/protocol';
import type { StoryBeat, StoryContext, StoryProposal } from '../shared/story';
import {
  allowedBeats,
  inputBoundary,
  progressTarget,
  pausesStory,
} from '../shared/story-progression';
import { factComplete, proposalFor, storyViolation } from './story';

const lines: Record<StoryBeat, string> = {
  arrival: '这里干燥些，你先坐。等衣角的雨水慢慢滴干，不用急着赶路。',
  'photo-drift': '啊，风把照片吹到你那边了。边上有水，小心别沾湿。',
  'phone-message': '谢谢，我收好。是那家旅馆发来的消息，我还没想好怎么回。',
  commission: '这是我的第一份有偿摄影委托。明早七点去照片里的小旅馆，可回信还没发。',
  ticket: '车票已经买好了。可回信还留在手机里，买票好像比答应一个人容易。',
  people: '他们不只要风景，也要拍住在那里的人。拍山和窗我习惯了，人一看向镜头，我就有点拿不准。',
  memory: '三年前拍这张照片时，我整整两天没和人说话。那时只对着山和窗，也不用想下一句该说什么。',
  fear: '风景不会看着我，等我说下一句。拍人时，我怕他们不愿被拍，也怕他们愿意配合，我却拍不好。',
  practice: '好，我先不举相机。你进门选座位的时候，第一眼看见的是什么？',
  draft: '草稿是：“没问题，我很擅长这类拍摄。明天见。”我把“很擅长”圈出来了，它不像我。',
  'ending-a': '我想去，但会诚实告诉他们，拍人的经验还不多。明天先聊再拍，我决定这样改回信。',
  'ending-b': '',
  'ending-c':
    '我想过了，这次先婉拒委托。会有点遗憾，但白天你愿意的话，我们可以先练习拍照，再慢慢来。',
};

// Every live turn still calls the model. This director completes an eligible,
// requested fact when the model merely repeats its hesitation or omits its beat.
export function authorStory(context: StoryContext, reply: Reply, input: string): Reply {
  if (pausesStory(input))
    return {
      ...reply,
      story: { intent: 'smalltalk' },
      segments: reply.segments.map((segment) => {
        const { beat: _beat, event: _event, cue: _cue, scene: _scene, ...dialogue } = segment;
        return dialogue;
      }),
    };
  if (context.ending || inputBoundary(input)) return reply;
  const target = progressTarget(context, input);
  const proposal = proposalFor(reply, input);
  if (!target && ['decline', 'clarify', 'smalltalk', 'reframe'].includes(proposal.intent))
    return reply;
  const quote =
    target?.beat === 'ending-b' && !target.planQuote && context.planQuote
      ? context.planQuote
      : proposal.planQuote && input.includes(proposal.planQuote)
        ? proposal.planQuote
        : (target?.planQuote ?? context.planQuote);
  const eligible = allowedBeats({ ...context, planQuote: quote });
  const modelBeat = reply.segments.find((segment) => segment.beat)?.beat;
  // Invalid future tags still go through the existing bounded schema repair.
  if (modelBeat && !eligible.includes(modelBeat)) return reply;
  const beat = target?.beat ?? modelBeat;
  if (!beat || !eligible.includes(beat)) return reply;
  const ending = beat.startsWith('ending-');
  const { planQuote: _proposedQuote, ...baseProposal } = proposal;
  const story: StoryProposal = {
    ...baseProposal,
    intent:
      target || ending
        ? beat === 'ending-b'
          ? 'alternative'
          : ending
            ? 'advice'
            : 'engage'
        : proposal.intent,
    ...(quote && input.includes(quote) ? { planQuote: quote } : {}),
  };
  if (beat === 'ending-b' && !quote) return reply;
  const spoken = reply.segments.map((segment) => segment.text).join('');
  if (factComplete(beat, spoken) && (beat !== 'ending-b' || spoken.includes(quote))) {
    const completed: Reply = {
      ...reply,
      story,
      segments: reply.segments.map((segment, index) => {
        const { beat: _old, ...rest } = segment;
        return { ...rest, ...(index === 0 ? { beat } : {}) };
      }),
    };
    if (!storyViolation(context, completed, input).length) {
      if (modelBeat === beat && reply.story?.intent === story.intent) return reply;
      return completed;
    }
  }
  if (['photo-drift', 'phone-message'].includes(beat)) {
    const external: Reply = {
      ...reply,
      story,
      segments: reply.segments.map((segment, index) => {
        const { beat: _old, ...rest } = segment;
        return { ...rest, ...(index === 0 ? { beat } : {}) };
      }),
    };
    if (!storyViolation(context, external, input).length) return external;
  }
  return {
    ...reply,
    segments: [
      {
        text:
          beat === 'ending-b'
            ? '我想' + quote + '。这样不必逞强，也不用立刻关上门，我决定把这个办法写进回信。'
            : lines[beat],
        emotion: ending ? 'relieved' : beat === 'fear' ? 'guarded' : 'curious',
        action: ['fear', 'draft'].includes(beat)
          ? 'hesitant'
          : beat === 'memory'
            ? 'offer-photo'
            : 'idle',
        beat,
      },
    ],
    story,
  };
}
