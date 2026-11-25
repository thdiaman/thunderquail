const SEARCH_TIMEOUT_MS = 2000;
const TOP_K = 4;

export function companionSearchUrl(base) {
  const url = new URL(base);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Enter a loopback URL such as http://127.0.0.1:5000.");
  }
  return new URL("/search", url).href;
}

export function isCompanionToken(token) {
  return typeof token === "string" && /^[\x21-\x7e]+$/.test(token);
}

export async function loadSearchScopes(configuration) {
  try {
    const response = await fetch(new URL("/scopes", configuration.url), {
      headers: { Authorization: `Bearer ${configuration.token}` },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
    });
    if (response.ok) {
      const catalog = await response.json();
      if (Array.isArray(catalog.scopes) && Array.isArray(catalog.warnings)) {
        return catalog;
      }
    }
  } catch {
    // An unavailable catalog must not prevent standalone chat.
  }
  return null;
}

export async function searchIndexedMail(configuration, query, signal, scope = "all") {
  const searchSignal = AbortSignal.any([signal, AbortSignal.timeout(configuration.timeoutMs ?? SEARCH_TIMEOUT_MS)]);
  try {
    const response = await fetch(configuration.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuration.token}`,
        "Content-Type": "application/json"
      },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify({ query: query.slice(0, 4000), top_k: TOP_K, ...(scope !== "all" && { scope }) }),
      signal: searchSignal
    });
    if (!response.ok) {
      return null;
    }
    const { results } = await response.json();
    if (!Array.isArray(results)) {
      return null;
    }
    return results.slice(0, TOP_K).filter(row => typeof row?.text === "string" && row.text.trim())
      .map((row, index) => ({
        reference: `Mail ${index + 1}`,
        subject: typeof row.subject === "string" ? row.subject.slice(0, 300) : "",
        from: typeof row.from === "string" ? row.from.slice(0, 300) : "",
        date: typeof row.date === "string" ? row.date.slice(0, 100) : "",
        text: row.text.slice(0, 1200)
      }));
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

export function buildChatMessage(question, attachedEmail) {
  return {
    role: "user",
    content: attachedEmail
      ? JSON.stringify({ request: question, email_context: attachedEmail.text })
      : question
  };
}
