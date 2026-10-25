import { describe, expect, it, vi } from 'vitest';
import { characterPose } from '../src/core/character-pose';
import { modelReplySchema, type Action, type TurnRequest } from '../shared/protocol';
import { DeepSeekProvider } from '../server/providers';
import { parseDeepSeekReply } from '../server/reply-parser';
import { mockStoryReply } from '../server/story-mock';
import { newStory, storyContext, prepareStory, acknowledgeStory } from '../server/story';
const request:TurnRequest={sessionId:'77777777-7777-4777-8777-777777777777',turnId:1,text:'讲个笑话逗你笑',history:[],fault:'none'};
const envelope=(action:Action)=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({segments:[{text:'你这样说，我倒笑出来了。',emotion:'relieved',action}]})}}]});
describe('coordinated upper-body poses',()=>{
 it('gives input and thinking priority, and returns to idle on all non-dialogue states',()=>{
  for(const action of ['laughing','surprised','hesitant'] as const){
   expect(characterPose({status:'listening',action})).toBe('listening');
   expect(characterPose({status:'thinking',action})).toBe('thinking');
   expect(characterPose({status:'speaking',action})).toBe(action);
   for(const status of ['idle','error','narrating'] as const)expect(characterPose({status,action})).toBe('idle');
  }
  for(const action of ['idle','look-window','offer-photo'] as const)expect(characterPose({status:'speaking',action})).toBe('idle');
 });
 it('accepts the three semantic poses through strict live parsing and keeps legacy actions',()=>{
  for(const action of ['idle','look-window','offer-photo','laughing','surprised','hesitant'] as const){
   expect(parseDeepSeekReply(envelope(action),undefined,true).segments[0].action).toBe(action);
  }
  for(const action of ['thinking','listening','run-code','dance']){
   expect(modelReplySchema.safeParse({segments:[{text:'有效对白',emotion:'curious',action}]}).success).toBe(false);
  }
 });
 it('keeps the real provider prompt, strict contract and semantic example consistent using fake HTTP',async()=>{
  const fetcher=vi.fn(async(_url: string | URL | Request, _init?: RequestInit)=>new Response(JSON.stringify(envelope('laughing'))));
  const reply=await new DeepSeekProvider('fixture','deepseek-flash',fetcher).reply(request,new AbortController().signal);
  expect(reply.segments[0].action).toBe('laughing');
  const body=JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
  const prompt=body.messages[0].content;
  expect(prompt).toContain('laughing/surprised/hesitant');
  expect(prompt).toContain('"action":"laughing"');
  expect(prompt).toContain('不每句换姿势');
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('selects Mock poses for semantic moments, while refusal never turns into a laugh',()=>{
  const state=newStory();
  expect(mockStoryReply(request,storyContext(state)).segments[0].action).toBe('laughing');
  expect(mockStoryReply({...request,text:'不想参与，别讲笑话。'},storyContext(state)).segments[0].action).toBe('idle');
  const advance=(text:string)=>{
   const input={...request,text},r=mockStoryReply(input,storyContext(state)),p=prepareStory(state,input,r);
   acknowledgeStory(state,p,p.units.length);return r;
  };
  expect(advance('谢谢，先坐一会儿。').segments[0].action).toBe('idle');
  expect(advance('风好大。').segments[0].action).toBe('surprised');
  expect(advance('照片还给你。').segments[0].action).toBe('hesitant');
  expect(advance('这是什么消息？').segments[0].action).toBe('idle');
 });
});
