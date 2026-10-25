import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIRA_ASSETS } from '../src/character-assets';

describe('current Mira art set', () => {
 it('ships a complete versioned RGBA set without mixing historical outfits', () => {
  const paths = [MIRA_ASSETS.neutral, MIRA_ASSETS.emotions.curious, MIRA_ASSETS.emotions.relieved, MIRA_ASSETS.blink, MIRA_ASSETS.talk, ...Object.values(MIRA_ASSETS.poses)];
  expect(new Set(paths).size).toBe(10);
  for (const path of paths) {
   expect(path).toMatch(/^\/characters\/mira\/mira-amber-(?:(neutral|curious|warm|blink|speaking)-v3|(thinking|laughing|listening|surprised|hesitant)-upperbody-v[12])\.png$/);
   const png=readFileSync(`public${path}`);
   expect(png.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
   expect([png.readUInt32BE(16),png.readUInt32BE(20),png[24],png[25]]).toEqual([1024,1536,8,6]);
  }
  expect(readdirSync('public/characters/mira').filter(p=>p.endsWith('.png')).sort()).toEqual(paths.map(p=>p.split('/').at(-1)).sort());
 });
});
