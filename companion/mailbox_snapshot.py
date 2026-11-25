import os
from shutil import copyfileobj

from .mbox import fingerprint


def copy_stable_mailbox(path, destination):
    # Retry only this file if Thunderbird changes it while it is being copied.
    for _ in range(3):
        with path.open("rb") as source, destination.open("wb") as copy:
            before = fingerprint(os.fstat(source.fileno()))
            copyfileobj(source, copy, length=1024 * 1024)
            after = fingerprint(os.fstat(source.fileno()))
        if before == after == fingerprint(path.stat()) and destination.stat().st_size == before[2]:
            return before
    raise ValueError(f"Could not take a stable read-only snapshot of {path}. Completed embeddings can be reused.")
