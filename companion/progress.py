from time import monotonic


def _duration(seconds):
    minutes, seconds = divmod(round(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:d}:{minutes:02d}:{seconds:02d}"


class IndexProgress:
    def __init__(self, report, *, mailboxes, unchanged, removed, total_bytes):
        self.report = report
        self.mailboxes = mailboxes
        self.total_bytes = total_bytes
        self.finished_mailboxes = 0
        self.finished_bytes = 0
        self.offset = 0
        self.embedded = 0
        self.reused = 0
        self.started = self.last_report = monotonic()
        report(
            f"Indexing {mailboxes:,} mailbox(es), {total_bytes / 1024**3:.2f} GiB to scan. "
            f"{unchanged:,} unchanged; {removed:,} removed."
        )

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

    def update(self):
        now = monotonic()
        if now - self.last_report < 10:
            return
        self.last_report = now
        elapsed = now - self.started
        scanned = min(self.finished_bytes + self.offset, self.total_bytes)
        ratio = scanned / self.total_bytes if self.total_bytes else 0
        eta = _duration(elapsed * (1 - ratio) / ratio) if 0 < ratio < 1 else "estimating"
        self.report(
            f"Scan {ratio:.1%} by mailbox bytes | {self.finished_mailboxes:,}/{self.mailboxes:,} scanned | "
            f"{self.embedded:,} embeddings generated, {self.reused:,} chunks reused | "
            f"{self.embedded / elapsed:.1f} new embeddings/s | elapsed {_duration(elapsed)} | estimated ETA {eta}"
        )

    def completed(self):
        self.report(
            f"Scan complete. Generated {self.embedded:,} embeddings, reused vectors for "
            f"{self.reused:,} chunks."
        )
