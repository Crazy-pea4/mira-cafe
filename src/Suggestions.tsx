import type { StoryView } from '../shared/story';
import { progressTarget } from '../shared/story-progression';
export function Suggestions({
  values,
  onChoose,
  story = { act: 'invitation', facts: [], ending: null, planQuote: '', declined: false },
}: {
  values: readonly string[];
  onChoose: (text: string) => void;
  story?: StoryView;
}) {
  if (!values.length) return null;
  return (
    <div className="suggestions" aria-label="可选的下一句回应">
      {values.map((value, index) => {
        const advances = !!progressTarget(story, value);
        return (
          <button
            type="button"
            key={value}
            aria-label={'建议回应：' + value}
            className={advances ? 'story-progress' : undefined}
            data-story-progress={advances || undefined}
            aria-description={advances ? '继续她的故事' : undefined}
            title={advances ? '继续她的故事' : undefined}
            onClick={() => onChoose(value)}
          >
            <span>{advances ? '✦' : `0${index + 1}`}</span>
            {value}
            <b>↗</b>
          </button>
        );
      })}
    </div>
  );
}
