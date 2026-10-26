import type { Reply } from '../shared/protocol';
import type { StoryBeat, StoryContext } from '../shared/story';
import { factComplete, inputBoundary, proposalFor } from './story';

// The fixed short story owns its facts and decisions. Free conversation remains
// model-generated; these authored lines cover an explicitly requested, eligible
// plot point when a structurally valid model reply does not tell it completely.
export function authorStory(context: StoryContext, reply: Reply, input: string): Reply {
  if (context.ending || inputBoundary(input)) return reply;
  const proposal = proposalFor(reply, input);
  if (['decline', 'clarify', 'smalltalk', 'reframe'].includes(proposal.intent)) return reply;
  const allowed = new Set(context.allowedBeats);
  let beat: StoryBeat | undefined;
  let text = '';
  const plot: [StoryBeat, RegExp, string][] = [
    [
      'commission',
      /旅馆|消息|回信|犹豫|接你/,
      '这是我的第一份有偿摄影委托。明早七点去照片里的小旅馆，可回信还没发。',
    ],
    ['ticket', /车票|买票|订票/, '车票已经买好了。可回信还留在手机里，买票好像比答应一个人容易。'],
    [
      'people',
      /(?:他们|对方|旅馆).*(?:拍什么|还.*拍|希望.*拍)|除了风景/,
      '他们不只要风景，也要拍住在那里的人。拍山和窗我习惯了，人一看向镜头，我就有点拿不准。',
    ],
    [
      'memory',
      /三年前|以前|那时候|当时|怎样度过|独处/,
      '三年前拍这张照片时，我整整两天没和人说话。那时只对着山和窗，也不用想下一句该说什么。',
    ],
    [
      'fear',
      /担心|害怕|怕|拍人.*不同/,
      '风景不会看着我，等我说下一句。拍人时，我怕他们不愿被拍，也怕他们愿意配合，我却拍不好。',
    ],
    [
      'draft',
      /草稿|回信|手机.*写/,
      '草稿是：“没问题，我很擅长这类拍摄。明天见。”我把“很擅长”圈出来了，它不像我。',
    ],
  ];
  const match = plot.find(([candidate, pattern]) => allowed.has(candidate) && pattern.test(input));
  if (match) [beat, , text] = match;
  if (context.facts.includes('draft')) {
    const quote = proposal.planQuote ?? context.planQuote;
    if (/坦诚|诚实|承认|经验/.test(input) && /聊|拍/.test(input)) {
      beat = 'ending-a';
      text = '我想去，但会诚实告诉他们，拍人的经验还不多。明天先聊再拍，我决定这样改回信。';
    } else if (quote && /回信|写进|照这个|按这个|就这样|就这么/.test(input)) {
      beat = 'ending-b';
      text = '我想' + quote + '。这样不必逞强，也不用立刻关上门，我决定把这个办法写进回信。';
    }
  }
  if (!beat) return reply;
  const spoken = reply.segments.map((segment) => segment.text).join('');
  const complete =
    factComplete(beat, spoken) &&
    (beat !== 'ending-b' || spoken.includes(proposal.planQuote ?? context.planQuote));
  if (complete && reply.segments.some((segment) => segment.beat === beat)) return reply;
  const ending = beat.startsWith('ending-');
  const story = ending
    ? { ...proposal, intent: beat === 'ending-a' ? ('advice' as const) : ('alternative' as const) }
    : proposal;
  return {
    segments: [
      {
        text,
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
