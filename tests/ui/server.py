"""Serves the extension with a mock Thunderbird `browser`, and proxies the companion (adding its token, no Origin)."""
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

EXTENSION = Path(sys.argv[1]).resolve()
HARNESS = Path(__file__).resolve().parent
DATA = Path(sys.argv[2]).resolve()
PORT = int(sys.argv[3])
COMPANION_PORT = int(sys.argv[4])
TOKEN = sys.argv[5]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(EXTENSION), **kwargs)

    def log_message(self, *args):
        pass

    def send_bytes(self, body, content_type, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def proxy(self, method):
        path = self.path[len("/__companion"):]
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        request = urllib.request.Request(f"http://127.0.0.1:{COMPANION_PORT}{path}", data=body, method=method,
                                         headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                self.send_bytes(response.read(), "application/json", response.status)
        except urllib.error.HTTPError as error:
            self.send_bytes(error.read(), "application/json", error.code)
        except OSError:
            self.send_bytes(b'{"error":"companion down"}', "application/json", 503)

    def do_POST(self):
        if self.path.startswith("/__companion/"):
            return self.proxy("POST")
        self.send_error(404)

    def do_GET(self):
        route = self.path.split("?")[0]
        if route.startswith("/__companion/"):
            return self.proxy("GET")
        if route == "/__data.json":
            return self.send_bytes(DATA.read_bytes(), "application/json")
        if route in ("/__mock.js", "/__scenarios.js"):
            return self.send_bytes((HARNESS / route[3:]).read_bytes(), "text/javascript")
        if route in ("/chat.html", "/compose.html"):
            html = (EXTENSION / route[1:]).read_text(encoding="utf-8")
            html = html.replace("<head>", '<head>\n<script src="/__mock.js"></script>\n<script src="/__scenarios.js" defer></script>', 1)
            return self.send_bytes(html.encode("utf-8"), "text/html; charset=utf-8")
        return super().do_GET()


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
