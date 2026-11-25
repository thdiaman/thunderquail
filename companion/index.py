import itertools
import json
from hashlib import sha256

import lancedb
import pyarrow as pa
from filelock import FileLock, Timeout

from .embedding_cache import EmbeddingCache
from .embeddings import EmbeddingError
from .mbox import fingerprint, mailbox_chunks
from .progress import IndexProgress


BATCH_SIZE = 32
TEXT_COLUMNS = ("subject", "from", "to", "date", "message_id", "mailbox", "text")
RESULT_COLUMNS = (*TEXT_COLUMNS, "chunk_index")
TABLE_NAME = "email_chunks"
INDEX_VERSION = 1
CHUNKS_ONLY = "mailbox_key != ''"
CHECKPOINT_KEY = "checkpoint"


def _hash(text):
    return sha256(text.encode("utf-8")).hexdigest()


def _key_filter(column, hashes):
    # Only internally generated SHA-256 hex keys are used in these predicates.
    return f"{column} IN (" + ", ".join(f"'{key}'" for key in hashes) + ")"


def _mailbox_rows(mailboxes, progress):
    for path, expected in mailboxes.items():
        mailbox_key = _hash(str(path))
        for row in mailbox_chunks(path, expected, on_position=progress.position if progress else None):
            message_key = row.pop("message_key")
            yield {
                **row,
                "mailbox": str(path),
                "mailbox_key": mailbox_key,
                "row_key": f"{mailbox_key}:{message_key}:{row['chunk_index']}",
            }
        if progress:
            progress.finish_mailbox(expected[2])


def _embedded_batches(mailboxes, embedder, cache, durable, progress):
    rows = _mailbox_rows(mailboxes, progress)
    while batch := list(itertools.islice(rows, BATCH_SIZE)):
        inputs = {}
        for row in batch:
            text = f"Subject: {row['subject']}\n\n{row['text']}"
            row["embedding_key"] = _hash(text)
            inputs[row["embedding_key"]] = text
        vectors = durable.lookup(inputs)
        uncached = inputs.keys() - vectors.keys()
        if cache is not None and uncached:
            query = cache.search().where(_key_filter("embedding_key", uncached)).select(["embedding_key", "vector"])
            for matches in query.to_batches(batch_size=128):
                for match in matches.to_pylist():
                    vectors[match["embedding_key"]] = match["vector"]
                if len(vectors) == len(inputs):
                    break
        missing = {key: text for key, text in inputs.items() if key not in vectors}
        if missing:
            generated = dict(zip(missing, embedder.embed(list(missing.values())), strict=True))
            durable.save(generated)
            vectors.update(generated)
        for row in batch:
            row["vector"] = vectors[row["embedding_key"]]
        if progress:
            progress.finish_batch(len(missing), len(batch) - len(missing))
        yield batch


def _schema(dimension):
    return pa.schema([
        *((name, pa.string()) for name in TEXT_COLUMNS),
        ("chunk_index", pa.int32()),
        ("vector", pa.list_(pa.float32(), dimension)),
        ("row_key", pa.string()),
        ("mailbox_key", pa.string()),
        ("embedding_key", pa.string()),
    ])


def _read_checkpoint(table):
    if table is None or "row_key" not in table.schema.names:
        return {}
    rows = table.search().where(f"row_key = '{CHECKPOINT_KEY}'").select(["text"]).limit(1).to_list()
    return json.loads(rows[0]["text"]) if rows else {}


def count_chunks(table):
    return table.count_rows(CHUNKS_ONLY)


def _record_batches(batches, schema, checkpoint, mailboxes, progress):
    dimension = schema.field("vector").type.list_size
    for batch in batches:
        if any(len(row["vector"]) != dimension for row in batch):
            raise EmbeddingError("Embedding vector dimensions changed. Restart with --rebuild.")
        yield pa.RecordBatch.from_pylist(batch, schema=schema)
    for path, expected in mailboxes.items():
        if fingerprint(path.stat()) != expected:
            raise ValueError(f"Mailbox changed during indexing: {path}")
    if progress:
        progress.finalizing()
    # Commit the files' fingerprints together with their searchable rows.
    yield pa.RecordBatch.from_pylist([{
        "row_key": CHECKPOINT_KEY, "mailbox_key": "", "text": json.dumps(checkpoint),
        "vector": [1.0] + [0.0] * (dimension - 1),
    }], schema=schema)


