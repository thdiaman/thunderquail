import json
from pathlib import Path
from threading import Condition, Lock

import numpy as np


DEFAULT_MODEL = "intfloat/multilingual-e5-small"
DEFAULT_REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"
# Indexing embeds in small slices so that a search query can run between them.
INDEXING_SLICE = 8


class EmbeddingError(Exception):
    pass


class Embedder:
    def __init__(self, model=DEFAULT_MODEL, revision=None):
        self.model = model.strip()
        if not self.model:
            raise ValueError("Provide a Hugging Face embedding model ID.")
        revision = revision or (DEFAULT_REVISION if self.model == DEFAULT_MODEL else None)
        self._lock = Lock()
        self._turn = Condition()
        self._queries_waiting = 0
        self._is_e5 = self.model.lower().split("/")[-1].startswith(("e5-", "multilingual-e5-"))

        try:
            from huggingface_hub import snapshot_download
            from onnxruntime import InferenceSession
            from tokenizers import Tokenizer
        except ModuleNotFoundError as error:
            raise EmbeddingError("Install the companion requirements to enable local embeddings.") from error
        except (ImportError, OSError) as error:
            raise EmbeddingError(f"Could not initialize the local embedding runtime: {error}") from error
        try:
            snapshot = Path(snapshot_download(
                self.model, revision=revision,
                allow_patterns=["tokenizer.json", "tokenizer_config.json", "onnx/model.onnx"],
            ))
            self.identity = ["huggingface-onnx-v1", self.model, snapshot.name]
            self._tokenizer = Tokenizer.from_file(str(snapshot / "tokenizer.json"))
            config = json.loads((snapshot / "tokenizer_config.json").read_text(encoding="utf-8"))
            pad_token = config["pad_token"]
            if isinstance(pad_token, dict):
                pad_token = pad_token["content"]
            pad_id = self._tokenizer.token_to_id(pad_token)
            if pad_id is None:
                raise ValueError("Missing tokenizer padding token.")
            self._tokenizer.enable_padding(pad_id=pad_id, pad_token=pad_token)
            self._tokenizer.enable_truncation(max_length=min(512, config.get("model_max_length", 512)))
            self._session = InferenceSession(str(snapshot / "onnx" / "model.onnx"),
                                             providers=["CPUExecutionProvider"])
            self._inputs = {item.name for item in self._session.get_inputs()}
            outputs = {item.name for item in self._session.get_outputs()}
            self._output = "sentence_embedding" if "sentence_embedding" in outputs else "last_hidden_state"
            if self._output not in outputs:
                raise ValueError("Model does not expose compatible embedding output.")
        except Exception as error:
            raise EmbeddingError(
                f"Could not load {self.model}. Check Hugging Face connectivity, cache, and ONNX model files."
            ) from error

    def embed(self, texts, *, query=False):
        if not texts:
            return []
        if query:
            with self._turn:
                self._queries_waiting += 1
            try:
                return self._embed(texts, query)
            finally:
                with self._turn:
                    self._queries_waiting -= 1
                    self._turn.notify_all()
        vectors = []
        for start in range(0, len(texts), INDEXING_SLICE):
            with self._turn:
                self._turn.wait_for(lambda: not self._queries_waiting)
            vectors.extend(self._embed(texts[start:start + INDEXING_SLICE], query))
        return vectors

    def _embed(self, texts, query):
        if self._is_e5:
            prefix = "query: " if query else "passage: "
            texts = [prefix + text for text in texts]
        try:
            with self._lock:
                tokens = self._tokenizer.encode_batch(texts)
                inputs = {
                    "input_ids": np.asarray([item.ids for item in tokens], dtype=np.int64),
                    "attention_mask": np.asarray([item.attention_mask for item in tokens], dtype=np.int64),
                    "token_type_ids": np.asarray([item.type_ids for item in tokens], dtype=np.int64),
                }
                vector, = self._session.run([self._output], {name: inputs[name] for name in self._inputs})
            if self._output == "last_hidden_state":
                mask = inputs["attention_mask"][..., None].astype(np.float32)
                vector = (vector * mask).sum(axis=1) / mask.sum(axis=1).clip(min=1)
            vector = np.asarray(vector, dtype=np.float32)
            if vector.ndim != 2 or vector.shape[0] != len(texts) or not vector.shape[1]:
                raise ValueError("Invalid embedding dimensions.")
            norms = np.linalg.norm(vector, axis=1, keepdims=True)
            if not np.isfinite(norms).all() or not norms.all():
                raise ValueError("Invalid embedding vectors.")
        except Exception as error:
            raise EmbeddingError("The local model could not produce embeddings.") from error
        return (vector / norms).tolist()
