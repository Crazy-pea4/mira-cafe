import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StoryTimeline } from '../src/StoryTimeline';
import type { StoryView } from '../shared/story';
const initial: StoryView = {
  act: 'invitation',
  facts: [],
  ending: null,
  planQuote: '',
  declined: false,
};
describe('presented story timeline', () => {
  it('shows the encounter without revealing the unseen message, concerns or ending', () => {
    const html = renderToStaticMarkup(<StoryTimeline />);
    expect(html).toContain('雨夜相遇');
    expect(html.match(/尚未展开/g)).toHaveLength(3);
    expect(html).not.toMatch(/旅馆|回信|委托|决定|两天/);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
  });
  it('moves only from authoritative presented facts, with the draft still awaiting a decision', () => {
    const photo = renderToStaticMarkup(
      <StoryTimeline story={{ ...initial, facts: ['arrival', 'photo-drift'] }} />,
    );
    expect(photo).toContain('一张照片');
    expect(photo).not.toContain('旅馆来信');
    const draft = renderToStaticMarkup(
      <StoryTimeline
        story={{
          ...initial,
          facts: ['arrival', 'photo-drift', 'phone-message', 'commission', 'draft'],
        }}
      />,
    );
    expect(draft).toContain('未发的回信');
    expect(draft).not.toContain('Mira 的决定');
  });
  it('handles the early refusal ending without inventing intermediate disclosures', () => {
    const html = renderToStaticMarkup(
      <StoryTimeline
        story={{
          ...initial,
          facts: ['arrival', 'photo-drift', 'phone-message', 'commission'],
          ending: 'c',
          act: 'ending',
        }}
      />,
    );
    expect(html).toContain('Mira 的决定');
    expect(html).toContain('雨好像小了');
    expect(html).not.toMatch(/坦诚出发|协商方案|两天|草稿原文/);
  });
});
