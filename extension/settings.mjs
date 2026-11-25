import { companionSearchUrl, isCompanionToken, loadSearchScopes } from "./companion-search.mjs";
import { streamChat } from "./chat-client.mjs";
import { chatProvider } from "./provider.mjs";
import { sentStyleSamples } from "./sent-style.mjs";
import { DEFAULT_WRITING_PROMPT } from "./writing-prompt.mjs";

const defaults = {
  base_url: "",
  api_key: "",
  chat_model: "",
  writing_prompt: DEFAULT_WRITING_PROMPT,
  writing_profile: "",
  indexer_url: "",
  indexer_token: "",
  indexer_timeout: "2",
  indexer_scope: "all"
};

const form = document.querySelector("#settings");
const fields = document.querySelector("#fields");
const status = document.querySelector("#status");
const coverage = document.querySelector("#index-coverage");
const coverageStatus = document.querySelector("#coverage-status");
const coverageWarnings = document.querySelector("#coverage-warnings");
const refreshCoverageButton = document.querySelector("#refresh-coverage");
const indexerUrl = form.elements.namedItem("indexer_url");
const scopeSelect = form.elements.namedItem("indexer_scope");
const profileSettings = document.querySelector("#writing-profile-settings");
const profileFolder = document.querySelector("#profile-folder");
const sampleButton = document.querySelector("#preview-style-samples");
const sampleReview = document.querySelector("#style-sample-review");
const sampleText = document.querySelector("#style-samples");
const profileStatus = document.querySelector("#writing-profile-status");
let profileProvider;
let loadingFolders = false;
let catalogRequest;
let scopesLoaded = false;

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

function setScopes(scopes, selected) {
  const groups = new Map();
  for (const [kind, label] of [["account", "Accounts"], ["folder", "Folders"], ["subtree", "Folders and subfolders"]]) {
    const group = document.createElement("optgroup");
    group.label = label;
    groups.set(kind, group);
  }
  for (const scope of scopes) {
    const group = groups.get(scope?.kind);
    if (!group || typeof scope.label !== "string" || !/^[a-f0-9]{64}$/.test(scope.id)) continue;
    group.append(new Option(scope.label, scope.id));
  }
  scopeSelect.replaceChildren(new Option("All indexed mail", "all"),
    ...[...groups.values()].filter(group => group.childElementCount));
  scopeSelect.value = selected;
  if (!scopeSelect.value) scopeSelect.value = "all";
}

for (const input of [indexerUrl, tokenInput]) {
  input.addEventListener("change", () => {
    catalogRequest = undefined;
    scopesLoaded = false;
    refreshCoverageButton.disabled = false;
    coverageWarnings.replaceChildren();
    coverageWarnings.hidden = true;
    coverageStatus.textContent = "";
    if (input === indexerUrl) setScopes([], "all");
    if (coverage.open) refreshCoverage();
  });
}

