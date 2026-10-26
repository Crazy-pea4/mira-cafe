import type { Action, CharacterStatus } from '../../shared/protocol';
export type CharacterPose =
  'idle' | 'listening' | 'thinking' | 'laughing' | 'surprised' | 'hesitant';
export const POSE_LABELS: Record<CharacterPose, string> = {
  idle: '自然待机',
  listening: '侧身认真倾听',
  thinking: '托腮抬眼思考',
  laughing: '捂嘴笑',
  surprised: '抬手惊讶',
  hesitant: '握住手臂、垂眼犹豫',
};
// Interaction owns the body while waiting/listening. Model actions are shown only
// when their dialogue is actually presented, never from a pending reply or cue.
export function characterPose(state: { status: CharacterStatus; action: Action }): CharacterPose {
  if (state.status === 'listening') return 'listening';
  if (state.status === 'thinking') return 'thinking';
  if (state.status === 'speaking' && ['laughing', 'surprised', 'hesitant'].includes(state.action))
    return state.action as CharacterPose;
  return 'idle';
}
