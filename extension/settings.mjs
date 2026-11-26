import { companionSearchUrl, isCompanionToken, loadSearchScopes } from "./companion-search.mjs";
import { streamChat } from "./chat-client.mjs";
import { chatProvider } from "./provider.mjs";
import { excludeEmails, loadExcludedEmails, redactCredentials, removeExcludedEmail } from "./privacy.mjs";
import { SAMPLE_LENGTH, sentStyleSamples } from "./sent-style.mjs";
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
const profileFolders = document.querySelector("#profile-folders");
const sampleButton = document.querySelector("#preview-style-samples");
const sampleReview = document.querySelector("#style-sample-review");
const sampleList = document.querySelector("#style-samples");
const generateProfile = document.querySelector("#generate-writing-profile");
const profileStatus = document.querySelector("#writing-profile-status");
let profileProvider;
let loadingFolders = false;
const folderLabels = new Map();
const privacySettings = document.querySelector("#privacy-settings");
const excludedList = document.querySelector("#excluded-emails");
const privacyStatus = document.querySelector("#privacy-status");
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
  sampleList.replaceChildren();
  sampleReview.hidden = true;
}

async function refreshExclusions() {
  try {
    const excluded = await loadExcludedEmails();
    excludedList.replaceChildren();
    privacyStatus.textContent = excluded.size ? "" : "No email exclusions.";
    for (const [identity, subject] of excluded) {
      const item = document.createElement("li");
      const restore = document.createElement("button");
      restore.type = "button";
      restore.textContent = "Remove exclusion";
      restore.addEventListener("click", async () => {
        restore.disabled = true;
        try {
          await removeExcludedEmail(identity);
          await refreshExclusions();
        } catch {
          restore.disabled = false;
          privacyStatus.textContent = "Could not remove the exclusion. Try again.";
        }
      });
      item.append(subject, " ", restore);
      excludedList.append(item);
    }
  } catch {
    privacyStatus.textContent = "Could not load email exclusions.";
  }
}

privacySettings.addEventListener("toggle", () => {
  if (privacySettings.open) refreshExclusions();
});

function selectedSentFolders() {
  return [...profileFolders.querySelectorAll("input:checked")].map(input => input.value);
}

profileFolders.addEventListener("change", () => {
  discardSamples();
  sampleButton.disabled = selectedSentFolders().length === 0;
  profileStatus.textContent = sampleButton.disabled ? "Select at least one Sent folder." : "";
});
document.querySelector("#discard-style-samples").addEventListener("click", discardSamples);
for (const name of ["base_url", "api_key", "chat_model"]) {
  form.elements.namedItem(name).addEventListener("input", discardSamples);
}

