import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { historySchema } from '../shared/protocol';
import { stageCueSchema } from '../shared/stage';
import { storyBeatSchema, storyViewSchema } from '../shared/story';
import type { StoryState } from './story';

const stateSchema = storyViewSchema.extend({
  history: z.array(historySchema).max(12),
  lastSuggestions: z.array(z.string().min(1).max(26)).max(3),
  disclosures: z.partialRecord(storyBeatSchema, z.string().max(600)),
  cues: z.partialRecord(stageCueSchema.shape.kind, stageCueSchema),
});

// Keep this key across local server restarts. Public deployments use their
// existing invitation hash as key material, so no extra secret needs deploying.
export function loadStorySaveKey(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const key = randomBytes(32).toString('hex');
    writeFileSync(path, key, { mode: 0o600, flag: 'wx' });
    return key;
  }
}

export function storySaves(key: string, scope: string) {
  const sign = (payload: string) =>
    createHmac('sha256', key)
      .update('mira-story-v1:' + scope + ':' + payload)
      .digest();
  return {
    seal(state: StoryState): string {
      const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
      return payload + '.' + sign(payload).toString('base64url');
    },
    open(token: string): StoryState | undefined {
      if (token.length > 40000) return;
      const [payload, signature, extra] = token.split('.');
      if (!payload || !signature || extra !== undefined) return;
      const received = Buffer.from(signature, 'base64url');
      const expected = sign(payload);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) return;
      try {
        const parsed = stateSchema.safeParse(
          JSON.parse(Buffer.from(payload, 'base64url').toString()),
        );
        return parsed.success ? parsed.data : undefined;
      } catch {
        return;
      }
    },
  };
}
