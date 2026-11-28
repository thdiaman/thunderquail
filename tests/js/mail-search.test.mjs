import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { describeIndex, folderLine } from "../../extension/index-status.mjs";
import {
  GAP_MARGIN_MS, coverageNote, extractKeywords, filterIndexRows, folderInScope, mergeResults, planGapSearch,
  searchThunderbird, searchableFolders
} from "../../extension/thunderbird-search.mjs";
import { chatActions } from "../../extension/quick-actions.mjs";
import {
  NEW_MAIL_BATCH, collectNewMail, daysAgo, describeNewMail, parseSince, summarizeInBatches
} from "../../extension/new-mail.mjs";

const folder = (id, accountId, path, extra = {}) => ({ id, accountId, path, name: path.split("/").pop(), specialUse: [], ...extra });
const FOLDERS = [
  folder("inbox", "account1", "/INBOX", { specialUse: ["inbox"] }),
  folder("archive", "account1", "/Archive/2024", { name: "2024" }),
  folder("junk", "account1", "/Junk", { specialUse: ["junk"] }),
  folder("sent", "account1", "/Sent", { specialUse: ["sent"] }),
  folder("virtual", "account1", "/Search", { isVirtual: true }),
  folder("other", "account2", "/Inbox", { specialUse: ["inbox"] })
];

let nextId = 1;
const message = (folderId, subject, body, date, extra = {}) => ({
  id: nextId++, folderId, subject, body, date: new Date(date), author: "Sender <sender@example.com>",
  headerMessageId: `<m${nextId}@example.com>`, read: true, ...extra
});

function install(messages, { pageSize = 100 } = {}) {
  const lists = new Map();
  let listId = 0;
  const page = (matches, offset = 0) => {
    const slice = matches.slice(offset, offset + pageSize);
    const more = offset + pageSize < matches.length;
    const id = more ? `list${++listId}` : null;
    if (id) lists.set(id, { matches, offset: offset + pageSize });
    return { id, messages: slice };
  };
  globalThis.browser = {
    folders: { query: async () => FOLDERS },
    accounts: { list: async () => [{ id: "account1", name: "Work" }, { id: "account2", name: "Home" }] },
    messages: {
      query: async query => page(messages.filter(item => item.folderId === query.folderId &&
        (query.fullText === undefined || `${item.subject} ${item.body} ${item.author}`.toLowerCase().includes(query.fullText.toLowerCase())) &&
        (query.read === undefined || item.read === query.read) &&
        (!query.fromDate || item.date > query.fromDate) && (!query.toDate || item.date < query.toDate) &&
        (!query.author || item.author.toLowerCase().includes(query.author.toLowerCase())))),
      continueList: async id => {
        const list = lists.get(id);
        return page(list.matches, list.offset);
      },
      abortList: async id => { lists.delete(id); }
    }
  };
}

const signal = new AbortController().signal;

describe("keywords and folders", () => {
  test("extractKeywords keeps the most specific words", () => {
    assert.deepEqual(extractKeywords("Find the email about the garden invoice from Anna"), ["invoice", "garden", "anna"]);
    assert.deepEqual(extractKeywords("what is the"), []);
    assert.deepEqual(extractKeywords("τιμολόγιο για τον κήπο").slice(0, 2), ["τιμολόγιο", "κήπο"]);
  });

  test("searchableFolders skips virtual, junk, trash and similar folders", () => {
    assert.deepEqual(searchableFolders(FOLDERS).map(item => item.id), ["inbox", "archive", "sent", "other"]);
  });

  test("folderInScope handles account, folder and subtree scopes", () => {
    assert.ok(folderInScope(FOLDERS[1], { kind: "account", account: "account1" }));
    assert.ok(!folderInScope(FOLDERS[5], { kind: "account", account: "account1" }));
    assert.ok(folderInScope(FOLDERS[1], { kind: "folder", account: "account1", folders: ["archive", "2024"] }));
    assert.ok(!folderInScope(FOLDERS[1], { kind: "folder", account: "account1", folders: ["Archive"] }));
    assert.ok(folderInScope(FOLDERS[1], { kind: "subtree", account: "account1", folders: ["Archive"] }));
    assert.ok(folderInScope(FOLDERS[0], null));
  });
});

