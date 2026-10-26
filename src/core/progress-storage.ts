import { z } from 'zod';
import { emotionSchema, sceneSchema } from '../../shared/protocol';
import { storyViewSchema } from '../../shared/story';
import { appPath } from './app-path';
import { stageLocationSchema } from '../../shared/stage';

const progressSchema = z.object({
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
export interface ProgressStorage {
  load(): SavedProgress | null;
  save(progress: SavedProgress): void;
  clear(): void;
}

export class LocalProgressStorage implements ProgressStorage {
  private key = 'mira-cafe:progress:v1:' + appPath();
  constructor(private storage: () => Storage = () => window.localStorage) {}
  load() {
    const value = this.storage().getItem(this.key);
    if (!value) return null;
    if (value.length > 48000) throw new Error('Invalid save');
    return progressSchema.parse(JSON.parse(value));
  }
  save(progress: SavedProgress) {
    this.storage().setItem(this.key, JSON.stringify(progress));
  }
  clear() {
    this.storage().removeItem(this.key);
  }
}
