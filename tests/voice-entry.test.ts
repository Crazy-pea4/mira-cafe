import { describe,it,expect,vi } from 'vitest';
import { VoiceEntry } from '../src/core/voice-entry';
import { VoiceInput } from '../src/core/voice-input';
import { MicrophoneCapture } from '../src/core/microphone';
import type { SpeechTransport } from '../src/core/speech-transport';
import { voiceButtonView } from '../src/VoiceButton';
function deferred<T>() { let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject}; }
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function setup() {
  const permission=deferred<void>(),requestPermission=vi.fn(()=>permission.promise);
  const captures:{frame:(pcm:Uint8Array)=>void;finish:ReturnType<typeof vi.fn>;cancel:ReturnType<typeof vi.fn>}[]=[];
  const capture=new MicrophoneCapture(async frame=>{const session={frame,finish:vi.fn(async()=>{}),cancel:vi.fn()};captures.push(session);return session;});
  const sessions:{signal:AbortSignal;ready:ReturnType<typeof deferred<void>>;result:ReturnType<typeof deferred<string>>;append:ReturnType<typeof vi.fn>;commit:ReturnType<typeof vi.fn>}[]=[];
  const openAsr=vi.fn((_turn:number,signal:AbortSignal)=>{
    const ready=deferred<void>(),result=deferred<string>(),append=vi.fn(),commit=vi.fn(()=>result.promise);
    sessions.push({signal,ready,result,append,commit});return{ready:ready.promise,append,commit};
  });
  const transport:SpeechTransport={openAsr,synthesize:vi.fn()};
  const voice=new VoiceInput(transport,capture);const entry=new VoiceEntry(voice,requestPermission);
  const callbacks={begin:vi.fn(()=>1),text:vi.fn(),mock:vi.fn(),notice:vi.fn(),end:vi.fn()};
  return{entry,permission,requestPermission,captures,sessions,openAsr,callbacks};
}
describe('visible voice entry with fake permission, capture and ASR only',()=>{
 it('selects real speech from health, separates permission from holding, and survives permission-popup blur',async()=>{
  const s=setup();expect(voiceButtonView(s.entry.getSnapshot()).disabled).toBe(true);
  s.entry.configure(true,true);expect(voiceButtonView(s.entry.getSnapshot()).label).toBe('启用麦克风');
  s.entry.press(s.callbacks);s.entry.release();expect(s.captures).toHaveLength(0);
  const preparation=s.entry.prepare(s.callbacks.notice);s.entry.blur();s.entry.release();
  expect(s.openAsr).not.toHaveBeenCalled();expect(s.entry.getSnapshot().permission).toBe('pending');
  s.permission.resolve();await preparation;
  expect(voiceButtonView(s.entry.getSnapshot()).label).toBe('按住说话');expect(s.callbacks.notice).toHaveBeenCalledWith(expect.stringContaining('现在按住'));
  expect(s.openAsr).not.toHaveBeenCalled();expect(s.captures).toHaveLength(0);
  s.entry.cancel();
 });
 it('stops capturing on release but preserves recorded PCM until the delayed WebSocket becomes ready',async()=>{
  const s=setup();s.entry.configure(true,true);s.permission.resolve();await s.entry.prepare(s.callbacks.notice);
  s.entry.press(s.callbacks);await flush();s.captures[0].frame(new Uint8Array(8000));
  expect(voiceButtonView(s.entry.getSnapshot()).label).toBe('松开识别');
  s.entry.release();s.entry.cancelHeld();await flush();
  expect(s.captures[0].finish).toHaveBeenCalledOnce();expect(s.sessions[0].commit).not.toHaveBeenCalled();
  expect(s.sessions[0].signal.aborted).toBe(false);expect(voiceButtonView(s.entry.getSnapshot()).label).toBe('识别中…');
  s.sessions[0].ready.resolve();await flush();
  expect(s.sessions[0].append).toHaveBeenCalledOnce();expect(s.sessions[0].commit).toHaveBeenCalledOnce();
  s.sessions[0].result.resolve('我想喝咖啡');await flush();
  expect(s.callbacks.text).toHaveBeenCalledExactlyOnceWith('我想喝咖啡');
  expect(voiceButtonView(s.entry.getSnapshot()).label).toBe('按住说话');s.entry.cancel();
 });
 it('rejects a short press without committing even if the socket was still connecting',async()=>{
  const s=setup();s.entry.configure(true,true);s.permission.resolve();await s.entry.prepare(s.callbacks.notice);
  s.entry.press(s.callbacks);await flush();s.captures[0].frame(new Uint8Array(400));s.entry.release();await flush();
  expect(s.callbacks.notice).toHaveBeenLastCalledWith(expect.stringContaining('太短'));
  expect(s.sessions[0].commit).not.toHaveBeenCalled();expect(s.sessions[0].signal.aborted).toBe(true);
  s.sessions[0].ready.resolve();await flush();expect(s.sessions[0].append).not.toHaveBeenCalled();expect(s.callbacks.mock).not.toHaveBeenCalled();s.entry.cancel();
 });
 it('allows retrying permission denial without opening a provider or silently switching to mock',async()=>{
  const s=setup();s.entry.configure(true,true);
  const preparation=s.entry.prepare(s.callbacks.notice);s.permission.reject(new Error('麦克风权限未开启'));await preparation;
  expect(s.entry.getSnapshot()).toMatchObject({mode:'live',permission:'needed'});expect(s.openAsr).not.toHaveBeenCalled();
  expect(s.callbacks.notice).toHaveBeenCalledWith('麦克风权限未开启');s.entry.cancel();
 });
 it('does not enable a late permission result after the user selects another mode',async()=>{
  const s=setup();s.entry.configure(true,true);const work=s.entry.prepare(s.callbacks.notice);
  s.entry.select('mock');s.permission.resolve();await work;
  expect(s.entry.getSnapshot()).toMatchObject({mode:'mock',permission:'needed'});expect(s.callbacks.notice).not.toHaveBeenCalled();s.entry.cancel();
 });
 it('does not silently substitute mock when configured speech is blocked or status is unavailable',()=>{
  const s=setup();s.entry.configure(false,true,'预算已到上限');s.entry.press(s.callbacks);s.entry.release();
  expect(s.entry.getSnapshot().mode).toBe('live');expect(voiceButtonView(s.entry.getSnapshot()).disabled).toBe(true);
  expect(s.callbacks.mock).not.toHaveBeenCalled();expect(s.entry.getSnapshot().message).toContain('预算');
  s.entry.unavailable();expect(s.entry.getSnapshot().mode).toBe('live');expect(s.captures).toHaveLength(0);s.entry.cancel();
 });
 it('allows only an explicitly selected demo in a real-configured app, with no microphone',()=>{
  const s=setup();s.entry.configure(true,true);s.entry.select('mock');s.entry.press(s.callbacks);s.entry.release();
  expect(s.callbacks.mock).toHaveBeenCalledOnce();expect(s.requestPermission).not.toHaveBeenCalled();expect(s.openAsr).not.toHaveBeenCalled();
  expect(voiceButtonView(s.entry.getSnapshot()).detail).toBe('不识别讲话');s.entry.cancel();
 });
 it('drops recognition after focus loss and after a newer recording replaces it',async()=>{
  const s=setup();s.entry.configure(true,true);s.permission.resolve();await s.entry.prepare(s.callbacks.notice);
  s.entry.press(s.callbacks);await flush();s.captures[0].frame(new Uint8Array(8000));s.sessions[0].ready.resolve();await flush();s.entry.release();await flush();
  s.entry.blur();expect(s.sessions[0].signal.aborted).toBe(true);s.sessions[0].result.resolve('旧话');await flush();expect(s.callbacks.text).not.toHaveBeenCalled();
  s.entry.press(s.callbacks);await flush();s.captures[1].frame(new Uint8Array(8000));s.sessions[1].ready.resolve();await flush();s.entry.release();await flush();s.sessions[1].result.resolve('新话');await flush();
  expect(s.callbacks.text).toHaveBeenCalledExactlyOnceWith('新话');s.entry.cancel();
 });
});