describe("gap planning", () => {
  const through = "2026-11-28T10:00:00+00:00";
  const status = {
    searchable: true, state: "ready",
    folders: [
      { account: "account1", folders: ["INBOX"], state: "indexed", indexed_through: through },
      { account: "account1", folders: ["Archive", "2024"], state: "pending", indexed_through: null }
    ]
  };

  test("indexed folders are searched from a day before the indexed-through time", () => {
    const plan = planGapSearch(searchableFolders(FOLDERS), status);
    const inbox = plan.find(item => item.folder.id === "inbox");
    assert.equal(inbox.since.getTime(), Date.parse(through) - GAP_MARGIN_MS);
    assert.ok(inbox.indexed);
  });

  test("folders the index lacks are searched completely", () => {
    const plan = planGapSearch(searchableFolders(FOLDERS), status);
    for (const id of ["archive", "sent", "other"]) assert.equal(plan.find(item => item.folder.id === id).since, null);
  });

  test("without a usable companion every folder is searched completely", () => {
    for (const unusable of [null, { searchable: false, folders: status.folders }]) {
      assert.ok(planGapSearch(searchableFolders(FOLDERS), unusable).every(item => item.since === null));
    }
  });

  test("coverage notes say what the search covered", () => {
    const plan = planGapSearch(searchableFolders(FOLDERS), status);
    assert.match(coverageNote(null, plan, 2), /No local index was used/);
    assert.match(coverageNote(status, plan, 1), /index is current through .*1 message matched directly in Thunderbird/);
    assert.match(coverageNote({ ...status, state: "indexing" }, plan, 3), /still being built \(1 of 2 folders\).*3 messages/);
  });
});

describe("Thunderbird search", () => {
  beforeEach(() => { nextId = 1; });

  test("ranks messages by matched keywords and finds mail the index lacks", async () => {
    install([
      message("inbox", "Garden invoice", "Please pay the invoice for the garden.", "2026-11-28T09:00:00Z"),
      message("inbox", "Invoice only", "A different invoice.", "2026-11-28T08:00:00Z"),
      message("archive", "Lunch", "Nothing relevant.", "2026-11-27T08:00:00Z"),
      message("sent", "Re: garden", "I will pay the invoice soon.", "2026-11-26T08:00:00Z")
    ]);
    const plan = planGapSearch(searchableFolders(FOLDERS), null);
    const rows = await searchThunderbird({ query: "garden invoice" }, plan, { signal });
    assert.deepEqual(rows.map(row => row.subject), ["Garden invoice", "Re: garden", "Invoice only"]);
    assert.equal(rows[0].score, 2);
  });

  test("only looks at mail newer than the indexed-through date for indexed folders", async () => {
    install([
      message("inbox", "Old invoice", "invoice", "2026-11-01T00:00:00Z"),
      message("inbox", "New invoice", "invoice", "2026-11-28T11:00:00Z")
    ]);
    const status = { searchable: true, folders: [{ account: "account1", folders: ["INBOX"], state: "indexed", indexed_through: "2026-11-28T10:00:00+00:00" }] };
    const plan = planGapSearch(searchableFolders(FOLDERS).filter(item => item.id === "inbox"), status);
    const rows = await searchThunderbird({ query: "invoice" }, plan, { signal });
    assert.deepEqual(rows.map(row => row.subject), ["New invoice"]);
  });

  test("applies sender and date filters, skips excluded mail, and honors the limit", async () => {
    install([
      ...Array.from({ length: 30 }, (_, index) => message("inbox", `Report ${index}`, "quarterly report", `2026-11-${String(1 + index % 28).padStart(2, "0")}T12:00:00Z`)),
      message("inbox", "Anna report", "quarterly report", "2026-11-20T12:00:00Z", { author: "Anna <anna@example.com>" })
    ]);
    const plan = planGapSearch(searchableFolders(FOLDERS), null);
    const anna = await searchThunderbird({ query: "quarterly report", from: "anna" }, plan, { signal });
    assert.deepEqual(anna.map(row => row.subject), ["Anna report"]);
    const limited = await searchThunderbird({ query: "report" }, plan, { signal, limit: 5 });
    assert.equal(limited.length, 5);
    const excluded = new Map([[limited[0].identity, "x"]]);
    const without = await searchThunderbird({ query: "report" }, plan, { signal, limit: 5, excluded });
    assert.ok(!without.some(row => row.identity === limited[0].identity));
    const recent = await searchThunderbird({ query: "report", since: "2026-11-25" }, plan, { signal, limit: 50 });
    assert.ok(recent.length && recent.every(row => Date.parse(row.date) > Date.parse("2026-11-25")));
  });

  test("a filter-only query works and an empty query returns nothing", async () => {
    install([message("inbox", "Hello", "hi", "2026-11-28T12:00:00Z", { author: "Anna <anna@example.com>" })]);
    const plan = planGapSearch(searchableFolders(FOLDERS), null);
    assert.equal((await searchThunderbird({ query: "", from: "anna" }, plan, { signal })).length, 1);
    assert.deepEqual(await searchThunderbird({ query: "the" }, plan, { signal }), []);
  });

  test("merging alternates sources and drops duplicates", () => {
    const row = (identity, source) => ({ identity, source });
    const merged = mergeResults([row("a", "index"), row("b", "index"), row("c", "index")],
      [row("b", "tb"), row("d", "tb"), row("e", "tb")], 5);
    assert.deepEqual(merged.map(item => `${item.identity}:${item.source}`), ["a:index", "d:tb", "b:index", "e:tb", "c:index"]);
    assert.equal(mergeResults([], [], 3).length, 0);
  });

  test("index rows can be filtered by sender and date", () => {
    const rows = [{ from: "Anna <a@x.org>", date: "Mon, 24 Nov 2026 10:00:00 +0000" },
      { from: "Bob <b@x.org>", date: "Mon, 10 Nov 2026 10:00:00 +0000" }];
    assert.equal(filterIndexRows(rows, { from: "anna" }).length, 1);
    assert.equal(filterIndexRows(rows, { since: "2026-11-20" }).length, 1);
    assert.equal(filterIndexRows(rows, { before: "2026-11-20" })[0].from.startsWith("Bob"), true);
  });
});

