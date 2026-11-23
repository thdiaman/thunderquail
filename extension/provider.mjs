export function chatProvider(settings) {
  if (!settings.base_url || !settings.chat_model) {
    throw new Error("Set the API base URL and chat model in ThunderQuail settings, then reopen.");
  }
  try {
    const endpoint = new URL(settings.base_url);
    if (["http:", "https:"].includes(endpoint.protocol) && !endpoint.username &&
        !endpoint.password && !endpoint.search && !endpoint.hash) {
      return { settings, endpoint };
    }
  } catch {
    // Use the same guidance for malformed and unsupported URLs.
  }
  throw new Error("Correct the API base URL in ThunderQuail settings, then reopen.");
}

export async function loadChatProvider() {
  let settings;
  try {
    settings = await browser.storage.local.get({ base_url: "", api_key: "", chat_model: "" });
  } catch {
    throw new Error("Could not load provider settings. Reopen ThunderQuail to retry.");
  }
  return chatProvider(settings);
}

export async function requestProviderAccess(endpoint) {
  const origin = `${endpoint.protocol}//${endpoint.hostname}/*`;
  if (!await browser.permissions.request({ origins: [origin] })) {
    throw new Error("Provider access was declined.");
  }
}
