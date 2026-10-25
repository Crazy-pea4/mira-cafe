import { z } from 'zod';
export const emotionSchema = z.enum(['guarded', 'curious', 'relieved']);
export const actionSchema = z.enum(['idle', 'look-window', 'offer-photo']);
export const sceneSchema = z.enum(['rain', 'warm']);
export const segmentSchema = z.object({
  text: z.string().trim().min(1).max(180),
  emotion: emotionSchema,
  action: actionSchema,
  scene: sceneSchema.optional(),
  event: z.literal('reveal-photo').optional(),
}).strict();
export const REPLY_TEXT_ONLY_NOTICE = '本次仅保留可用对白，未采用不合规的演出指令。';
export const replySchema = z.object({ segments: z.array(segmentSchema).min(1).max(3), notice: z.literal('REPLY_TEXT_ONLY').optional() }).strict();
export const historySchema = z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(800) }).strict();
export const turnRequestSchema = z.object({
  sessionId: z.string().uuid(), turnId: z.number().int().positive(),
  text: z.string().trim().min(1).max(800),
  history: z.array(historySchema).max(12).default([]),
  fault: z.enum(['none', 'slow', 'timeout', 'error']).default('none'),
}).strict();
export const cancelSchema = z.object({ sessionId: z.string().uuid(), throughTurnId: z.number().int().nonnegative() }).strict();
export const turnResponseSchema = replySchema.extend({ turnId: z.number().int().positive(), provider: z.enum(['mock', 'deepseek']) });
export type Emotion = z.infer<typeof emotionSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type Reply = z.infer<typeof replySchema>;
export type TurnRequest = z.infer<typeof turnRequestSchema>;
export type TurnResponse = z.infer<typeof turnResponseSchema>;
export type History = z.infer<typeof historySchema>[];
export type Fault = TurnRequest['fault'];
export type CharacterStatus = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

