import { describe, it, expect, vi, afterEach } from 'vitest';
import { Pcm16Resampler, decodePcm16 } from '../shared/pcm';
import { PcmPlaybackQueue, type PlaybackClock } from '../src/core/pcm-playback';
import { SceneAudio } from '../src/core/scene-audio';
function concat(chunks: Uint8Array[]) { const result = new Uint8Array(chunks.reduce((n,c) => n+c.length,0)); let at=0; for(const c of chunks){result.set(c,at);at+=c.length;} return result; }
function signal(rate: number, hz: number) { return Float32Array.from({length:rate}, (_,i) => .7*Math.sin(2*Math.PI*hz*i/rate)); }
function convert(data: Float32Array, rate: number, size: number) { const r=new Pcm16Resampler(rate); const output:Uint8Array[]=[]; for(let i=0;i<data.length;i+=size)output.push(r.push(data.subarray(i,i+size)));output.push(r.flush());return concat(output); }
afterEach(() => {vi.useRealTimers();vi.unstubAllGlobals();});
describe('pure PCM processing; no audio devices', () => {
  it.each([44100,48000])('resamples %i Hz to exactly 16000 samples, independent of blocks', rate => {
    const input=signal(rate,1000),a=convert(input,rate,1024),b=convert(input,rate,137);
    expect(a.length).toBe(32000);expect(b).toEqual(a);
  });
  it('attenuates frequencies above the new Nyquist limit', () => {
    const low=decodePcm16(convert(signal(48000,1000),48000,1024)),high=decodePcm16(convert(signal(48000,12000),48000,1024));
    const rms=(a:Float32Array)=>Math.sqrt(a.slice(50,-50).reduce((sum,v)=>sum+v*v,0)/(a.length-100));
    expect(rms(low)).toBeGreaterThan(.4);expect(rms(high)).toBeLessThan(.08);
  });
  it('uses signed little-endian PCM and rejects odd byte lengths', () => {
    expect([...decodePcm16(Uint8Array.from([0,128,255,127,0,0]))]).toEqual([-1,32767/32768,0]);
    expect(()=>decodePcm16(new Uint8Array(3))).toThrow();
  });
});
describe('playback-clock scheduling', () => {
  function setup() {
    let time=0,running=true;const nodes:{at:number;samples:Float32Array;ended:()=>void;stop:ReturnType<typeof vi.fn>}[]=[];
    const clock:PlaybackClock={now:()=>time,running:()=>running,schedule:(samples,at,ended)=>{const n={samples,at,ended,stop:vi.fn()};nodes.push(n);return n;}};
    return{clock,nodes,setTime:(v:number)=>time=v,setRunning:(v:boolean)=>running=v};
  }
  it('starts visuals at actual audio time, never network arrival or a suspended wall clock', async () => {
    vi.useFakeTimers();const {clock,nodes,setTime,setRunning}=setup();const start=vi.fn(),abort=new AbortController(),q=new PcmPlaybackQueue(clock,abort.signal,start);
    q.enqueue(new Uint8Array(4800));q.end();setRunning(false);await vi.advanceTimersByTimeAsync(1000);expect(start).not.toHaveBeenCalled();
    setRunning(true);setTime(.039);await vi.advanceTimersByTimeAsync(10);expect(start).not.toHaveBeenCalled();
    setTime(.04);await vi.advanceTimersByTimeAsync(10);expect(start).toHaveBeenCalledTimes(1);
    setTime(.14);nodes[0].ended();await q.done;
  });
  it('schedules contiguous PCM and stops every queued node on interruption', async () => {
    vi.useFakeTimers();const {clock,nodes,setTime}=setup();const start=vi.fn(),abort=new AbortController(),q=new PcmPlaybackQueue(clock,abort.signal,start);
    q.enqueue(new Uint8Array(4800));q.enqueue(new Uint8Array(4800));expect(nodes[1].at).toBeCloseTo(nodes[0].at+.1);
    abort.abort();await expect(q.done).rejects.toMatchObject({name:'AbortError'});expect(nodes.every(n=>n.stop.mock.calls.length===1)).toBe(true);
    setTime(20);nodes.forEach(n=>n.ended());await vi.advanceTimersByTimeAsync(100);q.enqueue(new Uint8Array(4800));expect(nodes).toHaveLength(2);expect(start).not.toHaveBeenCalled();
  });
  it('does not create audio hardware or a socket when muted, including Qwen mode', async () => {
    const context=vi.fn(()=>{throw new Error('hardware used');}),socket=vi.fn(()=>{throw new Error('network used');});
    vi.stubGlobal('AudioContext',context);vi.stubGlobal('WebSocket',socket);
    const audio=new SceneAudio();audio.live=true;
    await expect(audio.play('不播放。',new AbortController().signal,vi.fn(),{turnId:1})).rejects.toThrow();
    expect(context).not.toHaveBeenCalled();expect(socket).not.toHaveBeenCalled();
  });
});
