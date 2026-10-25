import { z } from 'zod';
export const STORY_OPENING = '躲雨的？坐吧，这边没漏水。';
export const storyFactSchema = z.enum(['arrival','photo-drift','phone-message','commission','ticket','people','memory','fear','practice','draft']);
export const storyBeatSchema = z.enum([...storyFactSchema.options,'ending-a','ending-b','ending-c']);
export const storyIntentSchema = z.enum(['engage','smalltalk','clarify','alternative','advice','decline','reframe']);
export const storyProposalSchema = z.object({ intent:storyIntentSchema, planQuote:z.string().trim().min(1).max(60).optional() }).strict();
export const suggestionSchema = z.array(z.string().trim().min(2).max(26)).length(3).refine(values=>new Set(values.map(value=>value.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu,'').toLowerCase())).size===3,'Suggestions must be distinct');
export const storyViewSchema = z.object({
  act:z.enum(['invitation','hesitation','reply','ending']),
  facts:z.array(storyFactSchema).max(10), ending:z.enum(['a','b','c']).nullable(),
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
export type StoryContext=StoryView & { summary:string; allowedBeats:StoryBeat[]; lastAskedQuestion:boolean; presentedSuggestions:string[] };
export const INITIAL_SUGGESTIONS=['谢谢，外面雨太大了。','你也在这里躲雨？','我就坐一会儿，不打扰你。'];
export function sentences(text:string):string[]{return text.match(/[^。！？!?]+[。！？!?]?/g)??[text];}
