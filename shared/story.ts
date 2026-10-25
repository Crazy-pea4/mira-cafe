import { z } from 'zod';
export const STORY_OPENING = '你赶时间吗？我有条消息删了四遍，想借一个不认识我的人的意见。';
export const storyFactSchema = z.enum(['commission','ticket','people','memory','fear','draft']);
export const storyBeatSchema = z.enum([...storyFactSchema.options,'ending-a','ending-b','ending-c']);
export const storyIntentSchema = z.enum(['engage','smalltalk','clarify','alternative','advice','decline','reframe']);
export const storyProposalSchema = z.object({ intent:storyIntentSchema, planQuote:z.string().trim().min(1).max(60).optional() }).strict();
export const suggestionSchema = z.array(z.string().trim().min(2).max(26)).length(3).refine(values=>new Set(values.map(value=>value.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu,'').toLowerCase())).size===3,'Suggestions must be distinct');
export const storyViewSchema = z.object({
  act:z.enum(['invitation','hesitation','reply','ending']),
  facts:z.array(storyFactSchema).max(6), ending:z.enum(['a','b','c']).nullable(),
  planQuote:z.string().max(60), declined:z.boolean(),
}).strict();
export const presentationSchema=z.object({sessionId:z.string().uuid(),turnId:z.number().int().positive(),through:z.number().int().min(1).max(540)}).strict();
export const presentationResponseSchema=z.object({turnId:z.number().int().positive(),through:z.number().int().min(1).max(540),story:storyViewSchema,suggestions:suggestionSchema.optional()}).strict();
export type StoryFact=z.infer<typeof storyFactSchema>;
export type StoryBeat=z.infer<typeof storyBeatSchema>;
export type StoryProposal=z.infer<typeof storyProposalSchema>;
export type StoryView=z.infer<typeof storyViewSchema>;
export type Presentation=z.infer<typeof presentationSchema>;
export type PresentationResponse=z.infer<typeof presentationResponseSchema>;
export type StoryContext=StoryView & { summary:string; allowedBeats:StoryBeat[]; lastAskedQuestion:boolean };
export const INITIAL_SUGGESTIONS=['可以，是什么消息？','先喝口咖啡，慢慢说。','今晚不想出主意，聊点别的吧。'];
export function sentences(text:string):string[]{return text.match(/[^。！？!?]+[。！？!?]?/g)??[text];}
