import type { StoryBeat, StoryView } from './story';

export function allowedBeats(state: StoryView): StoryBeat[] {
  if (state.ending) return [];
  const known = new Set(state.facts);
  if (!known.has('arrival')) return ['arrival'];
  if (!known.has('photo-drift')) return ['photo-drift'];
  if (!known.has('phone-message')) return ['phone-message'];
  if (!known.has('commission')) return ['commission'];
  const next: StoryBeat[] = [];
  for (const fact of ['ticket', 'people', 'memory'] as const) if (!known.has(fact)) next.push(fact);
  if (known.has('people') && !known.has('fear')) next.push('fear');
  if (
    (['ticket', 'people', 'memory', 'fear'] as const).every((f) => known.has(f)) &&
    !known.has('draft')
  )
    next.push('draft');
  if (known.has('fear') && !known.has('practice')) next.push('practice');
  if (known.has('draft'))
    next.push('ending-a', ...(state.planQuote ? ['ending-b' as const] : []), 'ending-c');
  if (state.declined && !next.includes('ending-c')) next.push('ending-c');
  return next;
}

export function inputBoundary(text: string): 'decline' | 'smalltalk' | 'reframe' | undefined {
  if (
    /不想(?:聊|参与|出主意)|不聊这个|别(?:再)?问我|别再聊|你自己决定|自己拿主意|不帮.*(?:决定|主意)/.test(
      text,
    )
  )
    return 'decline';
  if (
    /变成.*(?:太空|飞船|魔法)|这里是.*(?:太空|飞船)|你是.*(?:机器人|魔法师)|把咖啡馆.*(?:太空|飞船)/.test(
      text,
    )
  )
    return 'reframe';
  if (pausesStory(text)) return 'smalltalk';
  if (
    /咖啡|猫|蛋糕|电影|音乐|天气/.test(text) &&
    !/委托|拍|回信|旅馆|车票|消息|旅行|决定|试住|视频|继续|接着|说下去/.test(text)
  )
    return 'smalltalk';
  return;
}
export function pausesStory(text: string): boolean {
  return /换个话题|聊点别的|先不(?:聊|说)|先暂停|先停一下|别(?:说|讲|提|聊)|不想(?:看|听)|不要(?:说|讲|提)|不(?:要|想|愿意).*(?:继续|听下去|往下说)|没(?:让|叫|要求).*(?:继续|说|讲)/.test(
    text,
  );
}

export type ProgressTarget = { beat: StoryBeat; planQuote?: string };
const continuation =
  /继续|接着(?:讲|说|聊)|说下去|讲下去|往下(?:讲|说)|然后呢|后来呢|我(?:愿意|想|还想)听|我在听|慢慢(?:说|讲)|说说看|再(?:讲|说)(?:一点|下去)|你的故事/;
const alternative =
  /(?:先|不如|要不|可以).*(?:视频|试住|电话|沟通|协商|准备|问清|确认|分开|分步|只拍|练习)|我的(?:办法|方案|想法)/;
