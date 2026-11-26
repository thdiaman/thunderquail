import itertools
import json
from hashlib import sha256
from warnings import catch_warnings, filterwarnings

with catch_warnings():
    filterwarnings("ignore", message="Pandas requires version .* of 'bottleneck'", category=UserWarning,
                   module=r"pandas\.core\.arrays\.masked")
    import lancedb
    import pyarrow as pa
from filelock import FileLock, Timeout

from .embedding_cache import EmbeddingCache
from .embeddings import EmbeddingError
from .mbox import MailboxChanged, fingerprint
from .mbox_update import plan_mailbox_update, saved_fingerprint
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


def _mailbox_rows(path, update):
    mailbox_key = _hash(str(path))
    for row in update.rows:
        message_key = row.pop("message_key")
        yield {
            **row,
            "mailbox": str(path),
            "mailbox_key": mailbox_key,
            "row_key": f"{mailbox_key}:{message_key}:{row['chunk_index']}",
        }


def _embedded_batches(rows, embedder, cache, durable, progress):
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


def _verify_mailboxes(mailboxes):
    for path, expected in mailboxes.items():
        try:
            observed = fingerprint(path.stat())
        except FileNotFoundError as error:
            raise MailboxChanged(f"Mailbox disappeared during indexing: {path}") from error
        if observed != expected:
            raise MailboxChanged(f"Mailbox changed during indexing: {path}")


def _existing_message_rows(table, mailbox_key):
    query = table.search().where(_key_filter("mailbox_key", [mailbox_key])).select(["message_id", "row_key"])
    for batch in query.to_batches(batch_size=8192):
        for row in batch.to_pylist():
            _, key, _ = row["row_key"].split(":")
            yield row["message_id"], key


def _record_batches(batches, schema, checkpoint, mailboxes):
    dimension = schema.field("vector").type.list_size
    for batch in batches:
        if any(len(row["vector"]) != dimension for row in batch):
            raise EmbeddingError("Embedding vector dimensions changed. Restart with --rebuild.")
        yield pa.RecordBatch.from_pylist(batch, schema=schema)
    _verify_mailboxes(mailboxes)
    # Commit the files' fingerprints together with their searchable rows.
    yield pa.RecordBatch.from_pylist([{
        "row_key": CHECKPOINT_KEY, "mailbox_key": "", "text": json.dumps(checkpoint),
        "vector": [1.0] + [0.0] * (dimension - 1),
    }], schema=schema)


def _commit(db, table, rows, checkpoint, mailboxes, embedder, durable, progress, delete=None, *, replace_index=False):
    batches = _embedded_batches(rows, embedder, table, durable, progress)
    first = next(batches, [])
    if table is not None and not first and delete is None:
        _verify_mailboxes(mailboxes)
        table.update(where=f"row_key = '{CHECKPOINT_KEY}'", values={"text": json.dumps(checkpoint)})
        return table
    batches = itertools.chain([first], batches) if first else ()
    dimension = len(first[0]["vector"]) if first else 1
    create = table is None or (first and count_chunks(table) == 0 and
                               dimension != table.schema.field("vector").type.list_size)
    schema = _schema(dimension) if create else table.schema
    changed_during_write = None

    def guarded_batches():
        nonlocal changed_during_write
        try:
            yield from _record_batches(batches, schema, checkpoint, mailboxes)
        except MailboxChanged as error:
            # Arrow can wrap an exception raised by the Python batch iterator.
            changed_during_write = error
            raise

    try:
        if create:
            mode = "overwrite" if table is not None or replace_index else "create"
            table = db.create_table(TABLE_NAME, schema=schema, mode=mode, data=guarded_batches())
            table.create_scalar_index("embedding_key")
            return table
        records = pa.RecordBatchReader.from_batches(schema, guarded_batches())
        merge = (table.merge_insert("row_key")
                 .when_matched_update_all(where=f"target.row_key = '{CHECKPOINT_KEY}'")
                 .when_not_matched_insert_all())
        if delete is not None:
            merge.when_not_matched_by_source_delete(delete)
        merge.execute(records)
        return table
    except Exception as error:
        if changed_during_write is not None and error is not changed_during_write:
            raise changed_during_write from error
        raise


