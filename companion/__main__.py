import argparse
import hmac
import os
import re
import sqlite3
from pathlib import Path

from flask import Flask, jsonify, request
from werkzeug.serving import make_server

from .config import DEFAULT_PORT, companion_token, data_directory, default_profile
from .embeddings import DEFAULT_MODEL, Embedder, EmbeddingError
from .profile import Mailbox, build_scopes, discover_profile


EXTENSION_ORIGIN = re.compile(r"moz-extension://[a-zA-Z0-9-]+")


def create_app(table, embedder, token, *, scopes=None, warnings=()):
    from .index import count_chunks, search_index

    app = Flask(__name__)
    app.config.update(TRUSTED_HOSTS=["127.0.0.1"], MAX_CONTENT_LENGTH=32 * 1024)
    chunk_count = count_chunks(table)
    expected_auth = f"Bearer {token}".encode("ascii")
    scopes = scopes or {}

    @app.after_request
    def cors(response):
        response.vary.add("Origin")
        response.headers["Cache-Control"] = "no-store"
        origin = request.headers.get("Origin", "")
        if EXTENSION_ORIGIN.fullmatch(origin):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        return response

    @app.get("/health")
    def health():
        return jsonify(status="ok", chunks=chunk_count, embedding_model=embedder.model)

    @app.before_request
    def authorize_index_access():
        if request.endpoint not in {"search", "list_scopes"}:
            return None
        origin = request.headers.get("Origin")
        if origin is not None and not EXTENSION_ORIGIN.fullmatch(origin):
            return jsonify(error="Origin is not allowed."), 403
        if request.method == "OPTIONS":
            return "", 204
        auth = request.headers.get("Authorization", "").encode("utf-8")
        if not hmac.compare_digest(auth, expected_auth):
            return jsonify(error="A valid companion bearer token is required."), 401

    @app.route("/scopes", methods=["GET", "OPTIONS"])
    def list_scopes():
        return jsonify(scopes=[
            {"id": key, "label": scope.label, "kind": scope.kind} for key, scope in scopes.items()
        ], warnings=list(warnings))

    @app.route("/search", methods=["POST", "OPTIONS"])
    def search():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify(error="Send a JSON object with a query and optional top_k."), 400
        query = body.get("query")
        top_k = body.get("top_k", 5)
        scope = body.get("scope", "all")
        if not isinstance(query, str) or not query.strip() or len(query) > 4000:
            return jsonify(error="query must contain 1 to 4000 characters."), 400
        if type(top_k) is not int or not 1 <= top_k <= 50:
            return jsonify(error="top_k must be an integer from 1 to 50."), 400
        if not isinstance(scope, str) or (scope != "all" and scope not in scopes):
            return jsonify(error="Unknown indexed mail scope."), 400
        paths = None if scope == "all" else scopes[scope].paths
        try:
            results = search_index(table, embedder, query.strip(), top_k, paths) if chunk_count else []
        except EmbeddingError as error:
            return jsonify(error=str(error)), 502
        return jsonify(results=results)

    return app


def main():
    parser = argparse.ArgumentParser(description="Index Thunderbird MBOX files and serve local search.")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--mbox", action="append", type=Path, metavar="FILE",
                        help="Thunderbird MBOX file. Repeat for multiple mailboxes.")
    source.add_argument("--profile", type=Path, metavar="DIRECTORY",
                        help="Thunderbird profile containing prefs.js. Discover the profile's MBOX folders.")
    parser.add_argument("--db-dir", type=Path, metavar="DIRECTORY",
                        help="Dedicated local directory for the LanceDB index.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Loopback port (default: %(default)s).")
    parser.add_argument("--show-token", action="store_true",
                        help="Print the saved companion token, creating it if needed, and exit.")
    parser.add_argument("--rebuild", action="store_true", help="Re-embed all configured mailboxes.")
    parser.add_argument("--embedding-model", default=DEFAULT_MODEL,
                        help=f"Hugging Face model ID (default: {DEFAULT_MODEL}).")
    parser.add_argument("--embedding-revision", help="Hugging Face model revision or commit.")
    parser.add_argument("--check-embeddings", action="store_true",
                        help="Run local inference on synthetic text without opening any mail.")
    args = parser.parse_args()
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

    if args.check_embeddings:
        try:
            embedder = Embedder(args.embedding_model, args.embedding_revision)
            vector, = embedder.embed(["ThunderQuail embedding check."], query=True)
            print(f"Embedding model responded with a {len(vector)}-dimensional vector.")
        except (EmbeddingError, ValueError) as error:
            parser.exit(1, f"ThunderQuail embedding setup failed: {error}\n")
        return

    if args.show_token:
        try:
            print(companion_token(data_directory()))
        except (OSError, ValueError) as error:
            parser.exit(1, f"ThunderQuail token setup failed: {error}\n")
        return
    if not 1 <= args.port <= 65535:
        parser.error("--port must be from 1 to 65535.")

    try:
        from .index import build_index, count_chunks

        directory = data_directory()
        db_dir = (args.db_dir or directory / "index").resolve()
        if not args.mbox:
            profile = args.profile.resolve(strict=True) if args.profile else default_profile()
            if db_dir.is_relative_to(profile):
                raise ValueError("Place --db-dir outside the Thunderbird profile.")
            mailboxes, warnings = discover_profile(profile)
        else:
            mailboxes = [Mailbox("", "", (str(path),), path)
                         for path in dict.fromkeys(item.resolve(strict=True) for item in args.mbox)]
            warnings = []
        paths = list(dict.fromkeys(mailbox.path for mailbox in mailboxes))
        if any(not path.is_file() or path.is_relative_to(db_dir) for path in paths):
            raise ValueError("Each mailbox must be a file outside --db-dir.")
        token = companion_token(directory)
        print(f"Index directory: {db_dir}", flush=True)
        if warnings:
            print(f"Coverage: {len(warnings):,} stores skipped. See Settings > Indexing > Index coverage.", flush=True)
        print(f"Loading embedding model: {args.embedding_model} (downloads files if needed).", flush=True)
        embedder = Embedder(args.embedding_model, args.embedding_revision)
        table = build_index(db_dir, paths, embedder, rebuild=args.rebuild,
                            report=lambda line: print(line, flush=True))
        chunks = count_chunks(table)
    except (EmbeddingError, OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        parser.exit(1, f"ThunderQuail index startup failed: {error}\n")

    app = create_app(table, embedder, token, scopes=build_scopes(mailboxes), warnings=warnings)
    with make_server("127.0.0.1", args.port, app, threaded=True) as server:
        print(f"Index ready: {chunks:,} searchable chunks. Listening on http://127.0.0.1:{args.port}.", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
