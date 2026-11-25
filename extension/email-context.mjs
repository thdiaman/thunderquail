function htmlToText(html, omitQuotes) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script, style, template").forEach(node => node.remove());
  if (omitQuotes) {
    template.content.querySelectorAll("blockquote, .moz-cite-prefix, .moz-forward-container")
      .forEach(node => node.remove());
  }
  template.content.querySelectorAll("br, p, div, li, tr, blockquote").forEach(node => node.after("\n"));
  return template.content.textContent.trim();
}

export async function selectedEmail(tab) {
  if (!tab) {
    return null;
  }
  const list = tab.type === "mail"
    ? await browser.mailTabs.getSelectedMessages(tab.id)
    : await browser.messageDisplay.getDisplayedMessages(tab.id);
  const messages = list.messages ?? list;
  return messages.length === 1 && !list.id ? messages[0] : null;
}

export async function readEmailBody(messageId, { omitQuotes = false } = {}) {
  const parts = await browser.messages.listInlineTextParts(messageId);
  const plain = parts.filter(part => part.contentType === "text/plain")
    .map(part => part.content.trim()).filter(Boolean).join("\n\n");
  const body = plain || parts.filter(part => part.contentType === "text/html")
    .map(part => htmlToText(part.content, omitQuotes)).filter(Boolean).join("\n\n");
  if (!body) {
    throw new Error("Thunderbird could not find readable email text.");
  }
  return body;
}

export async function readEmailContext(message) {
  const body = await readEmailBody(message.id);
  const subject = message.subject || "(no subject)";
  const limit = 12000;
  return {
    subject,
    text: `Subject: ${subject}\nFrom: ${message.author ?? ""}\n\n${body.slice(0, limit)}` +
      (body.length > limit ? "\n[Email text truncated]" : "")
  };
}
