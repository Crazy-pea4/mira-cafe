// Logs accept enumerated facts only. Never pass request/response objects or Error.message.
export type LogFacts = { event: 'started' | 'start_failed'; provider?: 'mock' | 'deepseek'; port?: number; };
export function logFacts(facts: LogFacts) {
  return { event: facts.event === 'started' ? 'started' : 'start_failed',
    ...(facts.provider === 'mock' || facts.provider === 'deepseek' ? { provider: facts.provider } : {}),
    ...(Number.isInteger(facts.port) && facts.port! > 0 && facts.port! < 65536 ? { port: facts.port } : {}) };
}
