import { appPath } from './core/app-path';
import type { Emotion } from '../shared/protocol';
export const MIRA_ASSETS = {
 width:1024,height:1536,neutral:appPath('/characters/mira/mira-amber-neutral-v3.png'),
 emotions:{guarded:undefined,curious:appPath('/characters/mira/mira-amber-curious-v3.png'),relieved:appPath('/characters/mira/mira-amber-warm-v3.png')},
 blink:appPath('/characters/mira/mira-amber-blink-v3.png'),talk:appPath('/characters/mira/mira-amber-speaking-v3.png'),
} as const;
export const MOODS: Record<Emotion,string> = {guarded:'有些戒备',curious:'好奇',relieved:'释然'};
export function characterSource(emotion: Emotion) { return MIRA_ASSETS.emotions[emotion] ?? MIRA_ASSETS.neutral; }