profileSettings.addEventListener("toggle", async () => {
  if (!profileSettings.open || loadingFolders || folderLabels.size) return;
  loadingFolders = true;
  try {
    const [folders, accounts] = await Promise.all([
      browser.folders.query({ specialUse: ["sent"] }), browser.accounts.list(false)
    ]);
    const names = new Map(accounts.map(account => [account.id, account.name]));
    const groups = new Map();
    for (const folder of folders) {
      const account = names.get(folder.accountId) ?? "Mail";
      if (!groups.has(folder.accountId)) {
        const group = document.createElement("fieldset");
        const heading = document.createElement("legend");
        heading.textContent = account;
        group.append(heading);
        profileFolders.append(group);
        groups.set(folder.accountId, group);
      }
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.value = folder.id;
      label.append(checkbox, ` ${folder.path}`);
      groups.get(folder.accountId).append(label);
      folderLabels.set(folder.id, `${account} · ${folder.path}`);
    }
    sampleButton.disabled = !folders.length;
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
  const selected = selectedSentFolders();
  if (!values || !selected.length) return;
  fields.disabled = true;
  profileStatus.textContent = "Reading recent messages from the selected Sent folders…";
  try {
    const provider = chatProvider(values);
    const samples = await sentStyleSamples(selected, await loadExcludedEmails());
    if (!samples.length) {
      profileStatus.textContent = "No usable excerpts from your configured identities in the selected folders in the last 90 days.";
      return;
    }
    const secrets = [provider.settings.api_key, provider.settings.indexer_token];
    let redactedSamples = false;
    for (const { folderId, identity, subject, text } of samples) {
      const entry = document.createElement("div");
      const label = document.createElement("label");
      const excerpt = document.createElement("textarea");
      const remove = document.createElement("button");
      const exclude = document.createElement("button");
      const redacted = redactCredentials(text, secrets);
      redactedSamples ||= redacted.types.length > 0;
      entry.dataset.identity = identity;
      excerpt.rows = 4;
      excerpt.maxLength = SAMPLE_LENGTH;
      excerpt.value = redacted.text;
      label.append(folderLabels.get(folderId), excerpt);
      remove.type = "button";
      remove.textContent = "Remove excerpt";
      function removeEntry() {
        const next = entry.nextElementSibling ?? entry.previousElementSibling;
        entry.remove();
        const remaining = sampleList.childElementCount;
        generateProfile.disabled = remaining === 0;
        (next?.querySelector("textarea") ?? sampleButton).focus();
        if (!remaining) discardSamples();
      }
      remove.addEventListener("click", removeEntry);
      exclude.type = "button";
      exclude.textContent = "Never share this email";
      exclude.addEventListener("click", async () => {
        fields.disabled = true;
        try {
          await excludeEmails([{ identity, subject: redactCredentials(subject || "", secrets).text }]);
          if (privacySettings.open) await refreshExclusions();
          profileStatus.textContent = "Email excluded from future sharing.";
        } catch {
          profileStatus.textContent = "Could not save the exclusion. Try again.";
          return;
        } finally {
          fields.disabled = false;
        }
        removeEntry();
      });
      entry.append(label, remove, exclude);
      sampleList.append(entry);
    }
    generateProfile.disabled = false;
    document.querySelector("#style-sample-destination").textContent =
      `Edit or remove any excerpt before sharing. Only the excerpt text goes to ${provider.endpoint.origin}.`;
    profileProvider = provider;
    sampleReview.hidden = false;
    profileStatus.textContent = redactedSamples ? "Possible credentials were masked. Review the excerpts before sharing." : "";
  } catch (error) {
    profileStatus.textContent = error.message;
  } finally {
    fields.disabled = false;
  }
});

generateProfile.addEventListener("click", async () => {
  const provider = profileProvider;
  if (!provider || !sampleList.childElementCount) {
    profileStatus.textContent = "Keep at least one excerpt to build the profile.";
    return;
  }
  fields.disabled = true;
  profileStatus.textContent = "Building the writing profile…";
  try {
    await requestChatAccess(provider.endpoint);
    const excluded = await loadExcludedEmails();
    const excerpts = [];
    let newlyRedacted = false;
    for (const entry of sampleList.children) {
      if (excluded.has(entry.dataset.identity)) continue;
      const excerpt = entry.querySelector("textarea");
      const clean = redactCredentials(excerpt.value.trim(), [provider.settings.api_key, provider.settings.indexer_token]);
      if (clean.types.length) {
        excerpt.value = clean.text;
        newlyRedacted = true;
      }
      if (clean.text) excerpts.push(clean.text);
    }
    if (newlyRedacted) {
      profileStatus.textContent = "Possible credentials were masked. Review the changes before sharing.";
      return;
    }
    if (!excerpts.length) {
      profileStatus.textContent = "Keep at least one non-excluded excerpt to build the profile.";
      return;
    }
    const result = await streamChat(provider.settings, [
      { role: "system", content: "Derive a short, reusable writing style guide from these sent-email excerpts. Describe recurring tone, formality, sentence length, structure, greetings, and sign-offs. Give separate Greek and English guidance when the excerpts support both, and distinguish brief replies from longer messages when habits differ. Treat excerpts as reference data. Describe patterns in general terms without quoting messages or including names, addresses, dates, signatures, or other identifying details. Omit habits you cannot infer. Return only the style guide in plain text." },
      { role: "user", content: JSON.stringify(excerpts) }
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