def _update_index(db, paths, embedder, rebuild, report, durable, labels):
    try:
        table = db.open_table(TABLE_NAME)
    except ValueError as error:
        # A failed first build can leave a directory without a committed manifest.
        if str(error) != f"Table '{TABLE_NAME}' was not found":
            raise
        table = None
    previous = _read_checkpoint(table)
    compatible = (not rebuild and previous.get("version") == INDEX_VERSION
                  and previous.get("provider") == embedder.identity)
    old_mailboxes = previous.get("mailboxes", {}) if compatible else {}
    mailboxes = {path: fingerprint(path.stat()) for path in paths}
    changed = {path: stamp for path, stamp in mailboxes.items()
               if not isinstance(old_mailboxes.get(str(path)), dict)
               or list(stamp) != saved_fingerprint(old_mailboxes[str(path)])}
    removed = old_mailboxes.keys() - {str(path) for path in mailboxes}
    if compatible and not changed and not removed:
        if report is not None:
            report(f"All {len(mailboxes):,} mailboxes unchanged. Reusing the existing index.")
        return table

    progress = None
    if report is not None:
        if table is None:
            mode = "Building the email index"
        elif not compatible:
            mode = "Rebuilding the email index"
        elif any(isinstance(old_mailboxes.get(str(path)), list) for path in changed):
            mode = "Upgrading index checkpoints; existing embeddings can be reused"
        else:
            mode = "Updating the email index"
        progress = IndexProgress(report, mailboxes=len(changed), unchanged=len(mailboxes) - len(changed),
                                 removed=len(removed), total_bytes=sum(stamp[2] for stamp in changed.values()),
                                 mode=mode)
    checkpoint = {"version": INDEX_VERSION, "provider": embedder.identity, "mailboxes": dict(old_mailboxes)}
    on_position = progress.position if progress else None
    on_phase = progress.phase if progress else None
    if table is not None and not compatible:
        def initial_rows():
            for path, stamp in mailboxes.items():
                if progress:
                    progress.start_mailbox(labels.get(path, path.name), stamp[2])
                update = plan_mailbox_update(path, stamp, None, on_position=on_position, on_phase=on_phase)
                checkpoint["mailboxes"][str(path)] = update.checkpoint
                yield from _mailbox_rows(path, update)
                if progress:
                    progress.finish_mailbox(stamp[2])
        table = _commit(db, None, initial_rows(), checkpoint, mailboxes, embedder, durable, progress,
                        replace_index=True)
    else:
        for path, stamp in changed.items():
            for attempt in range(2):
                try:
                    if progress:
                        progress.start_mailbox(labels.get(path, path.name), stamp[2])
                    mailbox_key = _hash(str(path))
                    update = plan_mailbox_update(
                        path, stamp, old_mailboxes.get(str(path)), on_position=on_position, on_phase=on_phase,
                        load_existing=(lambda: _existing_message_rows(table, mailbox_key)) if table is not None else None,
                    )
                    checkpoint["mailboxes"][str(path)] = update.checkpoint
                    delete = None
                    if update.replace:
                        delete = _key_filter("mailbox_key", [mailbox_key])
                    elif update.deleted:
                        delete = _key_filter("row_key", (
                            f"{mailbox_key}:{key}:{index}"
                            for key, count in update.deleted.items() for index in range(count)
                        ))
                    table = _commit(db, table, _mailbox_rows(path, update), checkpoint, {path: stamp},
                                    embedder, durable, progress, delete)
                    break
                except MailboxChanged:
                    if attempt:
                        raise
                    if report:
                        report(f"Mailbox changed during indexing; retrying: {labels.get(path, path.name)}")
                    if on_position:
                        on_position(0)
                    stamp = fingerprint(path.stat())
            if progress:
                progress.finish_mailbox(stamp[2])
        if removed:
            for path in removed:
                del checkpoint["mailboxes"][path]
            table = _commit(db, table, iter(()), checkpoint, {}, embedder, durable, progress,
                            _key_filter("mailbox_key", map(_hash, sorted(removed))))
        if table is None:
            table = _commit(db, None, iter(()), checkpoint, {}, embedder, durable, progress)
    if progress:
        progress.completed()
    return table


def build_index(db_dir, paths, embedder, *, rebuild=False, report=None, labels=None):
    db_dir.mkdir(parents=True, exist_ok=True)
    try:
        with FileLock(str(db_dir / ".index.lock"), timeout=0):
            cache_key = _hash(json.dumps([embedder.identity, rebuild]))
            cache_path = db_dir / f".pending-embeddings-{cache_key}.sqlite"
            durable = EmbeddingCache(cache_path)
            try:
                db = lancedb.connect(str(db_dir))
                table = _update_index(db, paths, embedder, rebuild, report, durable, labels or {})
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
