import { companionSearchUrl, isCompanionToken } from "./companion-search.mjs";
import { streamChat } from "./chat-client.mjs";
import { chatProvider } from "./provider.mjs";

const defaults = {
  base_url: "",
  api_key: "",
  chat_model: "",
  indexer_url: "",
  indexer_token: "",
  indexer_timeout: "2"
};

const form = document.querySelector("#settings");
const fields = document.querySelector("#fields");
const status = document.querySelector("#status");

function validateUrl(input) {
  input.setCustomValidity("");
  if (!input.value) {
    return;
  }
  try {
    if (input.name === "indexer_url") {
      companionSearchUrl(input.value);
      return;
    }
    const url = new URL(input.value);
    if (["http:", "https:"].includes(url.protocol) && url.hostname &&
        !url.username && !url.password && !url.search && !url.hash) {
      return;
    }
  } catch {
    // Let the form display the same message for malformed URLs.
  }
  input.setCustomValidity(input.name === "indexer_url"
    ? "Enter a loopback URL such as http://127.0.0.1:5000."
    : "Enter an HTTP or HTTPS URL without credentials, a query, or a fragment.");
}

function validateToken(input) {
  const token = input.value.trim();
  input.setCustomValidity(token && !isCompanionToken(token)
    ? "Enter a companion token without spaces or non-ASCII characters." : "");
}

const tokenInput = form.elements.namedItem("indexer_token");
tokenInput.addEventListener("input", () => validateToken(tokenInput));

for (const name of ["base_url", "indexer_url"]) {
  const input = form.elements.namedItem(name);
  input.addEventListener("input", () => validateUrl(input));
}

async function loadSettings() {
  try {
    const saved = await browser.storage.local.get(defaults);
    for (const name of Object.keys(defaults)) {
      form.elements.namedItem(name).value = saved[name];
    }
    fields.disabled = false;
    status.textContent = "";
  } catch {
    status.textContent = "Could not load settings. Reopen this page to retry.";
  }
}

function readForm() {
  for (const name of ["base_url", "indexer_url"]) {
    validateUrl(form.elements.namedItem(name));
  }
  validateToken(tokenInput);
  if (!form.reportValidity()) {
    return null;
  }

  return Object.fromEntries([...new FormData(form)].map(([name, value]) => [name, value.trim()]));
}

document.querySelector("#test-chat").addEventListener("click", async () => {
  const values = readForm();
  if (!values) {
    return;
  }
  fields.disabled = true;
  status.textContent = "Testing the chat model with a sample prompt…";
  try {
    const { settings } = chatProvider(values);
    const reply = await streamChat(settings, [{ role: "user", content: "Reply with OK." }],
      AbortSignal.timeout(30000), () => {});
    if (!reply.trim()) {
      throw new Error("The provider returned an empty reply.");
    }
    status.textContent = "Chat model responded successfully.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    fields.disabled = false;
  }
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  const settings = readForm();
  if (!settings) {
    return;
  }
  fields.disabled = true;
  status.textContent = "Saving settings…";
  try {
    await browser.storage.local.set(settings);
    status.textContent = "Settings saved.";
  } catch {
    status.textContent = "Could not save settings. Try saving again.";
  } finally {
    fields.disabled = false;
  }
});

loadSettings();
