import { progressSchema, type SavedProgress } from '../shared/progress';
import { STORY_OPENING } from '../shared/story';
import { INITIAL_PROPS, OPENING_NARRATION, applyCue, locationAfterCue } from '../shared/stage';
import { storyView, type PendingStory, type StoryState } from './story';

// Only acknowledged presentation units enter this persisted view. No model drafts.
export function confirmedProgress(state: StoryState, checkpoint: string, pending: PendingStory, from: number, previous: SavedProgress | null): SavedProgress {
  const view: SavedProgress['view'] = previous ? structuredClone(previous.view) : {
    story: storyView(state), suggestions: [], narration: OPENING_NARRATION, subtitle: STORY_OPENING,
    emotion: 'guarded', scene: 'rain', location: 'cafe', photo: false, stageProps: { ...INITIAL_PROPS }, lastInput: '', completed: 0,
  };
  for (const unit of pending.units.slice(from, pending.through)) {
    const segment = pending.reply.segments[unit.segment];
    if (unit.kind === 'cue') {
      view.narration = unit.text; view.subtitle = '';
      view.stageProps = applyCue(view.stageProps, unit.cue);
      view.location = locationAfterCue(view.location, unit.cue);
      if (unit.cue.kind === 'reply-sent') view.scene = 'warm';
    } else {
      view.narration = ''; view.subtitle = unit.text; view.emotion = segment.emotion;
      if (segment.scene) view.scene = segment.scene;
      if (segment.event === 'reveal-photo') view.photo = true;
    }
  }
  view.story = storyView(state); view.suggestions = [...state.lastSuggestions]; view.lastInput = pending.input;
  if (from < pending.units.length && pending.through === pending.units.length) view.completed++;
  return progressSchema.parse({ version: 1, checkpoint, view });
}
