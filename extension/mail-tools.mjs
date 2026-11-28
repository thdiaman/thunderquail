import { loadSearchScopes, searchIndexedMail } from "./companion-search.mjs";
import { readEmailBody } from "./email-context.mjs";
import { loadExcludedEmails, mailIdentity } from "./privacy.mjs";
import { sentStyleExcerpt } from "./sent-style.mjs";
import {
  coverageNote, decodedFolderPath, filterIndexRows, folderInScope, mergeResults, planGapSearch, searchThunderbird,
  searchableFolders
} from "./thunderbird-search.mjs";

export const MAIL_RESULT_LIMIT = 10;
export const MAIL_SHARE_LIMIT = 4;
export const INBOX_PAGE_SIZE = 20;
export const INBOX_EXCERPT_LENGTH = 1200;

function uniqueMail(rows, limit) {
  const seen = new Set();
  return rows.filter(row => {
    const key = row.identity || row.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

async function indexedSentScopes(companion) {
  const [{ scopes }, folders] = await Promise.all([
    loadSearchScopes(companion), browser.folders.query({ specialUse: ["sent"] })
  ]);
  if (scopes.some(scope => scope.kind === "folder" && !Array.isArray(scope.folders))) {
    throw new Error("Restart the companion from the current ThunderQuail checkout to search Sent folders.");
  }
  const sent = new Set(folders.filter(folder => !folder.isVirtual && !folder.isUnified)
    .map(folder => JSON.stringify([folder.accountId, decodedFolderPath(folder.path)])));
  const matches = scopes.filter(scope => scope.kind === "folder" &&
    sent.has(JSON.stringify([scope.account, scope.folders]))).map(scope => scope.id);
  if (!matches.length) throw new Error("No Thunderbird Sent folders are covered by the local index.");
  return matches;
}

/** Where Thunderbird must be searched because the index may lack the mail, honoring the chosen index scope. */
async function liveSearchPlan(companion, status, scope, signal) {
  let folders = searchableFolders(await browser.folders.query({}));
  if (companion && status?.searchable && scope && scope !== "all") {
    try {
      const { scopes } = await loadSearchScopes(companion);
      signal.throwIfAborted();
      const chosen = scopes.find(item => item.id === scope);
      if (chosen) folders = folders.filter(folder => folderInScope(folder, chosen));
    } catch (error) {
      signal.throwIfAborted();
      // Without the scope catalog, search every folder rather than none.
    }
  }
  return planGapSearch(folders, status);
}

/**
 * Searches by meaning in the companion's index when it is usable, and always searches Thunderbird itself for
 * mail the index lacks (newer than its last update, or in folders it has not reached). Without a companion,
 * Thunderbird's own search covers everything.
 * @returns {{rows: object[], note: string}} rows ready for the sharing review, and what the search covered
 */
export async function searchMail(companion, status, filters, { scope, signal }) {
  const excluded = await loadExcludedEmails();
  const plan = await liveSearchPlan(companion, status, scope, signal);
  const usable = Boolean(companion && status?.searchable);
  const [indexRows, liveRows] = await Promise.all([
    usable ? searchIndexedMail(companion, filters.query, signal, scope, { count: MAIL_SHARE_LIMIT * 2 })
      .then(rows => filterIndexRows(rows ?? [], filters)) : [],
    searchThunderbird(filters, plan, { signal, excluded, limit: MAIL_RESULT_LIMIT })
  ]);
  signal.throwIfAborted();
  const merged = mergeResults(indexRows, liveRows, MAIL_SHARE_LIMIT + 2);
  return { rows: await mailExcerpts(merged, signal), note: coverageNote(status, plan, liveRows.length) };
}

/** Emails related to the attached one: by meaning in the index, plus Thunderbird for what the index lacks. */
export async function relatedMail(companion, status, email, scope, signal) {
  const [{ headerIds = [] }, excluded] = await Promise.all([
    browser.quailOverlay.getThread(email.message.id, true), loadExcludedEmails()
  ]);
  signal.throwIfAborted();
  const skip = new Set([email.identity, ...email.parts.map(part => part.identity), ...headerIds.map(mailIdentity)]);
  let indexRows = [];
  if (companion && status?.searchable) {
    try {
      indexRows = await similarMail(companion, email, false, scope, signal);
    } catch (error) {
      signal.throwIfAborted();
      // The live search below still covers the mailbox.
    }
  }
  const subject = (email.subject || "").replace(/^\s*(?:(?:re|fwd?|απ|πρβ)\s*:\s*)+/i, "");
  const plan = await liveSearchPlan(companion, status, scope, signal);
  const liveRows = (await searchThunderbird({ query: subject }, plan, { signal, excluded, limit: MAIL_RESULT_LIMIT * 2 }))
    .filter(row => !skip.has(row.identity));
  return uniqueMail(mergeResults(indexRows, liveRows, MAIL_RESULT_LIMIT), MAIL_RESULT_LIMIT);
}

export async function similarMail(companion, email, sentOnly, scope, signal) {
  const [{ headerIds = [] }, excluded, scopes, accounts] = await Promise.all([
    browser.quailOverlay.getThread(email.message.id, true),
    loadExcludedEmails(),
    sentOnly ? indexedSentScopes(companion) : undefined,
    sentOnly ? browser.accounts.list(false) : undefined
  ]);
  signal.throwIfAborted();
  const skip = new Set([email.identity, ...email.parts.map(part => part.identity), ...headerIds.map(mailIdentity)]);
  const selected = email.parts.find(part => part.identity === email.identity);
  const background = email.parts.filter(part => part !== selected).map(part => part.text).join("\n\n");
  const query = [selected?.text.slice(0, 2900) || email.subject, background.slice(0, 1000)].filter(Boolean).join("\n\n");
  const rows = await searchIndexedMail(companion, query, signal, sentOnly ? "all" : scope,
    { count: 50, scopes, strict: true });
  const authors = accounts && new Set(accounts.flatMap(account => account.identities ?? [])
    .filter(identity => identity.email).map(identity => identity.email.trim().toLowerCase()));
  const candidates = rows.filter(row => {
    if (!row.identity || skip.has(row.identity) || excluded.has(row.identity)) return false;
    return !authors || authors.has((row.from.match(/<([^<>]+)>\s*$/)?.[1] ?? row.from).trim().toLowerCase());
  });
  return uniqueMail(sentOnly ? candidates.map(row => ({ ...row, text: sentStyleExcerpt(row.text) }))
    .filter(row => row.text) : candidates, MAIL_RESULT_LIMIT);
}

export async function mailExcerpts(rows, signal, { inbox = false } = {}) {
  const excluded = await loadExcludedEmails();
  const results = await Promise.allSettled(rows.filter(row => row.identity && !excluded.has(row.identity))
    .slice(0, inbox ? INBOX_PAGE_SIZE : MAIL_SHARE_LIMIT).map(async (row, index) => {
      let text = row.text;
      if (row.id !== undefined) {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
        deadline.throwIfAborted();
        let cancel;
        try {
          const timeout = new Promise((_, reject) => {
            cancel = () => reject(deadline.reason);
            deadline.addEventListener("abort", cancel, { once: true });
          });
          text = (await Promise.race([readEmailBody(row.id), timeout])).slice(0, INBOX_EXCERPT_LENGTH);
        } catch (error) {
          signal.throwIfAborted();
          if (!inbox) throw error;
          text = "[Message body unavailable. Summarize from the headers only.]";
        } finally {
          deadline.removeEventListener("abort", cancel);
        }
      }
      const sent = new Date(row.date);
      return { ...row, date: Number.isNaN(sent.getTime()) ? row.date : sent.toLocaleString(), text: text?.trim(),
        reference: `Mail ${index + 1}` };
    }));
  signal.throwIfAborted();
  return results.flatMap(result => result.status === "fulfilled" && result.value.text ? [result.value] : []);
}
