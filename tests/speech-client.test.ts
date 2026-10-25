import { describe, it, expect, vi, afterEach } from 'vitest';
import { LocalSpeechTransport, type BrowserWire, type SpeechTransport } from '../src/core/speech-transport';
import { MicrophoneCapture, type CaptureFactory, type CaptureSession } from '../src/core/microphone';
import { VoiceInput } from '../src/core/voice-input';
const flush = async () => { for (let i=0; i<8; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value:T)=>void,reject!:(error:Error)=>void; const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; }
class Wire implements BrowserWire {
 readyState=0;bufferedAmount=0;sent: any[]=[];listeners:Record<string,((event:any)=>void)[]>={};
 addEventListener(type:string,fn:(event:any)=>void){(this.listeners[type]??=[]).push(fn);}
 send(data:string){this.sent.push(JSON.parse(data));}
 close(){this.readyState=3;this.emit('close',{});}
 emit(type:string,event:any){this.listeners[type]?.forEach(fn=>fn(event));}
 open(){this.readyState=1;this.emit('open',{});}
 event(fields:object){const first=this.sent[0];this.emit('message',{data:JSON.stringify({requestId:first.requestId,turnId:first.turnId,...fields})});}
}
function transportSetup(){const wires:Wire[]=[];const factory=vi.fn(()=>{const wire=new Wire();wires.push(wire);return wire;});return{wires,factory,transport:new LocalSpeechTransport(factory,()=> 'ws://test.local/api/speech')};}
afterEach(()=>vi.useRealTimers());
describe('browser speech transport using only fake sockets',()=>{
 it('tags ASR with identity, sends 16k PCM and accepts only matching transcript',async()=>{
  const {wires,transport}=transportSetup();const asr=transport.openAsr(7,new AbortController().signal);const w=wires[0];w.open();w.event({type:'ready'});await asr.ready;asr.append(new Uint8Array(8000));const result=asr.commit();
  expect(w.sent.map(e=>e.type)).toEqual(['asr.start','asr.audio','asr.commit']);expect(w.sent[1].sampleRate).toBe(16000);
  w.event({type:'transcript',turnId:6,text:'old'});w.event({type:'transcript',text:'现在'});w.event({type:'done'});await expect(result).resolves.toBe('现在');expect(w.readyState).toBe(3);
 });
 it('drops late and mismatched TTS audio after abort and allows a fresh attempt',async()=>{
  const {wires,transport}=transportSetup(),abort=new AbortController(),audio=vi.fn();
  const old=transport.synthesize('旧句',1,abort.signal,audio);wires[0].open();wires[0].event({type:'audio',turnId:2,audio:'AAAA',sampleRate:24000});expect(audio).not.toHaveBeenCalled();abort.abort();
  await expect(old).rejects.toMatchObject({name:'AbortError'});wires[0].event({type:'audio',audio:'AAAA',sampleRate:24000});expect(audio).not.toHaveBeenCalled();expect(wires[0].sent.at(-1).type).toBe('cancel');
  const current=transport.synthesize('新句',3,new AbortController().signal,audio);wires[1].open();wires[1].event({type:'audio',audio:'AAAAAA==',sampleRate:24000});wires[1].event({type:'done'});await current;expect(audio).toHaveBeenCalledTimes(1);
 });
 it('rejects empty recognition and unexpected disconnects',async()=>{
  const {wires,transport}=transportSetup();const asr=transport.openAsr(1,new AbortController().signal);wires[0].open();wires[0].event({type:'ready'});await asr.ready;const work=asr.commit();wires[0].event({type:'done'});await expect(work).rejects.toThrow('没有识别');
  const next=transport.openAsr(2,new AbortController().signal);wires[1].close();await expect(next.ready).rejects.toThrow('连接中断');
 });
 it('does not accept punctuation-only recognition from the local proxy',async()=>{
  const {wires,transport}=transportSetup();const asr=transport.openAsr(1,new AbortController().signal);
  wires[0].open();wires[0].event({type:'ready'});await asr.ready;const work=asr.commit();
  wires[0].event({type:'transcript',text:'……？！'});wires[0].event({type:'done'});
  await expect(work).rejects.toThrow('没有识别');expect(wires[0].readyState).toBe(3);
 });
 it('bounds the response wait and never opens for an already cancelled request',async()=>{
  vi.useFakeTimers();const {wires,transport,factory}=transportSetup();const asr=transport.openAsr(1,new AbortController().signal);const failure=expect(asr.ready).rejects.toThrow('超时');await vi.advanceTimersByTimeAsync(45000);await failure;expect(wires[0].readyState).toBe(3);
  const abort=new AbortController();abort.abort();await expect(transport.openAsr(2,abort.signal).ready).rejects.toMatchObject({name:'AbortError'});expect(factory).toHaveBeenCalledTimes(1);
 });
});
describe('microphone and press-to-talk lifecycle without devices',()=>{
 function setup(){
  const captures:{frame:(pcm:Uint8Array)=>void;signal:AbortSignal;session:CaptureSession}[]=[];
  const captureFactory:CaptureFactory=async(frame,signal)=>{const session={finish:vi.fn(async()=>{}),cancel:vi.fn()};captures.push({frame,signal,session});return session;};
  const operations:{signal:AbortSignal;frames:Uint8Array[];result:ReturnType<typeof deferred<string>>;commit:ReturnType<typeof vi.fn>}[]=[];
  const transport:SpeechTransport={openAsr:(_turn,signal)=>{const result=deferred<string>(),frames:Uint8Array[]=[];const commit=vi.fn(()=>result.promise);operations.push({signal,result,frames,commit});return{ready:Promise.resolve(),append:pcm=>frames.push(pcm),commit};},synthesize:async()=>{}};
  const callbacks={text:vi.fn(),error:vi.fn(),state:vi.fn()};
  return{captures,operations,callbacks,voice:new VoiceInput(transport,new MicrophoneCapture(captureFactory))};
 }
 it('stops a capture whose permission result arrives after cancellation',async()=>{
  const pending=deferred<CaptureSession>(),frame=vi.fn(),cancel=vi.fn();let lateFrame!:(pcm:Uint8Array)=>void;
  const capture=new MicrophoneCapture(async callback=>{lateFrame=callback;return pending.promise;});
  const work=capture.start(frame,new AbortController().signal);capture.cancel();lateFrame(new Uint8Array(8000));pending.resolve({cancel,finish:async()=>{}});
  await expect(work).rejects.toMatchObject({name:'AbortError'});expect(cancel).toHaveBeenCalledOnce();expect(frame).not.toHaveBeenCalled();
 });
 it('flushes recording, submits once and releases the device before returning text',async()=>{
  const {voice,captures,operations,callbacks}=setup();await voice.start(1,callbacks);captures[0].frame(new Uint8Array(8000));const work=voice.finish();await flush();
  expect(captures[0].session.finish).toHaveBeenCalledOnce();expect(operations[0].commit).toHaveBeenCalledOnce();operations[0].result.resolve('你好');await work;
  expect(callbacks.text).toHaveBeenCalledWith('你好');expect(operations[0].signal.aborted).toBe(true);
 });
 it('rejects short or empty speech, then permits a successful retry',async()=>{
  const {voice,captures,operations,callbacks}=setup();
  await voice.start(1,callbacks);captures[0].frame(new Uint8Array(10));await voice.finish();expect(operations[0].commit).not.toHaveBeenCalled();expect(callbacks.error).toHaveBeenLastCalledWith(expect.stringContaining('太短'));
  await voice.start(2,callbacks);captures[1].frame(new Uint8Array(8000));const empty=voice.finish();await flush();operations[1].result.resolve(' ');await empty;expect(callbacks.error).toHaveBeenLastCalledWith(expect.stringContaining('没有识别'));
  await voice.start(3,callbacks);captures[2].frame(new Uint8Array(8000));const success=voice.finish();await flush();operations[2].result.resolve('重试');await success;expect(callbacks.text).toHaveBeenCalledExactlyOnceWith('重试');
 });
 it('continuous replacement cancels old recording and ignores late transcripts and frames',async()=>{
  const {voice,captures,operations,callbacks}=setup();
  await voice.start(1,callbacks);captures[0].frame(new Uint8Array(8000));const old=voice.finish();await flush();
  await voice.start(2,callbacks);expect(operations[0].signal.aborted).toBe(true);captures[0].frame(new Uint8Array(8000));operations[0].result.resolve('旧内容');await old;expect(callbacks.text).not.toHaveBeenCalled();expect(operations[0].frames).toHaveLength(1);
  voice.cancel();expect(captures[1].session.cancel).toHaveBeenCalledOnce();expect(operations[1].signal.aborted).toBe(true);
 });
 it('stops and reports recording overflow without committing it',async()=>{
  const {voice,captures,operations,callbacks}=setup();await voice.start(1,callbacks);captures[0].frame(new Uint8Array(960002));expect(callbacks.error).toHaveBeenCalledWith(expect.stringContaining('30 秒'));expect(captures[0].session.cancel).toHaveBeenCalledOnce();expect(operations[0].commit).not.toHaveBeenCalled();
 });
 it('bounds microphone initialization and cleans up a late device after timeout',async()=>{
  vi.useFakeTimers();const pending=deferred<CaptureSession>(),session={finish:vi.fn(async()=>{}),cancel:vi.fn()},openAsr=vi.fn();
  const voice=new VoiceInput({openAsr,synthesize:async()=>{}},new MicrophoneCapture(async()=>pending.promise));
  const callbacks={text:vi.fn(),error:vi.fn(),state:vi.fn()};const work=voice.start(1,callbacks);
  await vi.advanceTimersByTimeAsync(8000);expect(callbacks.error).toHaveBeenCalledWith(expect.stringContaining('初始化超时'));
  pending.resolve(session);await work;expect(session.cancel).toHaveBeenCalledOnce();expect(openAsr).not.toHaveBeenCalled();
 });
 it('releasing while setup is pending cancels the eventual device without opening ASR',async()=>{
  const pending=deferred<CaptureSession>(),session={finish:vi.fn(async()=>{}),cancel:vi.fn()},openAsr=vi.fn();
  const voice=new VoiceInput({openAsr,synthesize:async()=>{}},new MicrophoneCapture(async()=>pending.promise));const callbacks={text:vi.fn(),error:vi.fn(),state:vi.fn()};
  const work=voice.start(1,callbacks);await voice.finish();pending.resolve(session);await work;expect(openAsr).not.toHaveBeenCalled();expect(session.cancel).toHaveBeenCalledOnce();expect(callbacks.error).toHaveBeenCalledOnce();
 });
});
