import type { Emotion } from '../shared/protocol';
export const MIRA_ASSETS = {
 width:1024,height:1536,neutral:'/characters/mira/neutral.png',
 emotions:{guarded:undefined,curious:'/characters/mira/mira-curious-v1.png',relieved:'/characters/mira/mira-warm-v1.png'},
 blink:'/characters/mira/mira-blink-v1.png',talk:'/characters/mira/mira-speaking-v1.png',
} as const;
export const MOODS: Record<Emotion,string> = {guarded:'有些戒备',curious:'好奇',relieved:'释然'};
export function characterSource(emotion: Emotion) { return MIRA_ASSETS.emotions[emotion] ?? MIRA_ASSETS.neutral; }
