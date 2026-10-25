import { replySchema, type Reply, type TurnRequest } from '../shared/protocol';
export type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: string };
// Old browser tabs may still send plain sentence history. Never forward it as a
// non-JSON assistant example while requiring JSON output in the current turn.
function assistantSegments(content: string): Reply['segments'] {
  try {
    const parsed = replySchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data.segments : [];
  } catch {
    // Broken JSON is not dialogue; don't teach the model to repeat fragments.
    if (/[{}\[\]`]/.test(content) || /^["<]/.test(content.trim())) return [];
    const text = content.trim();
    if (!text) return [];
    return (text.match(/[\s\S]{1,180}/gu) ?? []).slice(-3).map(text => ({ text, emotion: 'guarded', action: 'idle' }));
  }
}
export function buildDialogueMessages(system: string, request: TurnRequest): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: 'system', content: system }];
  for (const entry of [...request.history, { role: 'user' as const, content: request.text }]) {
    if (entry.role === 'assistant') {
      const segments = assistantSegments(entry.content);
      if (!segments.length) continue;
      const previous = messages.at(-1);
      // Legacy clients used one assistant message per sentence; coalesce them.
      const prior = previous?.role === 'assistant' ? assistantSegments(previous.content) : [];
      const content = JSON.stringify({ segments: [...prior, ...segments].slice(-3) });
      if (previous?.role === 'assistant') previous.content = content;
      else messages.push({ role: 'assistant', content });
    } else {
      const previous = messages.at(-1);
      if (previous?.role === 'user') previous.content += '\n' + entry.content;
      else messages.push({ role: 'user', content: entry.content });
    }
  }
  return messages;
}
