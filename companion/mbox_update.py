import os
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from hashlib import sha256
from itertools import groupby

from .mbox import (
    MailboxChanged, fingerprint, header_id, is_expunged, message_chunks,
    parse_record, read_raw_records, record_digest, record_header, split_record,
)
from .progress import size_label


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
    seen = {record[1] for record in records if record[1]}
    for start, raw in read_raw_records(path, expected, **read_options):
        record, chunks = _index_record(start, raw)
        records.append(record)
        key = record[1]
        if key and key not in seen:
            seen.add(key)
            yield from chunks


def _index_record(start, raw, saved=None, *, by_digest=None):
    headers, body = split_record(raw)
    digest = record_digest(headers, body)
    if by_digest is not None:
        saved = by_digest.get(digest)
    if saved and len(saved) == 4 and saved[3] == digest:
        message = record_header(headers)
        if message is not None:
            if is_expunged(message):
                return [start, None, 0, digest], []
            if saved[1]:
                return [start, *saved[1:]], []
    key, chunks = message_chunks(parse_record(headers, body))
    return [start, key, len(chunks), digest], chunks


def _upgrade_checkpoint(path, expected, existing_rows, on_position):
    keys_by_id = {}
    counts = Counter()
    for message_id, key in existing_rows:
        counts[key] += 1
        keys_by_id[message_id] = key if keys_by_id.get(message_id, key) == key else None

    hashes = BlockHashes()
    records = []
    active_ids = Counter()
    for start, raw in read_raw_records(path, expected, on_bytes=hashes.add, on_position=on_position):
        headers, body = split_record(raw)
        message = record_header(headers) if headers else None
        active = message is not None and not is_expunged(message)
        message_id = header_id(message) if active else ""
        if active:
            active_ids[message_id] += 1
        records.append(([start, None, 0, record_digest(headers, body)], active, message_id))

    used = set()
    for index, (record, active, message_id) in enumerate(records):
        if not active:
            continue
        key = keys_by_id.get(message_id) if message_id and active_ids[message_id] == 1 else None
        if key:
            record[1:3] = key, counts[key]
        else:
            end = records[index + 1][0][0] if index + 1 < len(records) else expected[2]
            raw_records = list(read_raw_records(path, expected, start=record[0], end=end))
            if len(raw_records) != 1 or raw_records[0][0] != record[0]:
                return None
            parsed, _ = _index_record(*raw_records[0])
            if parsed[1] and counts[parsed[1]] != parsed[2]:
                return None
            record[:] = parsed
        if record[1]:
            used.add(record[1])
    if used != counts.keys():
        return None
    return MailboxUpdate({
        "fingerprint": list(expected), "blocks": hashes.finish(),
        "records": [record for record, _, _ in records],
    }, ())


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


def _reconciled_update(expected, blocks, records, existing, additions):
    live = {record[1] for record in records if record[1]}
    deleted = {key: count for key, count in existing.items() if key not in live}
    if sum(deleted.values()) > MAX_TARGET_DELETIONS:
        return None  # Avoid building a very large row-key predicate for a bulk deletion.
    checkpoint = {"fingerprint": list(expected), "blocks": blocks, "records": records}
    return MailboxUpdate(checkpoint, (row for chunks in additions.values() for row in chunks), deleted=deleted)


def _reconcile_rewritten_file(path, expected, previous, on_position, on_phase):
    existing = {record[1]: record[2] for record in previous if record[1]}
    by_digest = {record[3]: record for record in previous if len(record) == 4 and record[1]}
    if not by_digest:
        return None
    if on_phase is not None:
        on_phase("Mailbox replaced or shortened; finding new offsets and matching unchanged records")
    hashes = BlockHashes()
    records, additions = [], {}
    new_bytes = 0
    for start, raw in read_raw_records(path, expected, on_bytes=hashes.add, on_position=on_position):
        record, chunks = _index_record(start, raw, by_digest=by_digest)
        records.append(record)
        key = record[1]
        if key and key not in existing and key not in additions:
            new_bytes += len(raw)
            if new_bytes > MAX_TARGET_BYTES:
                return None
            additions[key] = chunks
    return _reconciled_update(expected, hashes.finish(), records, existing, additions)


