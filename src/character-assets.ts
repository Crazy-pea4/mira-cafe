import type { Emotion } from '../shared/protocol';
export const MIRA_ASSETS = {
 width:1024,height:1536,neutral:'/characters/mira/mira-amber-neutral-v3.png',
 emotions:{guarded:undefined,curious:'/characters/mira/mira-amber-curious-v3.png',relieved:'/characters/mira/mira-amber-warm-v3.png'},
 blink:'/characters/mira/mira-amber-blink-v3.png',talk:'/characters/mira/mira-amber-speaking-v3.png',
} as const;
export const MOODS: Record<Emotion,string> = {guarded:'有些戒备',curious:'好奇',relieved:'释然'};
export function characterSource(emotion: Emotion) { return MIRA_ASSETS.emotions[emotion] ?? MIRA_ASSETS.neutral; }
