import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect} from 'vitest';
import {Narrative} from '../src/Narrative';
import {ConversationEngine} from '../src/core/engine';
import {INITIAL_PROPS} from '../shared/stage';
import type {Reply} from '../shared/protocol';
const photo:Reply={segments:[{text:'这张是我的旅途照片。',emotion:'curious',action:'idle',cue:{kind:'photo-drift',placement:'before',text:'照片滑到了手边。'}}]};
const phone:Reply={segments:[{text:'是旅馆那边。',emotion:'guarded',action:'hesitant',cue:{kind:'phone-message',placement:'before',text:'Mira 的手机亮起。',message:'明早需要去车站接你吗？'}}]};
describe('story prop close-ups follow current presentation only',()=>{
 it('renders neither a permanent photo nor an inactive phone, and gives visible props clear ownership without fake buttons',()=>{
  const props={...INITIAL_PROPS,phone:'incoming' as const,message:'明早需要去车站接你吗？'};
  expect(renderToStaticMarkup(createElement(Narrative,{text:'',props}))).toBe('');
  const photograph=renderToStaticMarkup(createElement(Narrative,{text:'',props,focus:'photo'}));
  expect(photograph).toContain('Mira 的旅途照片');expect(photograph).not.toContain('Mira 的手机');
  expect(photograph).not.toMatch(/button|tabindex|09.{0,3}12|photo-table/);
  for(const phase of ['incoming','draft','sent'] as const){
   const html=renderToStaticMarkup(createElement(Narrative,{text:'',props:{...props,phone:phase},focus:'phone'}));
   expect(html).toContain('Mira 的手机');expect(html).toContain('明早需要去车站接你吗');
   expect(html).not.toMatch(/story-photograph|button|tabindex/);
  }
 });
 it('closes a completed prop on the next input or interruption while retaining the presented story data',async()=>{
  let calls=0;const plain:Reply={segments:[{text:'嗯，我在听。',emotion:'curious',action:'idle'}]};
  const engine=new ConversationEngine({turn:async r=>({...([photo,phone,plain][calls++]??plain),turnId:r.turnId,provider:'mock'}),cancel:async()=>{}},{play:async(_text,_signal,start)=>start(),stop(){}},crypto.randomUUID(),()=>0,()=>0);
  try{
   await engine.submit('看看照片');expect(engine.getSnapshot().propFocus).toBe('photo');
   const next=engine.submit('还给你');expect(engine.getSnapshot().propFocus).toBe('none');
   await next;expect(engine.getSnapshot().propFocus).toBe('phone');
   expect(engine.getSnapshot().stageProps.message).toContain('明早');
   engine.interrupt();expect(engine.getSnapshot().propFocus).toBe('none');
   expect(engine.getSnapshot().stageProps.phone).toBe('incoming');
   await engine.submit('聊点别的');expect(engine.getSnapshot().propFocus).toBe('none');
   engine.reset();expect(engine.getSnapshot()).toMatchObject({propFocus:'none',stageProps:INITIAL_PROPS});
  }finally{engine.dispose();}
 });
 it('does not revive a cancelled incoming message or leave its private cue visible',async()=>{
  const engine=new ConversationEngine({turn:async r=>({...phone,turnId:r.turnId,provider:'mock'}),cancel:async()=>{}},{play:async(_text,_signal,start)=>start(),stop(){}},crypto.randomUUID(),()=>0,()=>5000);
  const work=engine.submit('继续');await Promise.resolve();await Promise.resolve();
  expect(engine.getSnapshot().propFocus).toBe('phone');
  engine.interrupt();await work;
  expect(engine.getSnapshot()).toMatchObject({propFocus:'none',stageProps:INITIAL_PROPS,suggestions:[]});
  engine.reset();expect(engine.getSnapshot().propFocus).toBe('none');engine.dispose();
 });
});
