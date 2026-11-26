import os
from collections.abc import Iterable
from dataclasses import dataclass, field
from hashlib import sha256
from itertools import groupby

from .mbox import MailboxChanged, fingerprint, message_chunks, read_records


BLOCK_SIZE = 1024 * 1024
MAX_TARGET_BYTES = 64 * BLOCK_SIZE
MAX_TARGET_DELETIONS = 4096


@dataclass
class MailboxUpdate:
    checkpoint: dict
    rows: Iterable[dict]
    replace: bool = False
    deleted: dict = field(default_factory=dict)


class BlockHashes:
    def __init__(self):
        self.digests = []
        self._hash = sha256()
        self._size = 0

    def add(self, data):
        if len(data) < BLOCK_SIZE - self._size:
            self._hash.update(data)
            self._size += len(data)
            return
        data = memoryview(data)
        while data:
            length = min(BLOCK_SIZE - self._size, len(data))
            self._hash.update(data[:length])
            self._size += length
            data = data[length:]
            if self._size == BLOCK_SIZE:
                self.digests.append(self._hash.hexdigest())
                self._hash = sha256()
                self._size = 0

    def finish(self):
        if self._size:
            self.digests.append(self._hash.hexdigest())
        return self.digests


def saved_fingerprint(checkpoint):
    # The legacy checkpoint stored only a fingerprint.
    return checkpoint.get("fingerprint") if isinstance(checkpoint, dict) else checkpoint


def _scan_rows(path, expected, records, **read_options):
    seen = {key for _, key, _ in records if key}
    for start, _, message in read_records(path, expected, **read_options):
        key, chunks = message_chunks(message)
        records.append([start, key, len(chunks)])
        if key and key not in seen:
            seen.add(key)
            yield from chunks


def _full_update(path, expected, on_position):
    checkpoint = {"fingerprint": list(expected), "records": []}

    def rows():
        hashes = BlockHashes()
        yield from _scan_rows(path, expected, checkpoint["records"], on_bytes=hashes.add, on_position=on_position)
        checkpoint["blocks"] = hashes.finish()

    return MailboxUpdate(checkpoint, rows(), replace=True)


def _compare_blocks(path, expected, old_size, old_blocks, on_position):
    changed = set()
    blocks = []
    with path.open("rb") as source:
        if fingerprint(os.fstat(source.fileno())) != expected:
            raise MailboxChanged(f"Mailbox changed before reading: {path}")
        for offset in range(0, expected[2], BLOCK_SIZE):
            length = min(BLOCK_SIZE, expected[2] - offset)
            data = source.read(length)
            if len(data) != length:
                raise MailboxChanged(f"Mailbox changed during indexing: {path}")
            digest = sha256(data).hexdigest()
            index = len(blocks)
            blocks.append(digest)
            if offset < old_size:
                prefix = old_size - offset
                old_digest = sha256(data[:prefix]).hexdigest() if prefix < length else digest
                if old_digest != old_blocks[index]:
                    changed.add(index)
            if on_position is not None:
                on_position(offset + length)
        if fingerprint(os.fstat(source.fileno())) != expected:
            raise MailboxChanged(f"Mailbox changed during indexing: {path}")
    return blocks, changed


def _at_separator(source, offset):
    source.seek(max(0, offset - 1))
    if offset and source.read(1) != b"\n":
        return False
    return source.read(5) == b"From "


def _append_update(path, expected, old_size, records, blocks):
    checkpoint = {"fingerprint": list(expected), "blocks": blocks, "records": list(records)}
    if expected[2] == old_size:
        return MailboxUpdate(checkpoint, ())
    with path.open("rb") as source:
        if not _at_separator(source, old_size):
            return None

    return MailboxUpdate(checkpoint, _scan_rows(path, expected, checkpoint["records"], start=old_size, end=expected[2]))


def _partial_update(path, expected, previous, on_position):
    old = previous["fingerprint"]
    old_size = old[2]
    new_size = expected[2]
    records = previous["records"]
    if old_size and (not records or records[0][0] != 0):
        return None  # A partial scan requires known coverage from the start of the file.

    blocks, changed = _compare_blocks(path, expected, old_size, previous["blocks"], on_position)
    if not changed:
        return _append_update(path, expected, old_size, records, blocks)

    ends = [record[0] for record in records[1:]] + [old_size]
    affected = [index for index, ((start, _, _), end) in enumerate(zip(records, ends))
                if any(block in changed for block in range(start // BLOCK_SIZE, (end - 1) // BLOCK_SIZE + 1))]
    ranges = []
    for _, group in groupby(enumerate(affected), key=lambda item: item[1] - item[0]):
        indices = [index for _, index in group]
        ranges.append((records[indices[0]][0], ends[indices[-1]], [records[i][0] for i in indices]))
    if new_size > old_size:
        ranges.append((old_size, new_size, None))
    if sum(end - start for start, end, _ in ranges) > MAX_TARGET_BYTES:
        return None  # Keep the amount of material staged before the merge bounded.

    with path.open("rb") as source:
        for start, end, _ in ranges:
            if not _at_separator(source, start) or (end < new_size and not _at_separator(source, end)):
                return None

    updated = {record[0]: record for record in records}
    existing = {key: count for _, key, count in records if key}
    additions = {}
    for start, end, expected_starts in ranges:
        actual_starts = []
        for offset, _, message in read_records(path, expected, start=start, end=end):
            actual_starts.append(offset)
            key, chunks = message_chunks(message)
            updated[offset] = [offset, key, len(chunks)]
            if key and key not in existing:
                additions.setdefault(key, chunks)
        if expected_starts is not None and actual_starts != expected_starts:
            return None  # A separator moved or changed inside the previously indexed bytes.
        if not actual_starts or actual_starts[0] != start:
            return None

    current = sorted(updated.values(), key=lambda record: record[0])
    live = {key for _, key, _ in current if key}
    deleted = {key: count for key, count in existing.items() if key not in live}
    if sum(deleted.values()) > MAX_TARGET_DELETIONS:
        return None  # Avoid building a very large row-key predicate for a bulk deletion.
    checkpoint = {"fingerprint": list(expected), "blocks": blocks, "records": current}
    return MailboxUpdate(checkpoint, (row for chunks in additions.values() for row in chunks), deleted=deleted)


def plan_mailbox_update(path, expected, previous, *, on_position=None):
    old = saved_fingerprint(previous)
    if (isinstance(previous, dict) and "blocks" in previous and "records" in previous
            and old[:2] == list(expected[:2]) and old[2] <= expected[2]):
        update = _partial_update(path, expected, previous, on_position)
        if update is not None:
            return update
        if on_position is not None:
            on_position(0)
    return _full_update(path, expected, on_position)
