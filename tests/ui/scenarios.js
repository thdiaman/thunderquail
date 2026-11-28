(() => {
  const params = new URLSearchParams(location.search);
  const name = params.get("scenario");
  if (!name) return;
  const checks = [];
  const check = (label, ok, detail = "") => checks.push({ label, ok: Boolean(ok), detail: String(detail).slice(0, 400) });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const $ = selector => document.querySelector(selector);
  const texts = nodes => [...nodes].map(node => node.textContent.trim());
  const actions = () => texts($("#quick-actions").querySelectorAll("button"));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const button = label => [...document.querySelectorAll("button")].find(item => item.textContent.trim().startsWith(label));

  async function waitFor(fn, label, timeout = 25000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        const value = await fn();
        if (value) return value;
      } catch { /* keep waiting */ }
      await sleep(50);
    }
    check(`timeout: ${label}`, false);
    throw new Error(`timeout: ${label}`);
  }

  const ask = text => {
    $("#prompt").value = text;
    $("#prompt").dispatchEvent(new Event("input"));
    $("#chat-form").requestSubmit();
  };
  const indexLabel = () => $("#index-label").textContent;

  const scenarios = {
    async layout() {
      await waitFor(() => indexLabel() === "Index: ready", `index ready (now: ${indexLabel()})`);
      check("no Mail menu", !$("#mail-menu") && !$("#mail-menu-button") && !$("[data-mail-action]"));
      check("fixed header controls", $("#index-status") && $("#new-chat") && $("#settings"));
      check("index indicator is not a checkbox", !$("#search-index"));
      check("context line without an email", $("#context-subject").textContent === "No email selected", $("#context-subject").textContent);
      check("context controls always present",
        ["#attachment-scope", "#preview-attachment", "#sync-email", "#remove-attachment", "#exclude-attachment"]
          .every(selector => $(selector) && getComputedStyle($(selector)).display !== "none"));
      check("action row for a fresh chat", same(actions(), ["What's new?", "Find an email", "Write an email"]), actions());
      check("example prompts are shown", getComputedStyle($(".chat-empty")).display !== "none");
      check("action row has no disabled buttons", ![...$("#quick-actions").querySelectorAll("button")].some(item => item.disabled));
      $("#index-status").click();
      await waitFor(() => $("#index-panel").matches(":popover-open"), "index panel opens");
      await waitFor(() => $("#index-folders").children.length >= 3, "folder lines");
      const lines = texts($("#index-folders").children);
      check("folder coverage lines", lines.some(line => line.includes("/ Inbox: up to date")), lines);
      check("panel detail", /3 of 3 folders indexed/.test($("#index-detail").textContent), $("#index-detail").textContent);
      $("#index-rescan").click();
      await waitFor(() => $("#index-rescan-status").textContent.startsWith("Requested"), "rescan requested");
      check("rescan answered", true, $("#index-rescan-status").textContent);
    },

    async whatsnew() {
      await waitFor(() => actions().includes("What's new?"), "action row");
      button("What's new?").click();
      await waitFor(() => $(".mail-results"), "card");
      const note = $(".reply-result").textContent;
      check("counts every unread email", /^62 unread emails in 1 folder/.test(note), note);
      check("lists 20 and offers all", $(".mail-results").children.length === 20 && button("Show all 62"));
      check("offers to narrow a large result", button("Last 24 hours") && button("Last 7 days"));
      check("discloses what is shared", document.body.textContent.includes("Summarizing shares each email"));
      button("Show all 62").click();
      check("show all lists everything", $(".mail-results").children.length === 62, $(".mail-results").children.length);
      button("Summarize all 62").click();
      await waitFor(() => document.body.textContent.includes("Covered 62 of 62"), "digest", 40000);
      const calls = window.__llmCalls;
      check("four batches", calls.filter(call => call.system.startsWith("Summarize each")).length === 4,
        calls.map(call => call.system.slice(0, 12)).join("|"));
      check("one merge", calls.filter(call => call.system.startsWith("Combine the partial")).length === 1);
      check("digest shown", document.body.textContent.includes("merged 4 parts"));
      const refs = calls.flatMap(call => call.refs ?? []);
      check("citations match list positions", refs.includes("Mail 62") && !refs.includes("Mail 63") && refs.length === 62, refs.length);
      await waitFor(() => same(actions(), ["What needs a reply?", "Action items from these"]), `follow-ups (now ${actions()})`);
    },

    async narrow() {
      await waitFor(() => actions().includes("What's new?"), "action row");
      button("What's new?").click();
      await waitFor(() => button("Last 7 days"), "narrowing chip");
      button("Last 7 days").click();
      await waitFor(() => /unread emails since/.test($(".reply-result").textContent), "narrowed card");
      const count = Number($(".reply-result").textContent.match(/^(\d+)/)[1]);
      check("fewer emails after narrowing", count > 0 && count < 62, $(".reply-result").textContent);
      check("one card, reused", document.querySelectorAll(".assistant-turn").length === 1);
    },

    async search() {
      await waitFor(() => indexLabel() === "Index: ready", "index ready");
      ask("Find the email about the invoice");
      await waitFor(() => !$("#confirm-sharing").hidden, "sharing review");
      const preview = $("#sharing-preview").textContent;
      check("index result is offered", preview.includes("Invoice for the garden project"), preview.slice(0, 160));
      check("new mail the index lacks is offered", preview.includes("Invoice reminder: second notice"), preview.slice(0, 400));
      $("#allow-sharing").click();
      await waitFor(() => document.body.textContent.includes("Found it"), "answer");
      const tool = window.__llmCalls.find(call => call.role === "tool");
      check("assistant told what the search covered", tool && /coverage/.test(tool.last) && /index is current through/.test(tool.last), tool?.last.slice(-300));
      const details = $(".context-details").textContent;
      check("coverage visible to the user", /matched directly in Thunderbird/.test(details), details);
      check("row after a search", same(actions(), ["Summarize these", "Show more results"]), actions());
    },

    async email() {
      await waitFor(() => indexLabel() === "Index: ready", "index ready");
      window.__selected = window.__data.messages[0];
      window.__fire("mailSelection", { windowId: 1 });
      await waitFor(() => $("#context-subject").textContent === "Reading: Invoice for the garden project", "email attached");
      check("action row with an email", same(actions(), ["Summarize", "Action items", "Draft a reply", "Find related emails"]), actions());
      button("Summarize").click();
      await waitFor(() => same(actions(), ["Draft a reply", "Find related emails"]), `summary follow-ups (now ${actions()})`);
      button("Find related emails").click();
      await waitFor(() => $(".mail-results"), "related results");
      const titles = texts(document.querySelectorAll(".mail-results button"));
      check("related mail includes new mail the index lacks", titles.some(title => title.includes("Invoice reminder")), titles);
      check("the email itself is not listed", !titles.some(title => title === "Invoice for the garden project"), titles);
    },

    async offline() {
      await waitFor(() => indexLabel() === "Index: offline", `offline label (now ${indexLabel()})`);
      check("explains the fallback", /Thunderbird directly/.test($("#index-detail").textContent), $("#index-detail").textContent);
      ask("Find the email about the invoice");
      await waitFor(() => !$("#confirm-sharing").hidden, "sharing review");
      const preview = $("#sharing-preview").textContent;
      check("Thunderbird search finds both", preview.includes("Invoice for the garden project") && preview.includes("Invoice reminder"), preview.slice(0, 300));
      $("#allow-sharing").click();
      await waitFor(() => document.body.textContent.includes("Found it"), "answer");
      check("says no index was used", /No local index was used/.test($(".context-details").textContent), $(".context-details").textContent);
    },

    async composeEmpty() {
      await waitFor(() => !$("#generate-button").disabled, "compose ready");
      const options = [...$("#mode").options].map(option => option.value);
      check("only drafting is offered for an empty draft", same(options, ["draft"]), options);
      check("no disabled options", ![...$("#mode").options].some(option => option.disabled));
      check("selection tools are not shown", $("#selection-tools").hidden);
    },

    async composeSelection() {
      await waitFor(() => !$("#generate-button").disabled, "compose ready");
      const options = [...$("#mode").options].map(option => option.value);
      check("rewrite options offered with a selection", same(options, ["draft", "selection", "body"]), options);
      check("no disabled options", ![...$("#mode").options].some(option => option.disabled));
      check("selection tools shown", !$("#selection-tools").hidden && $("#mode").value === "selection");
    },

    async measure() {
      await waitFor(() => indexLabel() === "Index: ready", "ready");
      const wide = [...document.querySelectorAll("body *")].filter(node => node.getBoundingClientRect().right > innerWidth + 1)
        .map(node => `${node.tagName.toLowerCase()}#${node.id}.${node.className} right=${Math.round(node.getBoundingClientRect().right)}`);
      check(`no horizontal overflow (inner ${innerWidth}, scroll ${document.documentElement.scrollWidth})`, document.documentElement.scrollWidth <= innerWidth, wide.slice(0, 8).join(" | "));
    },

    async notsetup() {
      await waitFor(() => indexLabel() === "Index: not set up", `label (now ${indexLabel()})`);
      check("still offers actions", same(actions(), ["What's new?", "Find an email", "Write an email"]), actions());
      $("#index-status").click();
      await waitFor(() => $("#index-panel").matches(":popover-open"), "panel");
      check("rescan hidden when not set up", $("#index-rescan").hidden);
    }
  };

  window.addEventListener("load", async () => {
    try {
      await scenarios[name]();
    } catch (error) {
      check(`exception: ${error.message}`, false);
    }
    const result = document.createElement("pre");
    result.id = "__result";
    result.textContent = JSON.stringify({ scenario: name, ok: checks.every(item => item.ok), checks });
    document.body.append(result);
  });
})();
