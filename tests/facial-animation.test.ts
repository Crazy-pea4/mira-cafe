import { describe,it,expect,vi,afterEach } from 'vitest';
import { FacialAnimation, type FaceFrame } from '../src/core/facial-animation';
import { characterSource,MIRA_ASSETS } from '../src/character-assets';
afterEach(()=>vi.useRealTimers());
describe('independent facial regions using a silent simulation clock',()=>{
 it('keeps the body source fixed while selecting three emotion states',()=>{
  expect(characterSource('guarded')).toBe(MIRA_ASSETS.neutral);
  expect(new Set(['guarded','curious','relieved'].map(e=>characterSource(e as any))).size).toBe(3);
  expect(MIRA_ASSETS.width/MIRA_ASSETS.height).toBe(2/3);
 });
 it('blinks independently without erasing an open mouth and closes on interruption',async()=>{
  vi.useFakeTimers();let frame:FaceFrame={blink:false,mouth:false};const face=new FacialAnimation(v=>{frame=v;});
  await vi.advanceTimersByTimeAsync(4150);face.speaking(true);expect(frame.mouth).toBe(true);
  await vi.advanceTimersByTimeAsync(50);expect(frame).toEqual({blink:true,mouth:true});
  face.speaking(false);expect(frame).toEqual({blink:true,mouth:false});
  await vi.advanceTimersByTimeAsync(150);expect(frame).toEqual({blink:false,mouth:false});face.dispose();
 });
 it('invalidates every old mouth callback during repeated interruption and disposal',async()=>{
  vi.useFakeTimers();const update=vi.fn();const face=new FacialAnimation(update);
  for(let i=0;i<10;i++){face.speaking(true);face.speaking(false);}const count=update.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000);expect(update).toHaveBeenCalledTimes(count);
  face.dispose();await vi.advanceTimersByTimeAsync(10000);expect(update).toHaveBeenCalledTimes(count);
 });
 it('does not simulate facial motion when reduced motion is requested',async()=>{
  vi.useFakeTimers();const update=vi.fn();const face=new FacialAnimation(update,true);face.speaking(true);await vi.advanceTimersByTimeAsync(10000);
  expect(update).toHaveBeenCalledExactlyOnceWith({blink:false,mouth:false});face.dispose();
 });
});
