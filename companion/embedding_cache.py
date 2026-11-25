import sqlite3

import numpy as np


class EmbeddingCache:
    def __init__(self, path):
        # Lance reads streamed batches on a worker thread. The index lock permits only one writer.
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.execute("PRAGMA journal_mode = DELETE")
        self.connection.execute("PRAGMA synchronous = FULL")
        self.connection.execute("CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, vector BLOB NOT NULL)")

    def lookup(self, keys):
        if not keys:
            return {}
        placeholders = ", ".join("?" for _ in keys)
        rows = self.connection.execute(f"SELECT key, vector FROM vectors WHERE key IN ({placeholders})", tuple(keys))
        return {key: np.frombuffer(value, dtype="<f4").tolist() for key, value in rows}

    def save(self, vectors):
        with self.connection:
            self.connection.executemany("INSERT OR REPLACE INTO vectors VALUES (?, ?)", (
                (key, np.asarray(vector, dtype="<f4").tobytes()) for key, vector in vectors.items()
            ))

    def close(self):
        self.connection.close()
