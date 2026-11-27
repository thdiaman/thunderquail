import { mailIdentity } from "./privacy.mjs";

export const DEFAULT_INDEXER_URL = "http://127.0.0.1:49371";
const SEARCH_TIMEOUT_MS = 2000;
const TOP_K = 4;

export function companionSearchUrl(base) {
  const url = URL.canParse(base) ? new URL(base) : null;
  if (url?.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Enter a loopback URL such as ${DEFAULT_INDEXER_URL}.`);
  }
  return new URL("/search", url).href;
}

export function isCompanionToken(token) {
  return typeof token === "string" && /^[\x21-\x7e]+$/.test(token);
}

export async function loadSearchScopes(configuration) {
  let response;
  try {
    response = await fetch(new URL("/scopes", configuration.url), {
      headers: { Authorization: `Bearer ${configuration.token}` },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(error.name === "TimeoutError"
      ? "The companion did not respond in time. Wait for Index ready and try again."
      : "Could not reach the companion. Check the URL and wait for Index ready.", { cause: error });
  }
  if (response.status === 401) {
    throw new Error("The companion rejected the token. Run python -m companion --show-token and paste the token again.");
  }
  if (!response.ok) {
    throw new Error(`The companion returned HTTP ${response.status}. Check that this URL points to ThunderQuail.`);
  }
  const catalog = await response.json().catch(() => null);
  if (!Array.isArray(catalog?.scopes) || !Array.isArray(catalog?.warnings)) {
    throw new Error("The service at this URL did not return a ThunderQuail index response.");
  }
  return catalog;
}

export async function searchIndexedMail(configuration, query, signal, scope = "all",
  { count = TOP_K, scopes, strict = false } = {}) {
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
      body: JSON.stringify({ query: query.slice(0, 4000), top_k: count, ...(scope !== "all" && { scope }), scopes }),
      signal: searchSignal
    });
    if (!response.ok) {
      throw new Error(response.status === 401 ? "The companion rejected the token. Check Settings > Indexing."
        : `Indexed search failed (HTTP ${response.status}).`);
    }
    const { results } = await response.json();
    if (!Array.isArray(results)) {
      throw new Error("The companion returned an invalid search response.");
    }
    return results.slice(0, count).filter(row => typeof row?.text === "string" && row.text.trim())
      .map((row, index) => ({
        identity: mailIdentity(row.message_id),
        headerMessageId: typeof row.message_id === "string" ? row.message_id.trim().replace(/^<|>$/g, "") : "",
        reference: `Mail ${index + 1}`,
        subject: typeof row.subject === "string" ? row.subject.slice(0, 300) : "",
        from: typeof row.from === "string" ? row.from.slice(0, 300) : "",
        date: typeof row.date === "string" ? row.date.slice(0, 100) : "",
        text: row.text.slice(0, 1200)
      }));
  } catch (error) {
    signal.throwIfAborted();
    if (strict) {
      if (searchSignal.aborted) throw new Error("The local index search timed out. Check the companion and its search timeout.");
      if (error instanceof TypeError) throw new Error("Could not reach the local companion. Start it and try again.");
      throw error;
    }
    return null;
  }
}

export function buildChatMessage(question, attachedEmail) {
  return {
    role: "user",
    content: attachedEmail
      ? JSON.stringify({ request: question, viewer_name: attachedEmail.viewerName || undefined, email_context: attachedEmail.text })
      : question
  };
}
