import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
export const replyIssueSchema = z.enum(['bad-envelope','invalid-json','empty-text','truncated','incomplete','filtered','too-long','fenced','wrapped','extra-fields','missing-directive','invalid-directive','empty-segment','split-text','plain-text']);
export type ReplyIssue = z.infer<typeof replyIssueSchema>;
const schema = z.object({
  event: z.literal('reply-format'), outcome: z.enum(['rejected','normalized','text-only']),
  finishReason: z.enum(['stop','length','content_filter','tool_calls','insufficient_system_resource','aborted','missing','other']),
  contentLength: z.number().int().min(0).max(12001),
  contentType: z.enum(['string','object','array','null','missing','other']),
  segmentCount: z.number().int().min(0).max(100),
  issues: z.array(replyIssueSchema).max(16),
  promptTokens: z.number().int().min(0).max(10_000_000).optional(),
  completionTokens: z.number().int().min(0).max(1_000_000).optional(),
});
export type ReplyDiagnostic = z.infer<typeof schema>;
export type DiagnosticSink = (facts: ReplyDiagnostic) => void;
export function safeReplyDiagnostic(facts: unknown): ReplyDiagnostic | undefined {
  const parsed = schema.safeParse(facts); return parsed.success ? parsed.data : undefined;
}
// Only bounded enum/numeric facts, never original text, keys, headers, error messages or IDs.
export function writeReplyDiagnostic(facts: ReplyDiagnostic, path = resolve('.local/last-reply-diagnostic.json')) {
  const safe = safeReplyDiagnostic(facts); if (!safe) return;
  try { mkdirSync(dirname(path), { recursive:true, mode:0o700 }); writeFileSync(path, JSON.stringify(safe), { mode:0o600 }); }
  catch { /* A diagnostic write must not turn usable dialogue into a failed paid request. */ }
}
