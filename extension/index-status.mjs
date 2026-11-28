// Status of the optional local companion: what the header indicator and its details panel show.

const STATUS_TIMEOUT_MS = 3000;

async function companionRequest(configuration, path, method, signal) {
  const response = await fetch(new URL(path, configuration.url), {
    method,
    headers: { Authorization: `Bearer ${configuration.token}` },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(STATUS_TIMEOUT_MS)])
  });
  if (response.status === 401) throw new Error("The companion rejected the token. Check Settings > Indexing.");
  if (!response.ok) throw new Error(`The companion returned HTTP ${response.status}.`);
  const body = await response.json().catch(() => null);
  if (!body || typeof body.state !== "string" || !Array.isArray(body.folders)) {
    throw new Error("The service at this URL is not a current ThunderQuail companion. Restart it from this version.");
  }
  return body;
}

/** Returns the companion status, or throws when it is unreachable or outdated. */
export function fetchIndexStatus(configuration, signal) {
  return companionRequest(configuration, "/status", "GET", signal);
}

/** Asks the companion to check for new mail now. Returns at once with the current status. */
export function requestRescan(configuration, signal) {
  return companionRequest(configuration, "/rescan", "POST", signal);
}

const percent = fraction => `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%`;

function duration(seconds) {
  if (seconds < 90) return `${Math.max(seconds, 1)} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/**
 * Summarizes the companion for display.
 * @param {{configured: boolean, status?: object, error?: string}} input
 * @returns {{state: string, label: string, detail: string, folders: object[]}}
 */
export function describeIndex({ configured, status, error }) {
  if (!configured) {
    return { state: "not-set-up", label: "Index: not set up",
      detail: "Add the local companion in Settings > Indexing to search older mail by meaning. Search in Thunderbird works without it.",
      folders: [] };
  }
  if (!status) {
    return { state: "offline", label: "Index: offline",
      detail: `${error || "Could not reach the companion."} Searches use Thunderbird directly until it is running.`,
      folders: [] };
  }
  const folders = status.folders ?? [];
  const indexed = folders.filter(folder => folder.state === "indexed").length;
  if (status.state === "error") {
    return { state: "error", label: "Index: error",
      detail: `${status.error || "The last update failed."} The companion will retry. Searches still use Thunderbird for mail the index misses.`,
      folders };
  }
  if (status.state === "starting") {
    return { state: "starting", label: "Index: starting",
      detail: "The companion is loading. Searches use Thunderbird directly until the index is available.", folders };
  }
  if (status.state === "indexing") {
    const progress = status.progress;
    const done = progress ? percent(progress.fraction) : "";
    const parts = [progress && `Folder ${Math.min(progress.folders_done + 1, progress.folders_total)} of ${progress.folders_total}` +
      (progress.current ? `: ${progress.current}` : ""), progress && `${done} of mailbox bytes checked`,
      progress?.elapsed_seconds && `${duration(progress.elapsed_seconds)} elapsed`].filter(Boolean);
    return { state: "building", label: `Index: building${done ? ` ${done}` : ""}`,
      detail: `${parts.join(" · ")}${parts.length ? ". " : ""}${indexed} of ${folders.length} folders indexed. Mail the index lacks is searched in Thunderbird.`,
      folders };
  }
  const checked = status.checked_at ? new Date(status.checked_at) : null;
  const when = checked && !Number.isNaN(checked.getTime()) ? ` Last checked ${checked.toLocaleTimeString()}.` : "";
  return { state: "ready", label: "Index: ready",
    detail: `${indexed} of ${folders.length} folders indexed, ${status.chunks.toLocaleString()} searchable chunks.${when}`,
    folders };
}

/** One line per folder for the details panel. */
export function folderLine(folder) {
  const through = folder.indexed_through ? new Date(folder.indexed_through) : null;
  const time = through && !Number.isNaN(through.getTime()) ? through.toLocaleString() : "";
  const text = { indexed: time ? `up to date as of ${time}` : "up to date",
    indexing: "indexing now", pending: time ? `waiting (indexed through ${time})` : "waiting" }[folder.state] ?? folder.state;
  return `${folder.label}: ${text}`;
}
