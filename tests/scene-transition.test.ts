import { describe, expect, it, vi } from 'vitest';
import { ConversationEngine } from '../src/core/engine';
import { newStory, prepareStory, acknowledgeStory } from '../server/story';
import { directStory } from '../server/stage-director';
import type { Reply, TurnRequest } from '../shared/protocol';

const commission: Reply = {
  segments: [{
    text: '这是我第一份有偿摄影委托。明早七点去照片里的小旅馆。',
    emotion: 'guarded',
    action: 'hesitant',
    beat: 'commission',
  }],
  story: { intent: 'engage' },
};
const request: TurnRequest = {
  sessionId: crypto.randomUUID(), turnId: 1, text: '是什么委托？', history: [], fault: 'none',
};
function atMessage() {
  const state = newStory();
  state.facts = ['arrival', 'photo-drift', 'phone-message'];
  return state;
}
function lodgeReply() {
  return directStory(atMessage(), commission);
}

describe('story-driven photograph scene', () => {
  it('enters the photograph only at an eligible commission, acknowledges it once and does not reveal the commission early', () => {
    expect(directStory(newStory(), commission).segments[0].cue).toBeUndefined();
    const state = atMessage();
    const pending = prepareStory(state, request, commission);
    expect(pending.units[0]).toMatchObject({ kind: 'cue', cue: { kind: 'lodge-view' } });
    expect(state.cues['lodge-view']).toBeUndefined();
    acknowledgeStory(state, pending, 1);
    expect(state.cues['lodge-view']?.text).toContain('仿佛');
    expect(state.facts).not.toContain('commission');
    acknowledgeStory(state, pending, pending.units.length);
    expect(state.facts).toContain('commission');
    expect(directStory(state, commission).segments[0].cue).toBeUndefined();
  });

  it('rolls back an interrupted entrance and never speaks or acknowledges its unfinished narration', async () => {
    const play = vi.fn(async (_text: string, _signal: AbortSignal, start: () => void) => start());
    const presented = vi.fn();
    const engine = new ConversationEngine({
      turn: async (r) => ({ ...lodgeReply(), turnId: r.turnId, provider: 'mock' }),
      cancel: async () => {},
      presented,
    }, { play, stop() {} }, undefined, () => 0, () => 5000);
    try {
      const pending = engine.submit('说说这家旅馆');
      await vi.waitFor(() => expect(engine.getSnapshot().location).toBe('lodge'));
      expect(engine.getSnapshot()).toMatchObject({ status: 'narrating', propFocus: 'none' });
      engine.interrupt(true);
      await pending;
      expect(engine.getSnapshot()).toMatchObject({ location: 'cafe', status: 'listening' });
      expect(play).not.toHaveBeenCalled();
      expect(presented).not.toHaveBeenCalled();
    } finally {
      engine.dispose();
    }
  });

  it('keeps a completed visit across input, rolls back an unfinished return, and resets to the cafe', async () => {
    let reply = lodgeReply();
    let narrationMs = 0;
    const engine = new ConversationEngine({
      turn: async (r) => ({ ...reply, turnId: r.turnId, provider: 'mock' }),
      cancel: async () => {},
    }, { async play(_text, _signal, start) { start(); }, stop() {} }, undefined, () => 0, () => narrationMs);
    try {
      await engine.submit('是什么委托');
      expect(engine.getSnapshot().location).toBe('lodge');
      engine.interrupt();
      expect(engine.getSnapshot().location).toBe('lodge');
      reply = { segments: [{
        text: '这就是我的草稿。', emotion: 'guarded', action: 'hesitant',
        cue: { kind: 'draft', placement: 'before', text: '照片里的山色渐远，杯碟声把你们拉回咖啡馆。' },
      }] };
      narrationMs = 5000;
      const pending = engine.submit('看看草稿');
      await vi.waitFor(() => expect(engine.getSnapshot().location).toBe('cafe'));
      engine.interrupt();
      await pending;
      expect(engine.getSnapshot().location).toBe('lodge');
      narrationMs = 0;
      await engine.submit('看看草稿');
      expect(engine.getSnapshot().location).toBe('cafe');
      engine.reset();
      expect(engine.getSnapshot()).toMatchObject({ location: 'cafe', scene: 'rain' });
    } finally {
      engine.dispose();
    }
  });

  it.each(['practice', 'draft', 'ending-c'] as const)('returns from the photograph through %s without replaying the visit', (beat) => {
    const state = atMessage();
    state.cues['lodge-view'] = lodgeReply().segments[0].cue!;
    state.facts.push('commission');
    const response = directStory(state, {
      segments: [{ text: '我们慢慢来。', emotion: 'curious', action: 'idle', beat }],
    });
    const cue = response.segments.find((segment) => segment.cue)?.cue;
    expect(cue?.text).toContain('你们仍坐在雨夜的咖啡馆');
    expect(cue?.kind).not.toBe('lodge-view');
  });
});
