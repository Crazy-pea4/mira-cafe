import { z } from 'zod';
import { actionSchema } from './protocol';
import { progressSchema } from './progress';
import { storyViewSchema } from './story';

export const REPLAY_ASSET_VERSION = 'mira-2026-10-v3';
export const REPLAY_MAX_EVENTS = 1000;
export const REPLAY_MAX_TURNS = 50;
export const replayFrameSchema = progressSchema.shape.view.extend({
  story: storyViewSchema.optional(),
  status: z.enum(['idle', 'listening', 'thinking', 'speaking', 'narrating', 'error']),
  action: actionSchema,
  turnId: z.number().int().nonnegative(),
  presentation: z.enum(['none', 'simulated', 'audio-clock']),
  propFocus: z.enum(['none', 'photo', 'phone']),
  pendingAudio: z.boolean(),
  error: z.string().max(300),
  notice: z.string().max(300),
}).strict();
export const replayEventTypeSchema = z.enum([
  'recording.started', 'input.accepted', 'reply.started', 'subtitle.started', 'cue.started',
  'presentation.confirmed', 'turn.cancelled', 'turn.failed', 'turn.completed', 'story.reset',
]);
export const replayEventSchema = z.object({
  sequence: z.number().int().min(0).max(REPLAY_MAX_EVENTS - 1),
  atMs: z.number().finite().min(0).max(86_400_000),
  turnId: z.number().int().nonnegative(),
  type: replayEventTypeSchema,
  frame: replayFrameSchema,
}).strict();
export const replaySummarySchema = z.object({
  id: z.string().uuid(), createdAt: z.number().int().nonnegative(),
  status: z.enum(['recording', 'stopped', 'limit']),
  count: z.number().int().min(1).max(REPLAY_MAX_EVENTS),
  turns: z.number().int().min(0).max(REPLAY_MAX_TURNS),
  durationMs: z.number().finite().nonnegative(),
  assetVersion: z.string().max(60),
}).strict();
export const replayDataSchema = z.object({
  schemaVersion: z.literal(1), recording: replaySummarySchema,
  events: z.array(replayEventSchema).min(1).max(REPLAY_MAX_EVENTS),
}).strict();
export type ReplayFrame = z.infer<typeof replayFrameSchema>;
export type ReplayEventType = z.infer<typeof replayEventTypeSchema>;
export type ReplayEvent = z.infer<typeof replayEventSchema>;
export type ReplaySummary = z.infer<typeof replaySummarySchema>;
export type ReplayData = z.infer<typeof replayDataSchema>;

export function replayFrame(snapshot: ReplayFrame & { streamingText?: string; saveNotice?: string }): ReplayFrame {
  const { streamingText: _draft, saveNotice: _save, ...frame } = snapshot;
  return replayFrameSchema.parse(frame);
}
