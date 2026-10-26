import type { z } from 'zod';
const codes = new Set([
  'invalid_type',
  'too_big',
  'too_small',
  'invalid_format',
  'not_multiple_of',
  'unrecognized_keys',
  'invalid_union',
  'invalid_key',
  'invalid_element',
  'invalid_value',
  'custom',
]);
const fields = new Set([
  'segments',
  'text',
  'emotion',
  'action',
  'scene',
  'event',
  'beat',
  'story',
  'intent',
  'planQuote',
]);
const pattern =
  /^(?:root|(?:segments|story)(?:\.(?:[0-9]{1,2}|text|emotion|action|scene|event|beat|intent|planQuote))*)(?::)(?:invalid_type|too_big|too_small|invalid_format|not_multiple_of|unrecognized_keys|invalid_union|invalid_key|invalid_element|invalid_value|custom|empty_text|invalid_json|truncated)$/;
export function sanitizeValidationIssues(values: readonly string[] = []): string[] {
  return [
    ...new Set(
      values.filter(
        (value) => typeof value === 'string' && value.length <= 100 && pattern.test(value),
      ),
    ),
  ].slice(0, 8);
}
export function zodValidationIssues(issues: z.core.$ZodIssue[]): string[] {
  return sanitizeValidationIssues(
    issues.map((issue) => {
      const safePath = issue.path.every((p) =>
        typeof p === 'number'
          ? Number.isInteger(p) && p >= 0 && p < 100
          : typeof p === 'string' && fields.has(p),
      );
      const path = safePath && issue.path.length ? issue.path.join('.') : 'root';
      return path + ':' + (codes.has(issue.code) ? issue.code : 'invalid_value');
    }),
  );
}
