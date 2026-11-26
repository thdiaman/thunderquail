import { readEmailBody } from "./email-context.mjs";
import { mailIdentity } from "./privacy.mjs";

const SAMPLE_COUNT = 12;
export const SAMPLE_LENGTH = 800;
const CANDIDATE_COUNT = 24;

export function sentStyleExcerpt(body) {
  const authored = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(?:-{2,}\s*(?:original message|forwarded message|αρχικό μήνυμα|προωθημένο μήνυμα)|begin forwarded message:|on .+ wrote:|στις .+ έγραψε:)/iu.test(line)) break;
    if (!/^\s*>/.test(line)) authored.push(line);
  }
  return authored.join("\n").trim().slice(0, SAMPLE_LENGTH);
}

async function folderCandidates(folderId, fromDate, excluded) {
  const candidates = [];
  let page = await browser.messages.query({ folderId, fromDate, fromMe: true });
  while (true) {
    for (const message of page.messages) {
      const identity = mailIdentity(message.headerMessageId);
      if (identity && !excluded.has(identity)) candidates.push({ message, identity });
    }
    candidates.sort((a, b) => new Date(b.message.date) - new Date(a.message.date));
    candidates.splice(CANDIDATE_COUNT);
    if (!page.id) break;
    page = await browser.messages.continueList(page.id);
  }

  const excerpts = [];
  for (const { message: { id, date, subject }, identity } of candidates) {
    try {
      const text = sentStyleExcerpt(await readEmailBody(id, { omitQuotes: true }));
      const words = text.match(/\p{L}+/gu)?.length ?? 0;
      if (text.length < 18 || words < 3) continue;
      const greek = (text.match(/\p{Script=Greek}/gu) ?? []).length;
      const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
      excerpts.push({
        folderId, identity, subject, text, date: new Date(date).getTime(),
        key: text.normalize("NFC").toLowerCase().replace(/\s+/g, " "),
        script: greek > latin ? "Greek" : latin ? "Latin" : "Other",
        length: words <= 35 ? "short" : "long"
      });
    } catch {
      // An unavailable message body should not prevent sampling the rest.
    }
  }
  return excerpts;
}

export async function sentStyleSamples(folderIds, excluded = new Map()) {
  const fromDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const groups = [];
  for (const id of new Set(folderIds)) {
    const candidates = await folderCandidates(id, fromDate, excluded);
    if (candidates.length) groups.push(candidates);
  }
  groups.sort((a, b) => b[0].date - a[0].date);

  const samples = [];
  const used = new Set();
  const scripts = new Set();
  const lengths = new Set();
  const variety = sample => Number(!scripts.has(sample.script)) + Number(!lengths.has(sample.length));
  function pick(candidates) {
    if (samples.length >= SAMPLE_COUNT) return;
    let best;
    for (const sample of candidates) {
      if (used.has(sample.key)) continue;
      if (!best || variety(sample) > variety(best) ||
          (variety(sample) === variety(best) && sample.date > best.date)) best = sample;
    }
    if (!best) return;
    used.add(best.key);
    scripts.add(best.script);
    lengths.add(best.length);
    const { folderId, identity, subject, text } = best;
    samples.push({ folderId, identity, subject, text });
  }

  // Cover distinct folders before letting a single folder contribute multiple excerpts.
  for (const group of groups) pick(group);
  const remaining = groups.flat();
  while (samples.length < SAMPLE_COUNT) {
    const count = samples.length;
    pick(remaining);
    if (count === samples.length) break;
  }
  return samples;
}
