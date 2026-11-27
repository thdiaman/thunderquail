import { loadSearchScopes, searchIndexedMail } from "./companion-search.mjs";
import { readEmailBody } from "./email-context.mjs";
import { loadExcludedEmails, mailIdentity } from "./privacy.mjs";
import { sentStyleExcerpt } from "./sent-style.mjs";

export const MAIL_RESULT_LIMIT = 10;
export const MAIL_SHARE_LIMIT = 4;
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

export async function recentMail(unread, signal) {
  const since = new Date(Date.now() - RECENT_DAYS * 86400000);
  const inboxes = (await browser.folders.query({ specialUse: ["inbox"] }))
    .filter(folder => !folder.isVirtual && !folder.isUnified);
  const recent = [];
  for (const folder of inboxes) {
    signal.throwIfAborted();
    let page = await browser.messages.query({ folderId: folder.id, ...(unread ? { read: false } : { fromDate: since }) });
    try {
      do {
        signal.throwIfAborted();
        for (const message of page.messages) {
          recent.push({ id: message.id, identity: mailIdentity(message.headerMessageId), subject: message.subject,
            from: message.author, date: message.date, unread: message.read === false });
        }
        recent.sort((a, b) => new Date(b.date) - new Date(a.date));
        recent.splice(0, recent.length, ...uniqueMail(recent, MAIL_RESULT_LIMIT));
        if (!page.id) break;
        page = await browser.messages.continueList(page.id);
      } while (page);
    } finally {
      if (signal.aborted && page?.id) await browser.messages.abortList(page.id).catch(() => {});
    }
  }
  return recent;
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
  return uniqueMail(rows.filter(row => {
    if (!row.identity || skip.has(row.identity) || excluded.has(row.identity)) return false;
    return !authors || authors.has((row.from.match(/<([^<>]+)>\s*$/)?.[1] ?? row.from).trim().toLowerCase());
  }), MAIL_RESULT_LIMIT).map(row => ({ ...row, sentExample: sentOnly }));
}

export async function mailExcerpts(rows, signal) {
  const excluded = await loadExcludedEmails();
  const results = await Promise.allSettled(rows.filter(row => row.identity && !excluded.has(row.identity))
    .slice(0, MAIL_SHARE_LIMIT).map(async (row, index) => {
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
          text = (await Promise.race([readEmailBody(row.id), timeout])).slice(0, 1200);
        } finally {
          deadline.removeEventListener("abort", cancel);
        }
      } else if (row.sentExample) text = sentStyleExcerpt(text);
      return { ...row, date: new Date(row.date).toLocaleString(), text: text?.trim(), reference: `Mail ${index + 1}` };
    }));
  signal.throwIfAborted();
  return results.flatMap(result => result.status === "fulfilled" && result.value.text ? [result.value] : []);
}