describe("What's new", () => {
  beforeEach(() => { nextId = 1; });

  test("collects every message with no cap, across pages, newest first", async () => {
    install(Array.from({ length: 450 }, (_, index) => message(index % 2 ? "inbox" : "archive", `Mail ${index}`, "x",
      new Date(Date.UTC(2026, 10, 1) + index * 60000), { read: false })), { pageSize: 100 });
    const { rows, folders } = await collectNewMail({ unread: true }, signal);
    assert.equal(rows.length, 450);
    assert.equal(rows[0].subject, "Mail 449");
    assert.deepEqual(folders.map(item => item.count), [225, 225]);
  });

  test("unread and date filters combine, and junk, sent and virtual folders are ignored", async () => {
    install([
      message("inbox", "Unread new", "x", "2026-11-28T09:00:00Z", { read: false }),
      message("inbox", "Read new", "x", "2026-11-28T09:00:00Z", { read: true }),
      message("inbox", "Unread old", "x", "2026-11-01T09:00:00Z", { read: false }),
      message("junk", "Spam", "x", "2026-11-28T09:00:00Z", { read: false }),
      message("sent", "Mine", "x", "2026-11-28T09:00:00Z", { read: false })
    ]);
    const both = await collectNewMail({ unread: true, since: new Date("2026-11-20T00:00:00Z") }, signal);
    assert.deepEqual(both.rows.map(row => row.subject), ["Unread new"]);
    const dateOnly = await collectNewMail({ unread: false, since: new Date("2026-11-20T00:00:00Z") }, signal);
    assert.deepEqual(dateOnly.rows.map(row => row.subject).sort(), ["Read new", "Unread new"]);
  });

  test("describes the scope and parses dates", () => {
    assert.match(describeNewMail({ unread: true, since: null }, 37, 4), /^37 unread emails in 4 folders$/);
    assert.match(describeNewMail({ unread: false, since: new Date(2026, 10, 24) }, 1, 1), /^1 email since .* in 1 folder$/);
    assert.equal(parseSince("2026-11-24").getDate(), 24);
    assert.equal(parseSince("not a date"), null);
    assert.equal(parseSince(""), null);
    assert.equal(daysAgo(7, new Date(2026, 10, 28, 15)).getDate(), 21);
  });

  const rowsOf = count => Array.from({ length: count }, (_, index) => ({ id: index + 1, identity: `m${index + 1}`, subject: `S${index + 1}`, from: "f", date: "d" }));
  const loader = skip => async batch => batch.filter(row => !skip?.has(row.id)).map(row => ({ ...row, text: `body ${row.id}` }));

  test("a small set is summarized in one streamed call", async () => {
    const calls = [];
    const result = await summarizeInBatches(rowsOf(5), {
      loadExcerpts: loader(), signal,
      ask: async (system, payload, options) => { calls.push({ system, payload, options }); return "DIGEST"; }
    });
    assert.equal(result.digest, "DIGEST");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.stream, true);
    assert.deepEqual(calls[0].payload.excerpts.map(item => item.reference), ["Mail 1", "Mail 2", "Mail 3", "Mail 4", "Mail 5"]);
  });

  test("a large set is summarized in batches and merged, with citations matching list positions", async () => {
    const count = NEW_MAIL_BATCH * 9 + 3;
    const calls = [];
    const progress = [];
    const result = await summarizeInBatches(rowsOf(count), {
      loadExcerpts: loader(new Set([2, 45])), signal, onProgress: item => progress.push(item.phase),
      ask: async (system, payload, options) => {
        calls.push({ system, payload, options });
        return payload.excerpts ? `- ${payload.excerpts.map(item => `[${item.reference}]`).join(" ")}` : `MERGED(${payload.partial_summaries.length})`;
      }
    });
    const batchCalls = calls.filter(call => call.payload.excerpts);
    assert.equal(batchCalls.length, 10);
    assert.ok(batchCalls.every(call => call.options.stream === false && call.payload.excerpts.length <= NEW_MAIL_BATCH));
    const references = batchCalls.flatMap(call => call.payload.excerpts.map(item => item.reference));
    assert.ok(!references.includes("Mail 2") && !references.includes("Mail 45"));
    assert.ok(references.includes("Mail 183"));
    assert.equal(result.shared, count - 2);
    const merges = calls.filter(call => call.payload.partial_summaries);
    assert.equal(merges.length, 3);
    assert.equal(merges.at(-1).options.stream, true);
    assert.equal(merges.filter(call => call.options.stream).length, 1);
    assert.match(result.digest, /^MERGED\(2\)$/);
    assert.ok(progress.includes("reading") && progress.includes("combining"));
  });

  test("stops when aborted", async () => {
    const controller = new AbortController();
    await assert.rejects(summarizeInBatches(rowsOf(100), {
      loadExcerpts: loader(), signal: controller.signal,
      ask: async () => { controller.abort(); return "x"; }
    }));
  });

  test("returns an empty digest when nothing can be shared", async () => {
    const result = await summarizeInBatches(rowsOf(3), { loadExcerpts: async () => [], ask: async () => "no", signal });
    assert.deepEqual(result, { digest: "", shared: 0 });
  });
});

