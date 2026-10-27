import { z } from 'zod';
import { emotionSchema, sceneSchema } from './protocol';
import { storyViewSchema } from './story';
import { stageLocationSchema } from './stage';

export const progressSchema = z.object({
  version: z.literal(1),
  checkpoint: z.string().min(1).max(40000),
  view: z.object({
    story: storyViewSchema,
    suggestions: z.array(z.string().max(26)).max(3),
    narration: z.string().max(100),
    subtitle: z.string().max(180),
    emotion: emotionSchema,
    scene: sceneSchema,
    location: stageLocationSchema.default('cafe'),
    photo: z.boolean(),
    stageProps: z.object({
      photoPose: z.enum(['aside', 'near', 'returned']),
      phone: z.enum(['none', 'incoming', 'resting', 'draft', 'sent']),
      message: z.string().max(180),
    }),
    lastInput: z.string().max(800),
    completed: z.number().int().nonnegative(),
  }),
});
export type SavedProgress = z.infer<typeof progressSchema>;
