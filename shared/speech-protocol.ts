import { z } from 'zod';
const identity = { requestId: z.string().uuid(), turnId: z.number().int().positive() };
const base64 = z.string().min(4).max(64000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const speechClientSchema = z.discriminatedUnion('type', [
 z.object({type:z.literal('asr.start'),...identity}).strict(),
 z.object({type:z.literal('asr.audio'),...identity,audio:base64,sampleRate:z.literal(16000)}).strict(),
 z.object({type:z.literal('asr.commit'),...identity}).strict(),
 z.object({type:z.literal('tts.start'),...identity,text:z.string().trim().min(1).max(180)}).strict(),
 z.object({type:z.literal('cancel'),...identity}).strict(),
]);
export const speechServerSchema = z.discriminatedUnion('type', [
 z.object({type:z.literal('ready'),...identity}),
 z.object({type:z.literal('transcript'),...identity,text:z.string().min(1).max(800)}),
 z.object({type:z.literal('audio'),...identity,audio:base64,sampleRate:z.literal(24000)}),
 z.object({type:z.literal('done'),...identity}),
 z.object({type:z.literal('error'),...identity,code:z.string(),message:z.string()}),
]);
export type SpeechClientEvent=z.infer<typeof speechClientSchema>;
export type SpeechServerEvent=z.infer<typeof speechServerSchema>;
export const MIN_RECORDING_BYTES=8000;
export const MAX_RECORDING_BYTES=960000;
export function bytesToBase64(bytes:Uint8Array){let text='';for(const value of bytes)text+=String.fromCharCode(value);return btoa(text);}
export function base64ToBytes(text:string){return Uint8Array.from(atob(text),char=>char.charCodeAt(0));}