describe("index status", () => {
  test("describes each state", () => {
    assert.equal(describeIndex({ configured: false }).state, "not-set-up");
    assert.equal(describeIndex({ configured: true, error: "boom" }).state, "offline");
    const ready = describeIndex({ configured: true, status: { state: "ready", chunks: 1200, checked_at: null, folders: [{ state: "indexed" }, { state: "indexed" }] } });
    assert.equal(ready.label, "Index: ready");
    assert.match(ready.detail, /2 of 2 folders indexed, 1[.,  ]?200 searchable chunks/);
    const building = describeIndex({ configured: true, status: {
      state: "indexing", chunks: 0, folders: [{ state: "indexed" }, { state: "indexing" }, { state: "pending" }],
      progress: { folders_total: 2, folders_done: 1, current: "Work / Archive", fraction: 0.42, elapsed_seconds: 200 }
    } });
    assert.equal(building.state, "building");
    assert.equal(building.label, "Index: building 42%");
    assert.match(building.detail, /Folder 2 of 2: Work \/ Archive/);
    assert.equal(describeIndex({ configured: true, status: { state: "error", error: "disk full", folders: [] } }).state, "error");
    assert.equal(describeIndex({ configured: true, status: { state: "starting", folders: [] } }).state, "starting");
  });

  test("folder lines", () => {
    assert.match(folderLine({ label: "A / Inbox", state: "indexed", indexed_through: "2026-11-28T10:00:00+00:00" }), /^A \/ Inbox: up to date as of /);
    assert.equal(folderLine({ label: "A / Old", state: "pending", indexed_through: null }), "A / Old: waiting");
    assert.equal(folderLine({ label: "A / X", state: "indexing" }), "A / X: indexing now");
  });
});

describe("quick actions", () => {
  const labels = state => chatActions(state).map(action => action.label);

  test("the row follows the state and never lists disabled actions", () => {
    assert.deepEqual(labels({ hasEmail: false }), ["What's new?", "Find an email", "Write an email"]);
    assert.deepEqual(labels({ hasEmail: true }), ["Summarize", "Action items", "Draft a reply", "Find related emails"]);
    assert.deepEqual(labels({ hasEmail: true, result: "summary" }), ["Draft a reply", "Find related emails"]);
    assert.deepEqual(labels({ hasEmail: true, result: "draft" }), ["Shorter", "More formal", "Friendlier", "Translate"]);
    assert.deepEqual(labels({ hasEmail: true, result: "draft", canUsePastReplies: true }).at(-1), "Use my past replies");
    assert.deepEqual(labels({ hasEmail: false, result: "digest" }), ["What needs a reply?", "Action items from these"]);
    assert.deepEqual(labels({ hasEmail: false, result: "digest", canWiden: true }).at(-1), "Older emails");
    assert.deepEqual(labels({ hasEmail: false, result: "search" }), ["Summarize these", "Show more results"]);
    assert.deepEqual(labels({ hasEmail: true, result: "mailbox" }), []);
  });
});