def _partial_update(path, expected, previous, on_position, on_phase):
    old = previous["fingerprint"]
    old_size = old[2]
    new_size = expected[2]
    records = previous["records"]
    if old_size and (not records or records[0][0] != 0):
        return None  # A partial scan requires known coverage from the start of the file.

    if on_phase is not None:
        on_phase("Verifying previously indexed bytes")
    blocks, changed = _compare_blocks(path, expected, old_size, previous["blocks"], on_position)
    if not changed:
        update = _append_update(path, expected, old_size, records, blocks)
        if update is not None and on_phase is not None:
            on_phase(f"Indexing {size_label(new_size - old_size)} of appended mail"
                     if new_size > old_size else "Mail bytes match the checkpoint; refreshing file metadata")
        return update

    ends = [record[0] for record in records[1:]] + [old_size]
    affected = [index for index, (record, end) in enumerate(zip(records, ends))
                if any(block in changed for block in range(record[0] // BLOCK_SIZE, (end - 1) // BLOCK_SIZE + 1))]
    ranges = []
    for _, group in groupby(enumerate(affected), key=lambda item: item[1] - item[0]):
        indices = [index for _, index in group]
        ranges.append((records[indices[0]][0], ends[indices[-1]], [records[i][0] for i in indices]))
    if new_size > old_size:
        ranges.append((old_size, new_size, None))
    with path.open("rb") as source:
        for start, end, _ in ranges:
            if not _at_separator(source, start) or (end < new_size and not _at_separator(source, end)):
                return None

    if on_phase is not None:
        block_label = "block" if len(changed) == 1 else "blocks"
        on_phase(f"Checking records in {len(changed):,} changed {block_label}"
                 + (" and parsing the appended tail" if new_size > old_size else ""))
    updated = {record[0]: record for record in records}
    existing = {record[1]: record[2] for record in records if record[1]}
    additions = {}
    new_bytes = 0
    for start, end, expected_starts in ranges:
        actual_starts = []
        for offset, raw in read_raw_records(path, expected, start=start, end=end):
            actual_starts.append(offset)
            record, chunks = _index_record(offset, raw, updated.get(offset))
            updated[offset] = record
            key = record[1]
            if key and key not in existing and key not in additions:
                new_bytes += len(raw)
                if new_bytes > MAX_TARGET_BYTES:
                    return None  # Bound the amount of material staged before the merge.
                additions[key] = chunks
        if expected_starts is not None and actual_starts != expected_starts:
            return None  # A separator moved or changed inside the previously indexed bytes.
        if not actual_starts or actual_starts[0] != start:
            return None

    current = sorted(updated.values(), key=lambda record: record[0])
    return _reconciled_update(expected, blocks, current, existing, additions)


def plan_mailbox_update(path, expected, previous, *, on_position=None, on_phase=None, load_existing=None):
    old = saved_fingerprint(previous)
    if previous is None:
        reason = "Scanning mailbox and recording message offsets"
    elif not isinstance(previous, dict) or "blocks" not in previous or "records" not in previous:
        reason = "Upgrading checkpoint with message offsets and block hashes"
        if load_existing is not None and old == list(expected):
            if on_phase is not None:
                on_phase("Recording offsets from headers; keeping existing search rows")
            update = _upgrade_checkpoint(path, expected, load_existing(), on_position)
            if update is not None:
                return update
            if on_position is not None:
                on_position(0)
            reason = "Could not match existing search rows; rescanning mailbox"
    elif old[:2] != list(expected[:2]) or old[2] > expected[2]:
        update = _reconcile_rewritten_file(path, expected, previous["records"], on_position, on_phase)
        if update is not None:
            return update
        if on_position is not None:
            on_position(0)
        reason = "Mailbox replaced or shortened; rescanning"
    else:
        update = _partial_update(path, expected, previous, on_position, on_phase)
        if update is not None:
            return update
        if on_position is not None:
            on_position(0)
        reason = "Targeted update unavailable; rescanning mailbox"
    if on_phase is not None:
        on_phase(reason)
    return _full_update(path, expected, on_position)