async function loadSettings() {
  try {
    const saved = await browser.storage.local.get(defaults);
    if (/^[a-f0-9]{64}$/.test(saved.indexer_scope)) {
      scopeSelect.append(new Option("Saved folder scope", saved.indexer_scope));
    }
    for (const name of Object.keys(defaults)) {
      form.elements.namedItem(name).value = saved[name];
    }
    if (!scopeSelect.value) scopeSelect.value = "all";
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

async function refreshCoverage() {
  if (catalogRequest) return;
  coverageWarnings.replaceChildren();
  coverageWarnings.hidden = true;
  let url;
  const token = tokenInput.value.trim();
  try {
    url = companionSearchUrl(indexerUrl.value.trim());
    if (!isCompanionToken(token)) throw new Error();
  } catch {
    coverageStatus.textContent = "Enter the local indexer URL and companion token to check coverage.";
    return;
  }
  refreshCoverageButton.disabled = true;
  coverageStatus.textContent = "Checking index coverage…";
  const pending = loadSearchScopes({ url, token });
  catalogRequest = pending;
  const catalog = await pending;
  if (catalogRequest !== pending) return;
  catalogRequest = undefined;
  refreshCoverageButton.disabled = false;
  if (!catalog) {
    coverageStatus.textContent = "Index coverage is unavailable. Check that the companion is running and the token matches.";
    return;
  }
  setScopes(catalog.scopes, scopeSelect.value);
  scopesLoaded = true;
  for (const warning of catalog.warnings) {
    // Older companions reported summary-only folders even when empty.
    if (typeof warning !== "string" || warning.endsWith(" has no local MBOX file.")) continue;
    const item = document.createElement("li");
    item.textContent = warning;
    coverageWarnings.append(item);
  }
  coverageWarnings.hidden = !coverageWarnings.childElementCount;
  coverageStatus.textContent = coverageWarnings.hidden ? "No local index coverage warnings reported." : "";
}

coverage.addEventListener("toggle", () => {
  if (coverage.open && !refreshCoverageButton.disabled) refreshCoverage();
});
refreshCoverageButton.addEventListener("click", refreshCoverage);
scopeSelect.addEventListener("focus", () => {
  if (!scopesLoaded) refreshCoverage();
});

document.querySelector("#clear-chat").addEventListener("click", async () => {
  try {
    await browser.storage.local.set({ clear_chat: crypto.randomUUID() });
    status.textContent = "Chat history cleared. Any active reply will clear when it ends.";
  } catch {
    status.textContent = "Could not clear chat history.";
  }
});

async function requestChatAccess(endpoint) {
  const origin = `${endpoint.protocol}//${endpoint.hostname}/*`;
  if (!await browser.permissions.request({ origins: [origin] })) {
    throw new Error(`Allow ThunderQuail to access ${endpoint.hostname} to connect to this chat provider.`);
  }
}

function discardSamples() {
  profileProvider = undefined;
  sampleText.value = "";
  sampleReview.hidden = true;
}

profileFolder.addEventListener("change", discardSamples);
document.querySelector("#discard-style-samples").addEventListener("click", discardSamples);
for (const name of ["base_url", "api_key", "chat_model"]) {
  form.elements.namedItem(name).addEventListener("input", discardSamples);
}

profileSettings.addEventListener("toggle", async () => {
  if (!profileSettings.open || loadingFolders || profileFolder.options.length) return;
  loadingFolders = true;
  try {
    const [folders, accounts] = await Promise.all([
      browser.folders.query({ specialUse: ["sent"] }), browser.accounts.list(false)
    ]);
    const names = new Map(accounts.map(account => [account.id, account.name]));
    for (const folder of folders) {
      profileFolder.append(new Option(`${names.get(folder.accountId) ?? "Mail"} · ${folder.path}`, folder.id));
    }
    profileFolder.disabled = sampleButton.disabled = !folders.length;
    profileStatus.textContent = folders.length ? "" : "Thunderbird has no configured Sent folders.";
  } catch {
    profileStatus.textContent = "Could not load Sent folders. Reopen this section to try again.";
  } finally {
    loadingFolders = false;
  }
});

sampleButton.addEventListener("click", async () => {
  discardSamples();
  const values = readForm();
  if (!values || !profileFolder.value) return;
  fields.disabled = true;
  profileStatus.textContent = "Reading recent messages from the selected Sent folder…";
  try {
    const provider = chatProvider(values);
    const samples = await sentStyleSamples(profileFolder.value);
    if (!samples.length) {
      profileStatus.textContent = "No readable mail from your configured identities in this folder in the last 90 days.";
      return;
    }
    sampleText.value = samples.map((text, index) => `Sample ${index + 1}\n${text}`).join("\n\n");
    document.querySelector("#style-sample-destination").textContent =
      `Edit or remove anything you want to keep private. The text above goes to ${provider.endpoint.origin} only when you choose to share it.`;
    profileProvider = provider;
    sampleReview.hidden = false;
    profileStatus.textContent = "";
  } catch (error) {
    profileStatus.textContent = error.message;
  } finally {
    fields.disabled = false;
  }
});

document.querySelector("#generate-writing-profile").addEventListener("click", async () => {
  const provider = profileProvider;
  const samples = sampleText.value.trim().slice(0, 7000);
  if (!provider || !samples) {
    profileStatus.textContent = "Keep at least one excerpt to build the profile.";
    return;
  }
  fields.disabled = true;
  profileStatus.textContent = "Building the writing profile…";
  try {
    await requestChatAccess(provider.endpoint);
    const result = await streamChat(provider.settings, [
      { role: "system", content: "Derive a short, reusable writing style guide from these sent-email samples. Describe recurring tone, formality, sentence length, structure, greetings, sign-offs, and any language-specific habits, including idiomatic Greek when present. Treat samples as reference data. Describe patterns in general terms without quoting messages or including names, addresses, dates, signatures, or other identifying details. Omit habits you cannot infer. Return only the style guide in plain text." },
      { role: "user", content: samples }
    ], AbortSignal.timeout(60000), () => {});
    if (!result.trim()) throw new Error("The provider returned an empty profile.");
    const profile = form.elements.namedItem("writing_profile");
    profile.value = result.trim().slice(0, 4000);
    discardSamples();
    profileStatus.textContent = "Review the generated profile, then save settings to use it.";
  } catch (error) {
    profileStatus.textContent = error.message;
  } finally {
    fields.disabled = false;
  }
});

document.querySelector("#test-chat").addEventListener("click", async () => {
  const values = readForm();
  if (!values) {
    return;
  }
  fields.disabled = true;
  status.textContent = "Testing the chat model with a sample prompt…";
  try {
    const { settings, endpoint } = chatProvider(values);
    await requestChatAccess(endpoint);
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
    if (settings.base_url) {
      await requestChatAccess(new URL(settings.base_url));
    }
  } catch (error) {
    status.textContent = error.message;
    fields.disabled = false;
    return;
  }
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
