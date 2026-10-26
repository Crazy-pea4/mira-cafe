import { z } from 'zod';
export const OPENING_NARRATION =
  '你推门躲进雨夜的咖啡馆。窗边的女孩把照片挪到杯边，给你让出一个位置。';
export const stageLocationSchema = z.enum(['cafe', 'lodge']);
export type StageLocation = z.infer<typeof stageLocationSchema>;
export const stageCueSchema = z
  .object({
    kind: z.enum(['photo-drift', 'phone-message', 'lodge-view', 'practice', 'draft', 'reply-sent']),
    text: z.string().trim().min(1).max(100),
    placement: z.enum(['before', 'after']),
    photoReturn: z.boolean().optional(),
    message: z.string().trim().min(1).max(180).optional(),
  })
  .strict();
export type StageCue = z.infer<typeof stageCueSchema>;
export type PropFocus = 'none' | 'photo' | 'phone';
export type StageProps = {
  photoPose: 'aside' | 'near' | 'returned';
  phone: 'none' | 'incoming' | 'resting' | 'draft' | 'sent';
  message: string;
};
export const INITIAL_PROPS: StageProps = { photoPose: 'aside', phone: 'none', message: '' };
export function locationAfterCue(location: StageLocation, cue: StageCue): StageLocation {
  if (cue.kind === 'lodge-view') return 'lodge';
  if (['practice', 'draft', 'reply-sent'].includes(cue.kind)) return 'cafe';
  return location;
}
export function applyCue(props: StageProps, cue: StageCue): StageProps {
  if (cue.kind === 'photo-drift') return { ...props, photoPose: 'near' };
  if (cue.kind === 'phone-message')
    return {
      ...props,
      photoPose: cue.photoReturn ? 'returned' : props.photoPose,
      phone: 'incoming',
      message: cue.message ?? '',
    };
  if (cue.kind === 'practice') return { ...props, phone: 'resting' };
  if (cue.kind === 'draft') return { ...props, phone: 'draft', message: cue.message ?? '' };
  if (cue.kind === 'reply-sent') return { ...props, phone: 'sent', message: cue.message ?? '' };
  return { ...props };
}