const ambiguous = /^(随便|都行|嗯|好吧|不知道|也许)[。！!？?\s]*$/;
export function progressTarget(state: StoryView, input: string): ProgressTarget | undefined {
  if (state.ending || !input.trim() || ambiguous.test(input.trim())) return;
  const boundary = inputBoundary(input);
  if (boundary === 'decline')
    return state.facts.includes('commission') ? { beat: 'ending-c' } : undefined;
  if (boundary) return;
  if (
    /^(?:我|其实我|拍人时我|学过一点|还在摸索|那段时间)/.test(input) &&
    !/你|想(?:知道|了解|听)|愿意听|我在听|继续|接着|慢慢(?:说|讲)/.test(input) &&
    !/^我(?:建议|觉得|的(?:建议|想法|办法))/.test(input) &&
    !alternative.test(input)
  )
    return;
  const allowed = allowedBeats(state);
  if (state.facts.includes('draft')) {
    if (/拒绝|婉拒|不接|不去了|不接受/.test(input)) return { beat: 'ending-c' };
    if (alternative.test(input)) {
      const quote = input
        .replace(/^(?:我(?:觉得|建议|的(?:办法|想法|建议)是)|不如|要不|你可以)[，,:：\s]*/, '')
        .split(/[，,](?:把|就把|这个办法|请把)/)[0]
        .replace(/[。！!？?]+$/, '')
        .slice(0, 60);
      return { beat: 'ending-b', planQuote: quote };
    }
    if (state.planQuote && /刚才|这个办法|那个办法|照这个|按这个|就这样|就这么|写进去/.test(input))
      return { beat: 'ending-b' };
    if (/坦诚|诚实|经验|承认|先聊再拍|去试试/.test(input)) return { beat: 'ending-a' };
    return;
  }
  // A proposed solution is remembered by the model but never skips to a decision.
  if (alternative.test(input)) return;
  const topics: [StoryBeat, RegExp][] = [
    ['arrival', /谢谢|你好|躲雨|暖|坐|雨|进来/],
    ['photo-drift', /照片|相片|风(?!景)|窗|门/],
    ['phone-message', /照片|相片|递|给你|还你|自己拿|不理|手机|消息|怎么了/],
    [
      'commission',
      /旅馆|消息|回信|犹豫|接你|接站|邀请|什么事|难在哪|原因|没想好|打了又删|屏幕|拿不定|心事/,
    ],
    ['ticket', /车票|买票|订票|行程|决定.*去|去不去/],
    ['people', /希望.*拍|想.*拍什么|拍什么|拍谁|要求|需要.*拍|除了风景|不只.*风景|拍人/],
    ['memory', /三年前|以前|过去|那时候|当时|怎样度过|独处|去过|经历|怎么找到|怎么认识/],
    ['fear', /担心|害怕|怕|拍人.*不同|顾虑|犹豫|紧张|最难|没回.*原因/],
    ['practice', /练习|采访|拿我|你问|问我/],
    ['draft', /草稿|回信|手机.*写|看看.*写/],
  ];
  const match = topics.find(([beat, pattern]) => allowed.includes(beat) && pattern.test(input));
  if (match) return { beat: match[0] };
  if (continuation.test(input) || /为什么.*(?:没|不).*回|什么.*(?:犹豫|顾虑)|拿不定/.test(input)) {
    const next = allowed.find((beat) => !beat.startsWith('ending-') && beat !== 'practice');
    if (next) return { beat: next };
  }
}

const choices: Partial<Record<StoryBeat, string>> = {
  arrival: '谢谢，外面雨太大了。',
  'photo-drift': '你桌上放的是照片吗？',
  'phone-message': '给你，照片别沾到水。',
  commission: '你为什么还没有回这条消息？',
  ticket: '你已经决定要去了吗？',
  people: '他们希望你拍些什么？',
  memory: '你以前去过那里吗？',
  fear: '拍人让你担心什么？',
  draft: '能看看你写的草稿吗？',
  'ending-a': '坦诚说经验不多，先聊再拍。',
  'ending-b': '先视频沟通，再决定试住一天。',
  'ending-c': '如果不想接，也可以拒绝。',
};
export function guidedSuggestions(
  state: StoryView,
  values: readonly string[],
  deferQuestion = false,
): string[] {
  if (!values.length || state.ending) return [...values];
  if (
    values.some((value) => {
      const target = progressTarget(state, value);
      return target && (state.facts.includes('draft') || !target.beat.startsWith('ending-'));
    })
  )
    return [...values];
  if (state.declined) return ['我还是想继续听你讲。', ...values.slice(0, 2)];
  const target = allowedBeats(state).find((beat) => beat !== 'practice');
  const choice =
    deferQuestion && !state.facts.includes('draft')
      ? '我的事可以稍后聊，先听你继续说。'
      : target
        ? choices[target]
        : undefined;
  if (!choice) return [...values];
  // Keep two free directions. This is an optional player line, never a completed fact.
  return [choice, ...values.filter((value) => value !== choice).slice(0, 2)];
}
