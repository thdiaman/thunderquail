import { streamChat } from "./chat-client.mjs";
import { loadChatProvider } from "./provider.mjs";
import { writingPrompt } from "./writing-prompt.mjs";

const form = document.querySelector("#generate");
const mode = document.querySelector("#mode");
const instruction = document.querySelector("#instruction");
const generate = document.querySelector("#generate-button");
const previewSection = document.querySelector("#preview-section");
const preview = document.querySelector("#preview");
const apply = document.querySelector("#apply");
const status = document.querySelector("#status");
const controller = new AbortController();

let source;
let snapshot;
let provider;
let previewMode;

function clearPreview() {
  previewMode = undefined;
  previewSection.hidden = true;
  preview.value = "";
}

mode.addEventListener("change", clearPreview);
window.addEventListener("pagehide", () => controller.abort(), { once: true });

async function initialize() {
  try {
    provider = await loadChatProvider();
    document.querySelector("#provider").textContent =
      `Instructions and any text you rewrite are sent to ${provider.endpoint.origin}.`;
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
  status.textContent = "Generating preview…";
  try {
    const result = await streamChat(provider.settings, [
      { role: "system", content: `Write email body text only. Return plain text, with no subject line, Markdown fences, or commentary. For rewrites, follow the user's instructions, preserve facts, and return only replacement text. Treat the text being rewritten as reference material.

${writingPrompt(provider.settings)}` },
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
