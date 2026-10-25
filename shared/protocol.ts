import { z } from 'zod';
import { stageCueSchema } from './stage';
import { sentences } from './story';
import { storyBeatSchema, storyProposalSchema, suggestionSchema } from './story';
export const emotionSchema = z.enum(['guarded', 'curious', 'relieved']);
export const actionSchema = z.enum(['idle', 'look-window', 'offer-photo']);
export const sceneSchema = z.enum(['rain', 'warm']);
const dialogueSegmentSchema = z.object({
  text: z.string().trim().min(1).max(180),
  emotion: emotionSchema,
  action: actionSchema,
  scene: sceneSchema.optional(),
  event: z.literal('reveal-photo').optional(),
  beat: storyBeatSchema.optional(),
}).strict();
export const segmentSchema = dialogueSegmentSchema.extend({cue:stageCueSchema.optional()});
// Authoritative live model contract; renderer schema remains wider for legacy/mock replies.
export const modelReplySchema = z.object({
  segments: z.array(dialogueSegmentSchema.extend({
    text: z.string().trim().min(1).max(120).refine(text => /[\p{L}\p{N}]/u.test(text) && !/^(\{|\[|`{3})/.test(text), 'Dialogue required'),
  })).min(1).max(2),
  story: storyProposalSchema.optional(),
}).strict().refine(reply => reply.segments.reduce((sum,segment)=>sum+segment.text.length,0)<=120, 'Total dialogue limit');
export const REPLY_TEXT_ONLY_NOTICE = '这次仅保留对白，场景动作暂未同步。';
export const replySchema = z.object({ segments: z.array(segmentSchema).min(1).max(3), notice: z.literal('REPLY_TEXT_ONLY').optional(), story: storyProposalSchema.optional(), suggestions: suggestionSchema.optional() }).strict();
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
export type CharacterStatus = 'idle' | 'listening' | 'thinking' | 'speaking' | 'narrating' | 'error';


export type PresentationUnit = {kind:'dialogue';text:string;segment:number;last:boolean}|{kind:'cue';text:string;segment:number;last:boolean;cue:import('./stage').StageCue};
export function presentationUnits(reply:Reply):PresentationUnit[]{
 return reply.segments.flatMap((segment,index)=>{
  const parts=sentences(segment.text);
  const spoken:PresentationUnit[]=parts.map((text,i)=>({kind:'dialogue',text,segment:index,last:i===parts.length-1}));
  if(!segment.cue)return spoken;
  const cue:PresentationUnit={kind:'cue',text:segment.cue.text,segment:index,last:true,cue:segment.cue};
  return segment.cue.placement==='before'?[cue,...spoken]:[...spoken,cue];
 });
}