def _update_index(db, paths, embedder, rebuild, report, durable):
    mailboxes = {path: fingerprint(path.stat()) for path in paths}
    checkpoint = {
        "version": INDEX_VERSION,
        "provider": embedder.identity,
        "mailboxes": {str(path): list(expected) for path, expected in mailboxes.items()},
    }
    try:
        table = db.open_table(TABLE_NAME)
    except ValueError as error:
        # A failed first build can leave a directory without a committed manifest.
        if str(error) != f"Table '{TABLE_NAME}' was not found":
            raise
        table = None
    previous = _read_checkpoint(table)
    compatible = (not rebuild and previous.get("version") == INDEX_VERSION
                  and previous.get("provider") == checkpoint["provider"])
    if compatible and previous == checkpoint:
        if report is not None:
            report(f"All {len(mailboxes):,} mailboxes unchanged. Reusing the existing index.")
        return table

    old_mailboxes = previous.get("mailboxes", {}) if compatible else {}
    changed = {path: expected for path, expected in mailboxes.items()
               if list(expected) != old_mailboxes.get(str(path))}
    removed = old_mailboxes.keys() - checkpoint["mailboxes"].keys()
    progress = None
    if report is not None:
        progress = IndexProgress(report, mailboxes=len(changed), unchanged=len(mailboxes) - len(changed),
                                 removed=len(removed), total_bytes=sum(stamp[2] for stamp in changed.values()))
    batches = _embedded_batches(changed, embedder, table if compatible else None, durable, progress)
    first = next(batches, [])
    batches = itertools.chain([first], batches) if first else ()
    dimension = len(first[0]["vector"]) if first else 1

    if not compatible or (first and count_chunks(table) == 0 and
                          dimension != table.schema.field("vector").type.list_size):
        schema = _schema(dimension)
        table = db.create_table(TABLE_NAME, schema=schema, mode="overwrite",
                                data=_record_batches(batches, schema, checkpoint, mailboxes, progress))
        table.create_scalar_index("embedding_key")
        return table

    replaced_keys = [_hash(str(path)) for path in changed] + [_hash(path) for path in sorted(removed)]
    records = pa.RecordBatchReader.from_batches(
        table.schema, _record_batches(batches, table.schema, checkpoint, mailboxes, progress)
    )
    (table.merge_insert("row_key")
     .when_matched_update_all(where=f"target.row_key = '{CHECKPOINT_KEY}'")
     .when_not_matched_insert_all()
     .when_not_matched_by_source_delete(_key_filter("mailbox_key", replaced_keys))
     .execute(records))
    return table


def build_index(db_dir, paths, embedder, *, rebuild=False, report=None):
    db_dir.mkdir(parents=True, exist_ok=True)
    try:
        with FileLock(str(db_dir / ".index.lock"), timeout=0):
            cache_key = _hash(json.dumps([embedder.identity, rebuild]))
            cache_path = db_dir / f".pending-embeddings-{cache_key}.sqlite"
            durable = EmbeddingCache(cache_path)
            try:
                db = lancedb.connect(str(db_dir))
                table = _update_index(db, paths, embedder, rebuild, report, durable)
            finally:
                durable.close()
            cache_path.unlink(missing_ok=True)
            return table
    except Timeout:
        raise ValueError("Another companion is updating this index. Try again when it finishes.") from None


def search_index(table, embedder, query, top_k, paths=None):
    if paths is not None and not paths:
        return []
    vector, = embedder.embed([query], query=True)
    if len(vector) != table.schema.field("vector").type.list_size:
        raise EmbeddingError("Query vector dimension differs from the index. Rebuild the index.")
    condition = CHUNKS_ONLY if paths is None else _key_filter("mailbox_key", map(lambda path: _hash(str(path)), paths))
    return (table.search(vector).metric("cosine").where(condition, prefilter=True)
            .select([*RESULT_COLUMNS, "_distance"]).limit(top_k).to_list())
