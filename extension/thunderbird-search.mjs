// Search of the live Thunderbird mailboxes. It works alone, or fills the gap the companion's index leaves:
// mail that arrived after a folder was last indexed, and folders the index has not reached yet.
import { mailIdentity } from "./privacy.mjs";

export const GAP_MARGIN_MS = 24 * 60 * 60 * 1000;
const MAX_KEYWORDS = 3;
const QUERY_CAP = 400;
const FOLDER_CONCURRENCY = 3;
const SKIPPED_FOLDERS = ["junk", "trash", "outbox", "templates"];
const STOPWORDS = new Set(`about above after again all also and any are because been before being between both but can could did does
doing down during each email emails find for from further had has have having her here hers him his how into its itself just me
mail message messages more most myself nor not now off once only other our out over own same she should some such than that the
their them then there these they this those through too under until very was were what when where which while who whom why will
with would you your και του της των για από στο στη την τον που μια ένα είναι με να το`.split(/\s+/));

export function decodedFolderPath(path) {
  return path.split("/").filter(Boolean).map(part => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

const folderKey = (account, parts) => JSON.stringify([account, parts.map(part => part.toLowerCase())]);

/** The most specific words of a question, for Thunderbird's substring search. */
export function extractKeywords(query, limit = MAX_KEYWORDS) {
  const words = (String(query ?? "").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [])
    .map(word => word.replace(/^['’-]+|['’-]+$/g, ""))
    .filter(word => word.length >= 3 && !STOPWORDS.has(word));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, limit);
}

/** Real folders worth searching: no virtual or unified folders, junk, trash, outbox or templates. */
export function searchableFolders(folders) {
  return folders.filter(folder => !folder.isVirtual && !folder.isUnified && folder.accountId &&
    !folder.specialUse?.some(use => SKIPPED_FOLDERS.includes(use)));
}

/** Whether a folder belongs to a companion search scope ({kind, account, folders}). */
export function folderInScope(folder, scope) {
  if (!scope) return true;
  if (folder.accountId !== scope.account) return false;
  if (scope.kind === "account") return true;
  const path = decodedFolderPath(folder.path).map(part => part.toLowerCase());
  const wanted = (scope.folders ?? []).map(part => part.toLowerCase());
  if (scope.kind === "folder") return path.length === wanted.length && path.every((part, index) => part === wanted[index]);
  return path.length >= wanted.length && wanted.every((part, index) => part === path[index]);
}

/**
 * Decides, per Thunderbird folder, which part still has to be searched in Thunderbird.
 * `since` is null for the whole folder, or the date from which mail may be missing from the index.
 * Without a usable companion status every folder is searched completely.
 */
export function planGapSearch(folders, status) {
  const known = new Map();
  if (status?.searchable) {
    for (const entry of status.folders ?? []) known.set(folderKey(entry.account, entry.folders ?? []), entry);
  }
  return folders.map(folder => {
    const entry = known.get(folderKey(folder.accountId, decodedFolderPath(folder.path)));
    const through = entry?.indexed_through ? new Date(entry.indexed_through) : null;
    if (!entry || !through || Number.isNaN(through.getTime())) return { folder, since: null, indexed: false };
    return { folder, since: new Date(through.getTime() - GAP_MARGIN_MS), indexed: entry.state === "indexed" };
  });
}

async function queryFolder(folder, filters, signal) {
  const found = [];
  let page = await browser.messages.query({ folderId: folder.id, ...filters });
  try {
    while (page) {
      signal.throwIfAborted();
      found.push(...page.messages);
      if (found.length >= QUERY_CAP || !page.id) break;
      page = await browser.messages.continueList(page.id);
    }
  } finally {
    if (page?.id) await browser.messages.abortList(page.id).catch(() => {});
  }
  return found.slice(0, QUERY_CAP);
}

async function inBatches(items, size, task) {
  const results = [];
  for (let index = 0; index < items.length; index += size) {
    results.push(...await Promise.all(items.slice(index, index + size).map(task)));
  }
  return results;
}

/**
 * Searches Thunderbird for messages matching the keywords of `query` and the optional filters.
 * `plan` is the result of planGapSearch. Returns rows ranked by matched keywords, then recency.
 */
export async function searchThunderbird({ query, from, since, before }, plan, { signal, excluded = new Set(), limit = 20 }) {
  const keywords = extractKeywords(query);
  if (!keywords.length && !from && !since && !before) return [];
  const lower = since ? new Date(since) : null;
  const upper = before ? new Date(before) : null;
  const matches = new Map();
  await inBatches(plan, FOLDER_CONCURRENCY, async ({ folder, since: gapSince }) => {
    const start = [lower, gapSince].filter(Boolean).sort((a, b) => b - a)[0];
    const filters = {
      ...(from && { author: from }),
      ...(start && { fromDate: start }),
      ...(upper && { toDate: upper })
    };
    const queries = keywords.length ? keywords.map(keyword => ({ keyword, filters: { ...filters, fullText: keyword } }))
      : [{ keyword: "", filters }];
    const results = await Promise.all(queries.map(async ({ keyword, filters: queryFilters }) => ({
      keyword, messages: await queryFolder(folder, queryFilters, signal)
    })));
    for (const { keyword, messages } of results) {
      for (const message of messages) {
        const entry = matches.get(message.id) ?? { message, keywords: new Set() };
        if (keyword) entry.keywords.add(keyword);
        matches.set(message.id, entry);
      }
    }
  });
  signal.throwIfAborted();
  return [...matches.values()]
    .map(({ message, keywords: matched }) => ({
      id: message.id,
      identity: mailIdentity(message.headerMessageId),
      headerMessageId: message.headerMessageId,
      subject: message.subject ?? "",
      from: message.author ?? "",
      date: new Date(message.date).toISOString(),
      source: "thunderbird",
      score: matched.size
    }))
    .filter(row => row.identity && !excluded.has(row.identity))
    .sort((a, b) => b.score - a.score || Date.parse(b.date) - Date.parse(a.date))
    .slice(0, limit);
}

/** Applies the assistant's optional sender and date filters to index rows. */
export function filterIndexRows(rows, { from, since, before }) {
  const needle = from?.toLowerCase();
  const lower = since ? Date.parse(since) : NaN;
  const upper = before ? Date.parse(before) : NaN;
  return rows.filter(row => {
    if (needle && !row.from.toLowerCase().includes(needle)) return false;
    const time = Date.parse(row.date);
    if (!Number.isNaN(time)) {
      if (!Number.isNaN(lower) && time < lower) return false;
      if (!Number.isNaN(upper) && time > upper) return false;
    }
    return true;
  });
}

/** Combines index and Thunderbird rows without duplicates, alternating so that neither source crowds out the other. */
export function mergeResults(indexRows, liveRows, limit) {
  const merged = [];
  const seen = new Set();
  // A message found by both keeps its index row, which already carries an excerpt.
  const indexed = new Set(indexRows.map(row => row.identity).filter(Boolean));
  const queues = [[...indexRows], liveRows.filter(row => !indexed.has(row.identity))];
  while (merged.length < limit && queues.some(queue => queue.length)) {
    for (const queue of queues) {
      while (queue.length) {
        const row = queue.shift();
        const key = row.identity || `id:${row.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(row);
        break;
      }
      if (merged.length >= limit) break;
    }
  }
  return merged;
}

/** A sentence for the assistant and the user saying what the search covered. */
export function coverageNote(status, plan, liveCount) {
  const matched = `${liveCount} message${liveCount === 1 ? "" : "s"} matched directly in Thunderbird`;
  if (!status?.searchable) {
    return "No local index was used. Thunderbird's own search covered the mailbox, including message bodies stored locally.";
  }
  const folders = status.folders ?? [];
  const through = folders.map(folder => folder.indexed_through).filter(Boolean).sort();
  const unindexed = plan.filter(item => !item.indexed).length;
  const oldest = through[0] && new Date(through[0]).toLocaleString();
  if (status.state === "indexing") {
    const done = folders.filter(folder => folder.state === "indexed").length;
    return `The index is still being built (${done} of ${folders.length} folders). ` +
      `Folders it has not reached and mail newer than its last update were searched directly: ${matched}.`;
  }
  return `The index is current${oldest ? ` through ${oldest}` : ""}${unindexed ? `, except ${unindexed} folder${unindexed === 1 ? "" : "s"} it does not cover` : ""}; ` +
    `${matched} for anything newer.`;
}
