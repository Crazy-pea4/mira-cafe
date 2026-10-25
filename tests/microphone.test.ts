import { describe,it,expect,vi,afterEach } from 'vitest';
import { openMicrophone, prepareMicrophone } from '../src/core/microphone';
afterEach(()=>vi.unstubAllGlobals());
describe('browser microphone adapter with fully fake hardware',()=>{
 it('stops tracks when a permission result arrives after cancellation',async()=>{
  let release!:(stream:MediaStream)=>void;const stop=vi.fn(),close=vi.fn(async()=>{}),getUserMedia=vi.fn(()=>new Promise<MediaStream>(resolve=>{release=resolve;}));
  vi.stubGlobal('window',{isSecureContext:true});vi.stubGlobal('navigator',{mediaDevices:{getUserMedia}});
  vi.stubGlobal('AudioContext',class {resume=async()=>{};close=close;});
  const abort=new AbortController();const work=openMicrophone(vi.fn(),abort.signal);abort.abort();release({getTracks:()=>[{stop}]} as unknown as MediaStream);
  await expect(work).rejects.toMatchObject({name:'AbortError'});expect(stop).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
 });
 it('processes synthetic 48k frames, outputs a zero gain path and stops every track on finish',async()=>{
  const stop=vi.fn(),close=vi.fn(async()=>{}),gain={gain:{value:1},connect:vi.fn(),disconnect:vi.fn()},source={connect:vi.fn(),disconnect:vi.fn()};
  let node:any;class FakeWorklet {port={onmessage:undefined as any,postMessage:()=>this.port.onmessage({data:{finished:true}})};connect=vi.fn();disconnect=vi.fn();constructor(){node=this;}}
  vi.stubGlobal('window',{isSecureContext:true});vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:vi.fn(async()=>({getTracks:()=>[{stop}]}))}});
  vi.stubGlobal('AudioWorkletNode',FakeWorklet);
  vi.stubGlobal('AudioContext',class{sampleRate=48000;destination={};resume=async()=>{};close=close;audioWorklet={addModule:vi.fn(async()=>{})};createMediaStreamSource=()=>source;createGain=()=>gain;});
  const frames:Uint8Array[]=[];const session=await openMicrophone(pcm=>frames.push(pcm),new AbortController().signal);
  node.port.onmessage({data:{samples:new Float32Array(48000)}});await session.finish();
  expect(gain.gain.value).toBe(0);expect(frames.reduce((n,c)=>n+c.length,0)).toBe(32000);expect(stop).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();expect(node.port.onmessage).toBeNull();
 });
});

describe('permission preparation with fake devices',()=>{
 it('requests permission only on explicit preparation and immediately stops every probe track',async()=>{
  const stop1=vi.fn(),stop2=vi.fn(),getUserMedia=vi.fn(async()=>({getTracks:()=>[{stop:stop1},{stop:stop2}]}));
  vi.stubGlobal('window',{isSecureContext:true});vi.stubGlobal('navigator',{mediaDevices:{getUserMedia}});
  const audio=vi.fn();vi.stubGlobal('AudioContext',audio);
  expect(getUserMedia).not.toHaveBeenCalled();await prepareMicrophone();
  expect(stop1).toHaveBeenCalledOnce();expect(stop2).toHaveBeenCalledOnce();expect(audio).not.toHaveBeenCalled();
 });
 it('reports denied permission clearly without creating an audio context',async()=>{
  vi.stubGlobal('window',{isSecureContext:true});vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:vi.fn(async()=>{throw new DOMException('denied','NotAllowedError');})}});
  await expect(prepareMicrophone()).rejects.toThrow('麦克风权限未开启');
 });
 it('cleans up fake tracks and context when worklet loading fails',async()=>{
  const stop=vi.fn(),close=vi.fn(async()=>{});
  vi.stubGlobal('window',{isSecureContext:true});vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:vi.fn(async()=>({getTracks:()=>[{stop}]}))}});
  vi.stubGlobal('AudioContext',class{state='running';resume=async()=>{};close=close;audioWorklet={addModule:vi.fn(async()=>{throw new Error('load failed');})};});
  await expect(openMicrophone(vi.fn(),new AbortController().signal)).rejects.toThrow('麦克风暂时不可用');
  expect(stop).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
 });
});
