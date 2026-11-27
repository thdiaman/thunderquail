const EXCLUSION_PREFIX = "excluded_email:";
const credentialPatterns = [
  ["private key", /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g],
  ["URL credentials", /([a-z][a-z0-9+.-]*:\/\/)[^\s/@?#"']+(@)/gi],
  ["authorization credential", /(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+\/=-]{8,}/gi],
  ["token", /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?![\w-])/g],
  ["configured credential", /(["']?\b[\w-]*(?:api[ _-]?key|password|passwd|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|aws[_-]?secret[_-]?access[_-]?key|secret|token)\b["']?[ \t]*[:=][ \t]*)(?!["']?\[redacted )(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;}"'\]]+)/gi]
];

export function redactCredentials(text, secrets = []) {
  let redacted = text;
  const types = new Set();
  const mark = type => {
    types.add(type);
    return `[redacted ${type}]`;
  };
  for (const [type, pattern] of credentialPatterns) {
    redacted = redacted.replace(pattern, (...args) => {
      const marker = mark(type);
      if (type === "URL credentials") return args[1] + marker + args[2];
      if (type === "authorization credential") return args[1] + marker;
      if (type === "configured credential") {
        const quote = args[0].slice(args[1].length).match(/^["']/)?.[0] ?? "";
        return args[1] + quote + marker + quote;
      }
      return marker;
    });
  }
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8 && redacted.includes(secret)) {
      redacted = redacted.replaceAll(secret, () => mark("configured credential"));
    }
  }
  return { text: redacted, types: [...types] };
}

export function redactContent(content, secrets) {
  if (typeof content !== "string") return content;
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    return redactCredentials(content, secrets).text;
  }
  if (!value || typeof value !== "object") return redactCredentials(content, secrets).text;
  return JSON.stringify(value, (key, field) => {
    if ((typeof field === "string" || typeof field === "number") && field &&
        redactCredentials(key + "=value").types.includes("configured credential")) {
      return "[redacted configured credential]";
    }
    return typeof field === "string" ? redactCredentials(field, secrets).text : field;
  });
}

export function mailIdentity(messageId) {
  return typeof messageId === "string" ? messageId.trim().replace(/^<|>$/g, "").trim().toLowerCase() : "";
}

export async function loadExcludedEmails() {
  const all = await browser.storage.local.get(null);
  return new Map(Object.entries(all).filter(([key]) => key.startsWith(EXCLUSION_PREFIX))
    .map(([key, subject]) => [key.slice(EXCLUSION_PREFIX.length), subject]));
}

export async function isEmailExcluded(identity) {
  const key = EXCLUSION_PREFIX + identity;
  return Object.hasOwn(await browser.storage.local.get(key), key);
}

export function exclusionChanged(changes, identity) {
  return Object.hasOwn(changes, EXCLUSION_PREFIX + identity);
}

export function excludeEmails(messages) {
  const entries = messages.filter(({ identity }) => identity).map(({ identity, subject }) =>
    [EXCLUSION_PREFIX + identity, redactCredentials(subject || "(no subject)").text]);
  return browser.storage.local.set(Object.fromEntries(entries));
}

export function removeExcludedEmail(identity) {
  return browser.storage.local.remove(EXCLUSION_PREFIX + identity);
}
