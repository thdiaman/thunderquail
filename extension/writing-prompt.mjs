export const DEFAULT_WRITING_PROMPT = "Write naturally and idiomatically in the requested language. For email, use greetings, closings, names, and a level of formality that sound natural to a native speaker in that context. Avoid literal translations of salutations and stock phrases. Preserve names, facts, and the writer’s intent.";

export function writingPrompt(settings) {
  return settings.writing_prompt?.trim() || DEFAULT_WRITING_PROMPT;
}
