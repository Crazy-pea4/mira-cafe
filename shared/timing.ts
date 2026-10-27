import { z } from 'zod';
const ms = z.number().finite().min(0).max(86_400_000);
export const timingRecordSchema = z.object({
  id: z.number().int().positive(),
  kind: z.enum(['asr', 'model', 'tts', 'playback']),
  turnId: z.number().int().positive().optional(),
  mode: z.enum(['live', 'mock', 'unknown']),
  status: z.enum(['complete', 'cancelled', 'error']),
  startedAt: ms,
  elapsedMs: ms,
  points: z.object({ ready: ms.optional(), commit: ms.optional(), firstText: ms.optional(), firstAudio: ms.optional(), firstPlayback: ms.optional() }).strict(),
}).strict();
export const timingBatchSchema = z.object({ pageId: z.string().uuid(), records: z.array(timingRecordSchema).min(1).max(20) }).strict();
