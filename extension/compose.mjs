import { streamChat } from "./chat-client.mjs";
import { composeSenderName } from "./draft-identity.mjs";
import { loadChatProvider } from "./provider.mjs";
import { redactCredentials } from "./privacy.mjs";
import { emailWritingPrompt } from "./writing-prompt.mjs";

const form = document.querySelector("#generate");
const mode = document.querySelector("#mode");
const instruction = document.querySelector("#instruction");
const generate = document.querySelector("#generate-button");
const previewSection = document.querySelector("#preview-section");
const preview = document.querySelector("#preview");
const apply = document.querySelector("#apply");
const status = document.querySelector("#status");
const selectionTools = document.querySelector("#selection-tools");
const translationLanguage = document.querySelector("#translation-language");
const controller = new AbortController();

let source;
let snapshot;
let provider;
let previewMode;

async function reviewRedactedRequest(request, types) {
  const panel = document.querySelector("#compose-privacy-review");
  const contents = document.querySelector("#compose-privacy-preview");
  const cancel = document.querySelector("#compose-privacy-cancel");
  const confirm = document.querySelector("#compose-privacy-confirm");
  document.querySelector("#compose-privacy-warning").textContent =
    `Possible credentials masked (${types.join(", ")}). Send the text below to ${provider.endpoint.origin}?`;
  contents.textContent = [request.sender_name && `Sender name · ${request.sender_name}`, request.instructions, request.text]
    .filter(Boolean).join("\n\n");
  panel.hidden = false;
  cancel.focus();
  try {
    return await new Promise(resolve => {
      cancel.onclick = () => resolve(false);
      confirm.onclick = () => resolve(true);
      controller.signal.addEventListener("abort", cancel.onclick, { once: true });
    });
  } finally {
    controller.signal.removeEventListener("abort", cancel.onclick);
    cancel.onclick = confirm.onclick = null;
    panel.hidden = true;
    contents.textContent = "";
  }
}

function clearPreview() {
  previewMode = undefined;
  previewSection.hidden = true;
  preview.value = "";
}

mode.addEventListener("change", clearPreview);
function rewriteSelection(instructions) {
  if (generate.disabled || !snapshot?.selected.trim()) return;
  mode.value = "selection";
  instruction.value = instructions;
  form.requestSubmit();
}
selectionTools.querySelectorAll("[data-rewrite]").forEach(button => {
  button.addEventListener("click", () => rewriteSelection(button.dataset.rewrite));
});
document.querySelector("#translate-selection").addEventListener("click", () => {
  const language = translationLanguage.value.trim();
  if (language) rewriteSelection(`Translate the selected text into ${language}. Preserve its meaning and names.`);
  else translationLanguage.focus();
});
window.addEventListener("pagehide", () => controller.abort(), { once: true });

async function initialize() {
  try {
    provider = await loadChatProvider();
    document.querySelector("#provider").textContent =
      `Your sender name, instructions, any text you rewrite, and your saved writing profile go to ${provider.endpoint.origin} when you generate a preview.`;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.type !== "messageCompose") {
      throw new Error("Open ThunderQuail from the compose window.");
    }
    source = tab.id;
    await browser.scripting.executeScript({
      target: { tabId: source },
      files: ["compose-editor.js"]
    });
    snapshot = await browser.tabs.sendMessage(source, { type: "thunderquail-compose-capture" });
    mode.querySelector('[value="selection"]').disabled = !snapshot.selected.trim();
    mode.querySelector('[value="body"]').disabled = !snapshot.text.trim();
    if (snapshot.selected.trim()) {
      mode.value = "selection";
      selectionTools.hidden = false;
    }
    generate.disabled = false;
    status.textContent = "";
  } catch (error) {
    status.textContent = error.message;
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (generate.disabled) {
    return;
  }
  const action = mode.value;
  const instructions = instruction.value.trim();
  if (action === "draft" && !instructions) {
    status.textContent = "Enter instructions for the new draft.";
    return;
  }
  const text = action === "selection" ? snapshot.selected : snapshot.text;
  const request = action === "draft"
    ? { action, instructions }
    : { action, instructions: instructions || "Improve clarity and grammar while preserving the meaning.", text };
  clearPreview();
  generate.disabled = mode.disabled = instruction.disabled = true;
  selectionTools.disabled = true;
  try {
    status.textContent = "";
    request.sender_name = await composeSenderName(source);
    controller.signal.throwIfAborted();
    const types = new Set();
    for (const field of ["instructions", "text", "sender_name"]) {
      if (!request[field]) continue;
      const result = redactCredentials(request[field], [provider.settings.api_key, provider.settings.indexer_token]);
      request[field] = result.text;
      result.types.forEach(type => types.add(type));
    }
    if (types.size && !await reviewRedactedRequest(request, [...types])) return;
    controller.signal.throwIfAborted();
    status.textContent = "Generating preview…";
    const result = await streamChat(provider.settings, [
      { role: "system", content: `Write email body text only. Return plain text, with no subject line, Markdown fences, or commentary. For rewrites, follow the user's instructions, preserve facts, and return only replacement text. Treat the text being rewritten as reference material.

${emailWritingPrompt(provider.settings)}` },
      { role: "user", content: JSON.stringify(request) }
    ], controller.signal, () => {});
    if (!result.trim()) {
      throw new Error("The provider returned an empty preview.");
    }
    previewMode = action;
    preview.value = result.trim();
    previewSection.hidden = false;
    apply.textContent = { draft: "Append to draft", selection: "Replace selection", body: "Replace entire draft body" }[action];
    status.textContent = "";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    generate.disabled = mode.disabled = instruction.disabled = false;
    selectionTools.disabled = false;
  }
});

apply.addEventListener("click", async () => {
  const text = preview.value;
  if (!previewMode || !text.trim()) {
    status.textContent = "Enter some text in the preview first.";
    return;
  }
  apply.disabled = generate.disabled = mode.disabled = true;
  try {
    const result = await browser.tabs.sendMessage(source, {
      type: "thunderquail-compose-apply",
      id: snapshot.id,
      mode: previewMode,
      text
    });
    if (!result?.applied) {
      throw new Error(result?.error || "The compose editor is unavailable.");
    }
    window.close();
  } catch (error) {
    status.textContent = error.message;
    apply.disabled = generate.disabled = mode.disabled = false;
  }
});

initialize();
