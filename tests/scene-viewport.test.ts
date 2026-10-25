import { describe, expect, it } from 'vitest';
import { bindSceneViewport } from '../src/core/scene-viewport';

describe('scene visual viewport', () => {
  it('follows keyboard height and viewport panning, then removes listeners', () => {
    const viewport = Object.assign(new EventTarget(), { height:844, offsetTop:0 });
    const target = Object.assign(new EventTarget(), { innerHeight:844, visualViewport:viewport });
    const values = new Map<string,string>();
    const style = { setProperty:(name:string,value:string|null) => { values.set(name,value ?? ''); }, removeProperty:(name:string) => { values.delete(name); return ''; } };
    const unbind = bindSceneViewport(target, style);
    expect(values.get('--scene-height')).toBe('844px');
    viewport.height=410; viewport.offsetTop=27;
    viewport.dispatchEvent(new Event('resize'));
    expect(values.get('--scene-height')).toBe('410px');
    expect(values.get('--scene-top')).toBe('27px');
    unbind(); viewport.dispatchEvent(new Event('scroll'));
    expect(values.size).toBe(0);
  });
  it('falls back to the window when VisualViewport is unavailable', () => {
    const target = Object.assign(new EventTarget(), { innerHeight:720, visualViewport:null });
    const values = new Map<string,string>();
    const unbind = bindSceneViewport(target, { setProperty:(name,value)=>{values.set(name,value ?? '');},removeProperty:name=>{values.delete(name);return '';} });
    target.innerHeight=480; target.dispatchEvent(new Event('resize'));
    expect(values.get('--scene-height')).toBe('480px');
    expect(values.get('--scene-top')).toBe('0px');
    unbind();
  });
});
