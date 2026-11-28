from time import monotonic


def _duration(seconds):
    minutes, seconds = divmod(round(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:d}:{minutes:02d}:{seconds:02d}"


def size_label(size):
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if size < 1024 or unit == "TiB":
            return f"{size:,} B" if unit == "B" else f"{size:,.1f} {unit}"
        size /= 1024


class IndexProgress:
    def __init__(self, report, *, mailboxes, unchanged, removed, total_bytes, mode):
        self.report = report
        self.mailboxes = mailboxes
        self.total_bytes = total_bytes
        self.finished_mailboxes = 0
        self.finished_bytes = 0
        self.offset = 0
        self.folder = None
        self.current = None
        self.embedded = 0
        self.reused = 0
        self.started = self.last_report = monotonic()
        plan = []
        if mailboxes:
            folder_label = "folder" if mailboxes == 1 else "folders"
            plan.append(f"{mailboxes:,} {folder_label} to process ({size_label(total_bytes)})")
        if unchanged:
            plan.append(f"{unchanged:,} unchanged")
        if removed:
            plan.append(f"{removed:,} to remove from the index")
        report(f"{mode}. " + ("; ".join(plan) + "." if plan else "No mailboxes found."))

    def start_mailbox(self, name, size):
        self.current = name
        self.folder = f"[{self.finished_mailboxes + 1}/{self.mailboxes}] {name} ({size_label(size)})"

    def phase(self, description):
        if self.folder is not None:
            self.report(f"{self.folder} | {description}")
            self.folder = None
        else:
            self.report(f"  {description}")

    def position(self, offset):
        self.offset = offset
        self.update()

    def finish_mailbox(self, size):
        self.finished_mailboxes += 1
        self.finished_bytes += size
        self.offset = 0
        self.update()

    def finish_batch(self, embedded, reused):
        self.embedded += embedded
        self.reused += reused
        self.update()

    def fraction(self):
        scanned = min(self.finished_bytes + self.offset, self.total_bytes)
        return scanned / self.total_bytes if self.total_bytes else 1.0

    def update(self):
        now = monotonic()
        if now - self.last_report < 10:
            return
        self.last_report = now
        elapsed = now - self.started
        scanned = min(self.finished_bytes + self.offset, self.total_bytes)
        ratio = scanned / self.total_bytes if self.total_bytes else 0
        parts = [f"Elapsed {_duration(elapsed)}"]
        if 0 < ratio < 1:
            parts += [f"{ratio:.1%} of mailbox bytes checked", f"about {_duration(elapsed * (1 - ratio) / ratio)} left"]
        parts.extend(self.embedding_summary())
        self.report("  " + " | ".join(parts))

    def embedding_summary(self):
        parts = []
        if self.embedded:
            label = "embedding" if self.embedded == 1 else "embeddings"
            parts.append(f"{self.embedded:,} new {label}")
        if self.reused:
            label = "chunk" if self.reused == 1 else "chunks"
            parts.append(f"reused embeddings for {self.reused:,} {label}")
        return parts

    def completed(self):
        parts = self.embedding_summary()
        if not self.embedded:
            parts.append("no new embeddings needed")
        self.report(f"Index update finished in {_duration(monotonic() - self.started)}. " + "; ".join(parts) + ".")
