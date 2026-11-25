import json
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

import numpy as np

from .embeddings import EmbeddingError


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class GpuEmbedder:
    def __init__(self, base_url, token, local):
        url = urlsplit(base_url)
        if (url.scheme != "http" or url.hostname != "127.0.0.1" or url.username is not None
                or url.path not in {"", "/"} or url.query or url.fragment or not url.port):
            raise ValueError("Use the loopback URL of the SSH tunnel, such as http://127.0.0.1:15100.")
        if not token or any(not 33 <= ord(char) <= 126 for char in token):
            raise ValueError("Set THUNDERQUAIL_GPU_TOKEN to the GPU server's bearer token.")
        self._base = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {token}"}
        self._opener = build_opener(ProxyHandler({}), _NoRedirect())
        self.identity = local.identity
        self.model = local.model
        health = self._request("/health")
        if (health.get("identity") != self.identity or health.get("model") != self.model
                or health.get("device") != "cuda"):
            raise EmbeddingError("The GPU endpoint must use CUDA and match the local embedding model and revision.")

        sample = ["ThunderQuail GPU compatibility check."]
        cpu_vectors = np.asarray(local.embed(sample), dtype=np.float32)
        self._dimension = cpu_vectors.shape[1]
        gpu_vectors = np.asarray(self.embed(sample), dtype=np.float32)
        if not np.allclose(cpu_vectors, gpu_vectors, rtol=2e-3, atol=2e-4):
            raise EmbeddingError("The GPU and CPU returned incompatible embeddings for the same input.")

    def _request(self, path, payload=None):
        headers = dict(self._headers)
        data = None
        if payload is not None:
            headers.update({"Content-Type": "application/json", "X-ThunderQuail-Task": "passage"})
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            with self._opener.open(Request(self._base + path, data=data, headers=headers), timeout=60) as response:
                limit = 2 * 1024 * 1024
                raw = response.read(limit + 1)
                if len(raw) > limit:
                    raise ValueError
                result = json.loads(raw)
                if isinstance(result, dict):
                    return result
        except HTTPError as error:
            raise EmbeddingError(f"GPU endpoint returned HTTP {error.code}. Check the tunnel, token, and the GPU service log.") from None
        except (URLError, OSError):
            raise EmbeddingError("GPU endpoint is unreachable or timed out. Check the SSH tunnel and the GPU host.") from None
        except ValueError:
            pass
        raise EmbeddingError("GPU endpoint returned an invalid response.")

    def embed(self, texts):
        payload = {"model": self.model, "input": texts}
        if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > 128 * 1024:
            if len(texts) == 1:
                raise EmbeddingError("One email chunk exceeds the GPU endpoint's request limit.")
            middle = len(texts) // 2
            return self.embed(texts[:middle]) + self.embed(texts[middle:])
        response = self._request("/v1/embeddings", payload)
        try:
            rows = sorted(response["data"], key=lambda row: row["index"])
            if response["model"] != self.model or [row["index"] for row in rows] != list(range(len(texts))):
                raise ValueError
            vectors = np.asarray([row["embedding"] for row in rows], dtype=np.float32)
            if (vectors.shape != (len(texts), self._dimension) or not np.isfinite(vectors).all()
                    or not np.allclose(np.linalg.norm(vectors, axis=1), 1.0, atol=1e-3)):
                raise ValueError
        except (ValueError, TypeError, KeyError, OverflowError):
            raise EmbeddingError("GPU endpoint returned invalid embedding vectors.") from None
        return vectors.tolist()
