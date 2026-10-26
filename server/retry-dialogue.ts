import { abortError, delay } from '../shared/async';
import { withAbort } from '../shared/abortable';
import { ProviderError, type DialogueProvider } from './providers';
import { sanitizeValidationIssues } from './validation-feedback';
const repairable = new Set(['INVALID_REPLY', 'EMPTY_REPLY', 'TRUNCATED_REPLY', 'REPLY_TOO_LONG']);
// Place this OUTSIDE auditDialogue so every bounded attempt is counted separately.
export function retryDialogue(provider: DialogueProvider): DialogueProvider {
  return {
    kind: provider.kind,
    async reply(request, signal) {
      let issues: string[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (signal.aborted) throw abortError();
        try {
          const reply = await withAbort(
            provider.reply(request, signal, { attempt, issues }),
            signal,
          );
          if (signal.aborted) throw abortError();
          return reply;
        } catch (error) {
          if (signal.aborted) throw abortError();
          if (!(error instanceof ProviderError) || !repairable.has(error.code)) throw error;
          if (attempt === 3)
            throw new ProviderError(
              error.code,
              '这轮对白尝试了 3 次仍未通过格式校验，请换一句话再试。',
            );
          issues = sanitizeValidationIssues(error.validationIssues);
          if (!issues.length)
            issues = [
              error.code === 'EMPTY_REPLY'
                ? 'root:empty_text'
                : error.code === 'TRUNCATED_REPLY'
                  ? 'root:truncated'
                  : 'root:invalid_json',
            ];
          // Small bounded pause, abortable; the route's 18s deadline covers all attempts.
          await delay(120, signal);
        }
      }
      throw new ProviderError('INVALID_REPLY', '对白校验失败。');
    },
  };
}
