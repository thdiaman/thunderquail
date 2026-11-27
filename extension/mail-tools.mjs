import { loadSearchScopes, searchIndexedMail } from "./companion-search.mjs";
import { readEmailBody } from "./email-context.mjs";
import { loadExcludedEmails, mailIdentity } from "./privacy.mjs";
import { sentStyleExcerpt } from "./sent-style.mjs";

export const MAIL_RESULT_LIMIT = 10;
export const MAIL_SHARE_LIMIT = 4;
export const INBOX_PAGE_SIZE = 20;
export const INBOX_EXCERPT_LENGTH = 1200;
const RECENT_DAYS = 30;

function uniqueMail(rows, limit) {
  const seen = new Set();
  return rows.filter(row => {
    const key = row.identity || row.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

export async function recentMail(unread, signal, before) {
  const inboxes = (await browser.folders.query({ specialUse: ["inbox"] }))
    .filter(folder => !folder.isVirtual && !folder.isUnified);
  const recent = [];
  const limit = INBOX_PAGE_SIZE + 1;
  const compare = (a, b) => b.time - a.time || b.id - a.id;
  const since = (before?.time ?? Date.now()) - RECENT_DAYS * 86400000;
  async function collect(dates, minimum, maximum) {
    for (const folder of inboxes) {
      signal.throwIfAborted();
      let page = await browser.messages.query({ folderId: folder.id, ...dates, ...(unread && { read: false }) });
      try {
        do {
          signal.throwIfAborted();
          for (const message of page.messages) {
            const time = new Date(message.date).getTime();
            const row = { id: message.id, identity: mailIdentity(message.headerMessageId), subject: message.subject,
              from: message.author, date: message.date, unread: message.read === false, time };
            if (time >= minimum && time < maximum && (!before || compare(row, before) > 0)) recent.push(row);
          }
          recent.sort(compare);
          recent.splice(0, recent.length, ...uniqueMail(recent, limit));
          if (!page.id) break;
          page = await browser.messages.continueList(page.id);
        } while (page);
      } finally {
        if (page?.id) await browser.messages.abortList(page.id).catch(() => {});
      }
    }
  }
  await collect({ fromDate: new Date(since - 1), ...(before && { toDate: new Date(before.time + 1) }) },
    since, Infinity);
  if (recent.length < limit) await collect({ toDate: new Date(since) }, -Infinity, since);
  return { rows: recent.slice(0, INBOX_PAGE_SIZE), hasMore: recent.length > INBOX_PAGE_SIZE };
}

function decodedFolderPath(path) {
  return path.split("/").filter(Boolean).map(part => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
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
      return { ...row, date: new Date(row.date).toLocaleString(), text: text?.trim(), reference: `Mail ${index + 1}` };
    }));
  signal.throwIfAborted();
  return results.flatMap(result => result.status === "fulfilled" && result.value.text ? [result.value] : []);
}
