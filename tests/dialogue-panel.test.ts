import {describe,it,expect,vi} from 'vitest';
import {DialoguePanel} from '../src/core/dialogue-panel';
import {VoiceEntry} from '../src/core/voice-entry';
import {ConversationEngine} from '../src/core/engine';
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
describe('folding the dialogue HUD without resetting its conversation',()=>{
 it('keeps an active reply playing, exposes the latest subtitle on restore, and makes no extra requests',async()=>{
  const played:ReturnType<typeof deferred>[]=[],stop=vi.fn();
  const turn=vi.fn(async r=>({turnId:r.turnId,provider:'mock' as const,segments:[{text:'第一句。第二句。',emotion:'curious' as const,action:'idle' as const}],suggestions:['说说照片吧。','继续慢慢说。','我们聊点别的。']}));
  const engine=new ConversationEngine({turn,cancel:async()=>{}},{stop,play:async(_text,_signal,start)=>{start();const pending=deferred();played.push(pending);await pending.promise;}});
  const voice={start:vi.fn(),finish:vi.fn(),cancel:vi.fn()},entry=new VoiceEntry(voice,async()=>{});
  const panel=new DialoguePanel(()=>entry.suspend()),work=engine.submit('你好');
  await flush();const current=engine.getSnapshot(),stops=stop.mock.calls.length;
  panel.toggle();expect(panel.getSnapshot()).toBe(true);expect(engine.getSnapshot()).toBe(current);
  played[0].resolve();await flush();expect(engine.getSnapshot().subtitle).toBe('第二句。');
  panel.toggle();expect(engine.getSnapshot().subtitle).toBe('第二句。');
  played[1].resolve();await work;const completed=engine.getSnapshot();
  for(let i=0;i<8;i++)panel.toggle();
  expect(panel.getSnapshot()).toBe(false);expect(engine.getSnapshot()).toBe(completed);
  expect(turn).toHaveBeenCalledOnce();expect(played).toHaveLength(2);expect(stop).toHaveBeenCalledTimes(stops);
  expect(voice.cancel).not.toHaveBeenCalled();engine.dispose();
 });
 it('cancels held fake microphone capture before hiding, ignoring late recognition and release',async()=>{
  let callbacks:any;const voice={start:vi.fn(async(_turn,cb)=>{callbacks=cb;cb.phase('recording');}),finish:vi.fn(),cancel:vi.fn()};
  const entry=new VoiceEntry(voice,async()=>{}),text=vi.fn(),mock=vi.fn(),end=vi.fn();
  entry.configure(true,true);await entry.prepare(vi.fn());
  entry.press({begin:()=>3,text,mock,notice:vi.fn(),end});await flush();
  expect(entry.getSnapshot().phase).toBe('recording');
  const prior=voice.cancel.mock.calls.length,panel=new DialoguePanel(()=>entry.suspend());
  panel.toggle();
  expect(entry.getSnapshot()).toMatchObject({held:false,phase:'idle'});
  expect(voice.cancel).toHaveBeenCalledTimes(prior+1);expect(end).toHaveBeenCalledOnce();
  callbacks.text('迟到的识别');entry.release();panel.toggle();
  expect(text).not.toHaveBeenCalled();expect(mock).not.toHaveBeenCalled();expect(voice.finish).not.toHaveBeenCalled();
 });
 it('does not start a hidden microphone after a pending permission response',async()=>{
  const permission=deferred(),voice={start:vi.fn(),finish:vi.fn(),cancel:vi.fn()},notice=vi.fn();
  const entry=new VoiceEntry(voice,()=>permission.promise),panel=new DialoguePanel(()=>entry.suspend());
  entry.configure(true,true);const pending=entry.prepare(notice);panel.toggle();permission.resolve();await pending;panel.toggle();
  expect(entry.getSnapshot().permission).toBe('needed');expect(notice).not.toHaveBeenCalled();expect(voice.start).not.toHaveBeenCalled();
 });
 it('notifies view subscribers once per toggle and cleans up subscriptions',()=>{
  const panel=new DialoguePanel(vi.fn()),listener=vi.fn(),unbind=panel.subscribe(listener);
  panel.toggle();panel.toggle();expect(listener).toHaveBeenCalledTimes(2);unbind();panel.toggle();expect(listener).toHaveBeenCalledTimes(2);
 });
});
