export const DEFAULT_WRITING_PROMPT = "Write naturally and idiomatically in the requested language. For email, use greetings, closings, names, and a level of formality that sound natural to a native speaker in that context. Avoid literal translations of salutations and stock phrases. Preserve names, facts, and the writer’s intent.";

export function writingPrompt(settings) {
  return settings.writing_prompt?.trim() || DEFAULT_WRITING_PROMPT;
}

export function emailWritingPrompt(settings) {
  const profile = settings.writing_profile?.trim();
  const instructions = writingPrompt(settings);
  return profile
    ? `${instructions}\n\nUse this reviewed writing profile as style guidance. Follow the current request and context for facts, names, dates, and commitments.\n${profile}`
    : instructions;
}
