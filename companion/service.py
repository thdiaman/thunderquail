import threading
import traceback
from datetime import datetime, timezone
from time import monotonic

import lancedb

from .index import (
    INDEX_VERSION, IndexObserver, count_chunks, open_table, read_checkpoint, run_update, search_index,
)
from .profile import build_scopes


DEFAULT_POLL_SECONDS = 300
RETRY_SECONDS = 60
_SENT_NAMES = {"sent", "sent items", "sent mail", "sent messages"}


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _priority(mailbox):
    """Index the most useful folders first so search is useful early in a long first build."""
    name = mailbox.folders[-1].casefold() if mailbox.folders else ""
    return 0 if name == "inbox" else 1 if name in _SENT_NAMES else 2


class IndexService(IndexObserver):
    """Keeps the index current in a background thread while answering searches from committed data."""

    def __init__(self, db_dir, discovery, embedder_factory, *, refresh=None, poll_seconds=DEFAULT_POLL_SECONDS,
                 rebuild=False, report=print):
        """`discovery` is (mailboxes, warnings, labels). `refresh`, if given, returns a new discovery."""
        self._db_dir = db_dir
        self._refresh = refresh
        self._embedder_factory = embedder_factory
        self._poll_seconds = poll_seconds
        self._rebuild = rebuild
        self._report = report
        self._lock = threading.RLock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread = None
        self._read_db = None
        self._embedder = None
        self._table = None
        self._chunks = 0
        self._searchable = False
        self._state = "starting"
        self._error = None
        self._checked_at = None
        self._ready_reported = False
        self._progress = None
        self._started = None
        self._scan_started_at = None
        self._failed = set()
        self._folders = {}
        self._set_discovery(discovery)

    # --- discovery -------------------------------------------------------------------------------------------

    def _set_discovery(self, discovery):
        mailboxes, warnings, labels = discovery
        with self._lock:
            self._mailboxes = sorted(mailboxes, key=_priority)
            self._warnings = list(warnings)
            self._labels = dict(labels)
            self._scopes = build_scopes(self._mailboxes)
            current = {mailbox.path for mailbox in self._mailboxes}
            self._folders = {path: entry for path, entry in self._folders.items() if path in current}
            for mailbox in self._mailboxes:
                self._folders.setdefault(mailbox.path, {"state": "pending", "indexed_through": None})

    @property
    def scopes(self):
        with self._lock:
            return self._scopes

    @property
    def warnings(self):
        with self._lock:
            return list(self._warnings)

    @property
    def embedding_model(self):
        return self._embedder.model if self._embedder is not None else None

    # --- lifecycle -------------------------------------------------------------------------------------------

    def start(self):
        self._thread = threading.Thread(target=self._loop, name="index-worker", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout=10)

    def request_rescan(self):
        """Ask for a scan soon. Requests made during a scan cause at most one extra pass."""
        self._wake.set()
        return self.status()

    def _loop(self):
        while not self._stop.is_set():
            self._wake.clear()
            succeeded = self._scan()
            if self._stop.is_set():
                return
            if not succeeded:
                delay = RETRY_SECONDS if not self._poll_seconds else min(RETRY_SECONDS, self._poll_seconds)
            else:
                delay = self._poll_seconds or None
            self._wake.wait(delay)

    # --- scanning --------------------------------------------------------------------------------------------

    def _scan(self):
        self._scan_started_at = _now()
        self._failed = set()
        try:
            if self._refresh is not None:
                try:
                    self._set_discovery(self._refresh())
                except (OSError, ValueError) as error:
                    self._report(f"Could not refresh the mailbox list; using the previous one: {error}")
            if self._embedder is None:
                with self._lock:
                    self._state = "starting"
                self._report("Loading embedding model (downloads files if needed).")
                self._embedder = self._embedder_factory()
            self._refresh_reader()
            with self._lock:
                mailboxes = list(self._mailboxes)
                labels = dict(self._labels)
            paths = list(dict.fromkeys(mailbox.path for mailbox in mailboxes))
            run_update(self._db_dir, paths, self._embedder, rebuild=self._rebuild, report=self._report,
                       labels=labels, observer=self)
            self._rebuild = False
        except Exception as error:
            self._report("Index update failed: " + (str(error) or type(error).__name__))
            if not isinstance(error, (OSError, ValueError, RuntimeError)):
                self._report(traceback.format_exc())
            with self._lock:
                self._state = "error"
                self._error = str(error) or type(error).__name__
                self._progress = None
                self._checked_at = _now()
            return False
        with self._lock:
            for mailbox in self._mailboxes:
                if mailbox.path not in self._failed:
                    self._folders[mailbox.path] = {"state": "indexed", "indexed_through": self._scan_started_at}
            self._progress = None
            self._error = None
            self._checked_at = _now()
            self._state = "ready"
            chunks = self._chunks
            first = not self._ready_reported
            self._ready_reported = True
        if first:
            self._report(f"Index ready: {chunks:,} searchable chunks.")
        return not self._failed

    def _refresh_reader(self):
        """Open the latest committed version of the index for searching."""
        if self._read_db is None:
            self._db_dir.mkdir(parents=True, exist_ok=True)
            self._read_db = lancedb.connect(str(self._db_dir))
        table = open_table(self._read_db)
        searchable, chunks = False, 0
        if table is not None:
            checkpoint = read_checkpoint(table)
            searchable = (checkpoint.get("version") == INDEX_VERSION
                          and checkpoint.get("provider") == self._embedder.identity)
            chunks = count_chunks(table) if searchable else 0
        with self._lock:
            self._table, self._searchable, self._chunks = table, searchable, chunks

    # --- IndexObserver ---------------------------------------------------------------------------------------

    def plan(self, table, compatible, changed, unchanged, removed, previous):
        with self._lock:
            for path in unchanged:
                self._folders[path] = {"state": "indexed", "indexed_through": self._scan_started_at}
            for path in changed:
                entry = previous.get(str(path)) if compatible else None
                through = entry.get("scanned_at") if isinstance(entry, dict) else None
                self._folders[path] = {"state": "pending", "indexed_through": through}
            if changed or removed or not compatible:
                self._state = "indexing"
                self._started = monotonic()

    def progress(self, progress):
        with self._lock:
            self._progress = progress

    def committed(self, path, table):
        self._refresh_reader()
        if path is not None:
            with self._lock:
                self._folders[path] = {"state": "indexed", "indexed_through": self._scan_started_at}

    def failed(self, path, error):
        self._failed.add(path)
        return True

    # --- queries ---------------------------------------------------------------------------------------------

    def search(self, query, top_k, paths=None):
        with self._lock:
            table, embedder, usable = self._table, self._embedder, self._searchable and self._chunks
        if not usable:
            return []
        return search_index(table, embedder, query, top_k, paths)

    def coverage(self):
        """Per-folder state, used by the extension to search Thunderbird for what the index lacks."""
        with self._lock:
            current = self._progress.current if self._progress is not None else None
            folders = []
            for mailbox in self._mailboxes:
                entry = self._folders[mailbox.path]
                label = self._labels.get(mailbox.path, mailbox.path.name)
                state = "indexing" if entry["state"] == "pending" and current == label else entry["state"]
                folders.append({
                    "account": mailbox.account, "account_name": mailbox.account_name,
                    "folders": list(mailbox.folders), "label": label,
                    "state": state, "indexed_through": entry["indexed_through"],
                })
            return folders

    def status(self):
        with self._lock:
            progress = None
            if self._state == "indexing" and self._progress is not None:
                progress = {
                    "folders_total": self._progress.mailboxes,
                    "folders_done": self._progress.finished_mailboxes,
                    "current": self._progress.current,
                    "fraction": round(self._progress.fraction(), 4),
                    "elapsed_seconds": round(monotonic() - self._started) if self._started else 0,
                    "new_embeddings": self._progress.embedded,
                }
            return {
                "state": self._state, "searchable": bool(self._searchable and self._chunks),
                "chunks": self._chunks, "embedding_model": self.embedding_model, "error": self._error,
                "checked_at": self._checked_at, "poll_seconds": self._poll_seconds,
                "progress": progress, "folders": self.coverage(), "warnings": list(self._warnings),
            }
