import { readEmailBody } from "./email-context.mjs";

const SAMPLE_COUNT = 8;
const SAMPLE_LENGTH = 800;
const CANDIDATE_COUNT = 24;

export function sentStyleExcerpt(body) {
  const authored = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(?:-{2,}\s*(?:original message|forwarded message|αρχικό μήνυμα|προωθημένο μήνυμα)|begin forwarded message:|on .+ wrote:|στις .+ έγραψε:)/iu.test(line)) break;
    if (!/^\s*>/.test(line)) authored.push(line);
  }
  return authored.join("\n").trim().slice(0, SAMPLE_LENGTH);
}

export async function sentStyleSamples(folderId) {
  const fromDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const candidates = [];
  let page = await browser.messages.query({ folderId, fromDate, fromMe: true });
  while (true) {
    candidates.push(...page.messages);
    candidates.sort((a, b) => new Date(b.date) - new Date(a.date));
    candidates.splice(CANDIDATE_COUNT);
    if (!page.id) break;
    page = await browser.messages.continueList(page.id);
  }

  const excerpts = new Set();
  for (const { id } of candidates) {
    try {
      const excerpt = sentStyleExcerpt(await readEmailBody(id, { omitQuotes: true }));
      if (excerpt) excerpts.add(excerpt);
    } catch {
      // An unavailable message body should not prevent sampling the rest.
    }
    if (excerpts.size >= SAMPLE_COUNT) break;
  }
  return [...excerpts];
}
