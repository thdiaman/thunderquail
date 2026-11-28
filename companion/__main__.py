import argparse
import hmac
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

from flask import Flask, jsonify, request
from werkzeug.serving import make_server

from .config import DEFAULT_PORT, companion_token, data_directory, default_profile
from .embeddings import DEFAULT_MODEL, Embedder, EmbeddingError
from .index import acquire_index_lock
from .profile import Mailbox, discover_profile, mailbox_labels
from .service import DEFAULT_POLL_SECONDS, IndexService


EXTENSION_ORIGIN = re.compile(r"moz-extension://[a-zA-Z0-9-]+")
AUTHORIZED_ENDPOINTS = {"search", "list_scopes", "status", "rescan"}


def create_app(service, token):
    app = Flask(__name__)
    app.config.update(TRUSTED_HOSTS=["127.0.0.1"], MAX_CONTENT_LENGTH=32 * 1024)
    expected_auth = f"Bearer {token}".encode("ascii")

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
        status = service.status()
        return jsonify(status="ok", state=status["state"], searchable=status["searchable"],
                       chunks=status["chunks"], embedding_model=status["embedding_model"])

    @app.before_request
    def authorize_index_access():
        if request.endpoint not in AUTHORIZED_ENDPOINTS:
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
            {"id": key, "label": scope.label, "kind": scope.kind, "account": scope.account, "folders": scope.folders}
            for key, scope in service.scopes.items()
        ], warnings=service.warnings)

    @app.route("/status", methods=["GET", "OPTIONS"])
    def status():
        return jsonify(service.status())

    @app.route("/rescan", methods=["POST", "OPTIONS"])
    def rescan():
        # Returns at once. The scan runs in the background, and repeated requests are coalesced.
        return jsonify(service.request_rescan()), 202

    @app.route("/search", methods=["POST", "OPTIONS"])
    def search():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify(error="Send a JSON object with a query and optional top_k."), 400
        query = body.get("query")
        top_k = body.get("top_k", 5)
        scope = body.get("scope", "all")
        selected_scopes = body.get("scopes")
        scopes = service.scopes
        if not isinstance(query, str) or not query.strip() or len(query) > 4000:
            return jsonify(error="query must contain 1 to 4000 characters."), 400
        if type(top_k) is not int or not 1 <= top_k <= 50:
            return jsonify(error="top_k must be an integer from 1 to 50."), 400
        if not isinstance(scope, str) or (scope != "all" and scope not in scopes):
            return jsonify(error="Unknown indexed mail scope."), 400
        paths = None if scope == "all" else scopes[scope].paths
        if "scopes" in body:
            if (scope != "all" or not isinstance(selected_scopes, list) or not selected_scopes
                    or len(selected_scopes) > 100
                    or any(not isinstance(key, str) or key not in scopes for key in selected_scopes)):
                return jsonify(error="Invalid indexed mail scopes."), 400
            paths = tuple(dict.fromkeys(path for key in selected_scopes for path in scopes[key].paths))
        try:
            results = service.search(query.strip(), top_k, paths)
        except EmbeddingError as error:
            return jsonify(error=str(error)), 502
        # The index state travels with the results so callers know what the index did not cover.
        return jsonify(results=results, index=service.status())

    return app


def rescan_running_companion(port):
    try:
        token = companion_token(data_directory())
        request_ = urllib.request.Request(f"http://127.0.0.1:{port}/rescan", method="POST",
                                          headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(request_, timeout=10) as response:
            status = json.load(response)
    except urllib.error.HTTPError as error:
        raise SystemExit(f"The companion refused the request (HTTP {error.code}).") from None
    except (OSError, ValueError) as error:
        raise SystemExit(f"Could not reach a companion on port {port}: {error}") from None
    print(f"Rescan requested. The companion is {status['state']}.")


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
    parser.add_argument("--rescan", action="store_true",
                        help="Ask the running companion to check for new mail now, then exit.")
    parser.add_argument("--poll-seconds", type=int, default=DEFAULT_POLL_SECONDS, metavar="SECONDS",
                        help="How often to check the mailboxes for new mail; 0 disables polling "
                             "(default: %(default)s).")
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
    if args.poll_seconds < 0:
        parser.error("--poll-seconds must be 0 or greater.")
    if args.rescan:
        rescan_running_companion(args.port)
        return

    lock = None
    try:
        directory = data_directory()
        db_dir = (args.db_dir or directory / "index").resolve()
        if not args.mbox:
            profile = args.profile.resolve(strict=True) if args.profile else default_profile()
            if db_dir.is_relative_to(profile):
                raise ValueError("Place --db-dir outside the Thunderbird profile.")

            def discover():
                mailboxes, warnings = discover_profile(profile)
                mailboxes = [mailbox for mailbox in mailboxes if not mailbox.path.is_relative_to(db_dir)]
                return mailboxes, warnings, mailbox_labels(profile, mailboxes)

            refresh = discover
            discovery = discover()
        else:
            mailboxes = [Mailbox("", "", (str(path),), path)
                         for path in dict.fromkeys(item.resolve(strict=True) for item in args.mbox)]
            if any(not mailbox.path.is_file() or mailbox.path.is_relative_to(db_dir) for mailbox in mailboxes):
                raise ValueError("Each mailbox must be a file outside --db-dir.")
            refresh, discovery = None, (mailboxes, [], {})
        if any(not mailbox.path.is_file() for mailbox in discovery[0]):
            raise ValueError("Each mailbox must be a file outside --db-dir.")
        token = companion_token(directory)
        # Hold the index lock for the whole run, so that a second companion fails at once.
        lock = acquire_index_lock(db_dir)
    except (OSError, ValueError) as error:
        parser.exit(1, f"ThunderQuail index startup failed: {error}\n")

    print(f"Index directory: {db_dir}", flush=True)
    if discovery[1]:
        print(f"Coverage: {len(discovery[1]):,} stores skipped. See Settings > Indexing > Index coverage.", flush=True)
    service = IndexService(
        db_dir, discovery, lambda: Embedder(args.embedding_model, args.embedding_revision),
        refresh=refresh, poll_seconds=args.poll_seconds, rebuild=args.rebuild,
        report=lambda line: print(line, flush=True),
    )
    app = create_app(service, token)
    service.start()
    try:
        with make_server("127.0.0.1", args.port, app, threaded=True) as server:
            print(f"Listening on http://127.0.0.1:{args.port}. Searches work while the index updates.", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        service.stop()
        lock.release()


if __name__ == "__main__":
    main()
