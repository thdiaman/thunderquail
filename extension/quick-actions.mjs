// The row above the text box. It depends only on the current state and never lists a disabled action.
// kind "run" sends `prompt` as a question, "fill" puts `text` in the box for the user to finish,
// and the other kinds are handled by dedicated code.

const run = (id, label, prompt) => ({ id, label, kind: "run", prompt });

export const PROMPTS = {
  summarize: "Summarize the attached email context.",
  actionItems: "Extract the action items from the attached email context.",
  reply: "Draft a reply to this email.",
  shorter: "Make the draft shorter. Keep every essential point.",
  formal: "Rewrite the draft in a more formal tone.",
  friendlier: "Rewrite the draft in a friendlier tone.",
  needsReply: "Which of these emails need a reply from me? List them by reference.",
  digestActions: "List the action items from these emails, citing each by reference.",
  summarizeResults: "Summarize these emails.",
  moreResults: "Show more results for the same search."
};

/**
 * @param {{hasEmail: boolean, result?: string, canUsePastReplies?: boolean, canWiden?: boolean}} state
 * `result` is the kind of the last assistant result: summary, draft, digest, search or mailbox.
 */
export function chatActions({ hasEmail, result, canUsePastReplies = false, canWiden = false }) {
  switch (result) {
    case "summary":
      return [run("reply", "Draft a reply", PROMPTS.reply), { id: "related", label: "Find related emails", kind: "related" }];
    case "draft":
      return [
        run("shorter", "Shorter", PROMPTS.shorter),
        run("formal", "More formal", PROMPTS.formal),
        run("friendlier", "Friendlier", PROMPTS.friendlier),
        { id: "translate", label: "Translate", kind: "fill", text: "Translate the draft into " },
        ...(canUsePastReplies ? [{ id: "past", label: "Use my past replies", kind: "past" }] : [])
      ];
    case "digest":
      return [
        run("needs-reply", "What needs a reply?", PROMPTS.needsReply),
        run("digest-actions", "Action items from these", PROMPTS.digestActions),
        ...(canWiden ? [{ id: "older", label: "Older emails", kind: "older" }] : [])
      ];
    case "search":
      return [run("summarize-results", "Summarize these", PROMPTS.summarizeResults),
        run("more-results", "Show more results", PROMPTS.moreResults)];
    case "mailbox":
      return [];
    default:
      return hasEmail
        ? [run("summarize", "Summarize", PROMPTS.summarize), run("action-items", "Action items", PROMPTS.actionItems),
          run("reply", "Draft a reply", PROMPTS.reply), { id: "related", label: "Find related emails", kind: "related" }]
        : [{ id: "whats-new", label: "What's new?", kind: "whatsnew" },
          { id: "find", label: "Find an email", kind: "fill", text: "Find the email about " },
          { id: "write", label: "Write an email", kind: "fill", text: "Write an email to " }];
  }
}

/** The examples shown in an empty chat. They teach what the assistant can do, and are not a second row of buttons. */
export const EXAMPLE_PROMPTS = [
  "What's new in my mail?",
  "Show unread emails from this week",
  "Find the email about the invoice",
  "Summarize this email and list what I need to do"
];
