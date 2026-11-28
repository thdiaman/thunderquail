// A mock Thunderbird `browser`, a mock chat provider, and a same-origin route to the real companion.
(() => {
  const params = new URLSearchParams(location.search);
  const request = new XMLHttpRequest();
  request.open("GET", "/__data.json", false);
  request.send();
  const data = JSON.parse(request.responseText);
  window.__data = data;
  window.__llmCalls = [];
  window.__opened = [];
  window.__selected = null;

  const listeners = {};
  const event = name => ({ addListener: fn => (listeners[name] ??= []).push(fn), removeListener() {} });
  window.__fire = (name, ...args) => (listeners[name] ?? []).forEach(fn => fn(...args));

  const folderOf = id => data.folders.find(folder => folder.id === id);
  const header = message => ({
    id: message.id, headerMessageId: message.headerMessageId, subject: message.subject, author: message.author,
    date: new Date(message.date), read: message.read, folder: { ...folderOf(message.folderId), isVirtual: false, isUnified: false },
    recipients: ["me@example.com"], ccList: [], bccList: []
  });
  const matches = (message, query) => {
    const ids = query.folderId === undefined ? null : [].concat(query.folderId);
    if (ids && !ids.includes(message.folderId)) return false;
    if (query.read !== undefined && message.read !== query.read) return false;
    const when = new Date(message.date);
    if (query.fromDate && !(when > query.fromDate)) return false;
    if (query.toDate && !(when < query.toDate)) return false;
    if (query.author && !message.author.toLowerCase().includes(query.author.toLowerCase())) return false;
    if (query.fullText && !`${message.subject} ${message.body} ${message.author}`.toLowerCase().includes(query.fullText.toLowerCase())) return false;
    return true;
  };
  const lists = new Map();
  let nextList = 0;
  const page = (found, offset = 0) => {
    const more = offset + 100 < found.length;
    const id = more ? `list${++nextList}` : null;
    if (id) lists.set(id, { found, offset: offset + 100 });
    return { id, messages: found.slice(offset, offset + 100).map(header) };
  };

  const port = params.get("cport");
  const configured = port !== "none";
  const stored = {
    base_url: "http://mock-llm/v1", chat_model: "mock", api_key: "",
    indexer_url: configured ? `http://127.0.0.1:${port}` : "", indexer_token: configured ? "t".repeat(43) : "",
    indexer_timeout: "5", indexer_scope: "all", auto_attach_email: true
  };
  const accounts = data.accounts.map(account => ({ ...account, rootFolder: { id: `root-${account.id}`, accountId: account.id, isRoot: true, path: "/" } }));

  window.browser = {
    tabs: {
      query: async () => [{ id: 1, type: params.get("tabtype") ?? "mail", windowId: 1, active: true }],
      get: async () => ({ id: 1, type: "mail", windowId: 1 }),
      onActivated: event("tabsActivated"),
      sendMessage: async () => ({ id: "s1", selected: params.get("sel") ? "Some selected text" : "", text: params.get("body") || params.get("sel") ? "Body text" : "", applied: true })
    },
    mailTabs: {
      getSelectedMessages: async () => ({ id: null, messages: window.__selected ? [header(window.__selected)] : [] }),
      onSelectedMessagesChanged: event("mailSelection")
    },
    messageDisplay: {
      getDisplayedMessages: async () => [], onMessagesDisplayed: event("messagesDisplayed"),
      open: async options => { window.__opened.push(options); }
    },
    quailOverlay: { toggle: async () => {}, getThread: async id => ({ ids: [id], total: 1, headerIds: [] }) },
    runtime: { openOptionsPage: async () => {} },
    storage: {
      local: {
        get: async keys => {
          if (keys === null) return { ...stored };
          if (typeof keys === "string") return keys in stored ? { [keys]: stored[keys] } : {};
          return { ...keys, ...Object.fromEntries(Object.keys(keys).filter(key => key in stored).map(key => [key, stored[key]])) };
        },
        set: async values => { Object.assign(stored, values); }, remove: async key => { delete stored[key]; }
      },
      onChanged: event("storageChanged")
    },
    folders: {
      query: async (query = {}) => data.folders.filter(folder => !query.specialUse || query.specialUse.some(use => folder.specialUse.includes(use)))
        .map(folder => ({ ...folder, isVirtual: false, isUnified: false })),
      getFolderCapabilities: async () => ({ canDeleteMessages: true })
    },
    accounts: { list: async () => accounts, get: async id => accounts.find(account => account.id === id) },
    identities: { get: async () => ({ name: "Me" }) },
    messages: {
      get: async id => header(data.messages.find(message => message.id === id)),
      query: async query => page(data.messages.filter(message => matches(message, query))),
      continueList: async id => { const list = lists.get(id); return page(list.found, list.offset); },
      abortList: async id => { lists.delete(id); },
      listInlineTextParts: async id => [{ contentType: "text/plain", content: data.messages.find(message => message.id === id).body }],
      move: async () => {}
    },
    compose: { getComposeDetails: async () => ({ identityId: "id1" }) }, scripting: { executeScript: async () => [] }, permissions: { request: async () => true }
  };

  const realFetch = window.fetch.bind(window);
  const sse = (events) => new Response(new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const item of events) {
        controller.enqueue(encoder.encode(`data: ${typeof item === "string" ? item : JSON.stringify(item)}\n\n`));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      controller.close();
    }
  }), { headers: { "Content-Type": "text/event-stream" } });

  function llm(init) {
    const body = JSON.parse(init.body);
    const messages = body.messages;
    const system = typeof messages[0].content === "string" ? messages[0].content : "";
    const last = messages.at(-1);
    const record = { system: system.slice(0, 60), role: last.role, tools: (body.tools ?? []).map(tool => tool.function.name),
      last: typeof last.content === "string" ? last.content.slice(0, 4000) : "" };
    let payload;
    try { payload = JSON.parse(last.content); } catch { payload = null; }
    let text = "Hello.";
    let tool;
    if (system.startsWith("Summarize each supplied email")) {
      record.refs = payload.excerpts.map(item => item.reference);
      text = payload.excerpts.map(item => `- [${item.reference}] ${item.subject}`).join("\n");
    } else if (system.startsWith("Combine the partial summaries")) {
      text = `Needs your attention:\n- merged ${payload.partial_summaries.length} parts`;
    } else if (system.startsWith("Write a digest")) {
      record.refs = payload.excerpts.map(item => item.reference);
      text = `Digest of ${payload.excerpts.length} emails`;
    } else if (last.role === "tool") {
      text = "Found it: see [Mail 1].";
    } else {
      const question = String(payload?.request ?? last.content);
      const names = record.tools;
      if (/invoice/i.test(question) && names.includes("search_mail")) tool = { name: "search_mail", arguments: JSON.stringify({ query: "invoice" }) };
      else if (/what'?s new|unread/i.test(question) && names.includes("list_new_mail")) tool = { name: "list_new_mail", arguments: JSON.stringify({ unread: true }) };
    }
    window.__llmCalls.push(record);
    if (tool) {
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call1", type: "function", function: tool }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] }, "[DONE]"]);
    }
    return sse([{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
  }

  window.fetch = (input, init = {}) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url, location.href);
    if (url.host === "mock-llm") return Promise.resolve(llm(init));
    if (url.host === "127.0.0.1:49998") return realFetch(`/__companion${url.pathname}`, { method: init.method, body: init.body, signal: init.signal });
    return realFetch(input, init);
  };
})();
