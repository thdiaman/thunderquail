function htmlToText(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script, style, template").forEach(node => node.remove());
  template.content.querySelectorAll("br, p, div, li, tr, blockquote").forEach(node => node.after("\n"));
  return template.content.textContent.trim();
}

export async function readEmailContext(sourceTabId) {
  const tab = await browser.tabs.get(sourceTabId);
  const list = tab.type === "mail"
    ? await browser.mailTabs.getSelectedMessages(tab.id)
    : await browser.messageDisplay.getDisplayedMessages(tab.id);
  const messages = list.messages ?? list;
  if (messages.length !== 1 || list.id) {
    throw new Error("Select or open exactly one email in the source tab.");
  }

  const message = messages[0];
  const parts = await browser.messages.listInlineTextParts(message.id);
  const plain = parts.filter(part => part.contentType === "text/plain")
    .map(part => part.content.trim()).filter(Boolean).join("\n\n");
  const body = plain || parts.filter(part => part.contentType === "text/html")
    .map(part => htmlToText(part.content)).filter(Boolean).join("\n\n");
  if (!body) {
    throw new Error("Thunderbird could not find readable email text.");
  }
  const subject = message.subject || "(no subject)";
  const limit = 12000;
  return {
    subject,
    text: `Subject: ${subject}\nFrom: ${message.author ?? ""}\n\n${body.slice(0, limit)}` +
      (body.length > limit ? "\n[Email text truncated]" : "")
  };
}
