export const DEFAULT_WRITING_PROMPT = "Write naturally and idiomatically in the requested language. For email, use greetings, closings, names, and a level of formality that sound natural to a native speaker in that context. Avoid literal translations of salutations and stock phrases. Preserve names, facts, and the writer’s intent.";

export const EMAIL_AUTHORSHIP_RULES = "Write from the user's perspective. If sender_name is available, it identifies the user. Refer to the user in the first person. Never infer the author's name from incoming mail, recipients, quoted text, or the writing profile. For a new draft, leave the signature to Thunderbird unless the user asks for one. When a signature is requested, use the name explicitly given by the user or sender_name. If neither is known, omit the name. Keep the draft in the requested language, preserving names and intentional quotations.";

export function writingPrompt(settings) {
  return settings.writing_prompt?.trim() || DEFAULT_WRITING_PROMPT;
}

export function emailWritingPrompt(settings) {
  const profile = settings.writing_profile?.trim();
  const instructions = writingPrompt(settings);
  return profile
    ? `${instructions}\n\nUse this reviewed writing profile for phrasing and tone only. Follow the current request and context for facts, names, dates, and commitments.\n${profile}\n\n${EMAIL_AUTHORSHIP_RULES}`
    : `${instructions}\n\n${EMAIL_AUTHORSHIP_RULES}`;
}
