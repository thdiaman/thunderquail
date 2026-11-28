"""Drives the extension's chat and compose pages in headless Edge, with a mock Thunderbird `browser` and a REAL companion.

Usage: python tests/ui/run.py [scenario ...]   (VERBOSE=1 shows every check, SHOTS=<dir> saves screenshots,
EDGE=<path to msedge.exe> if Edge is elsewhere). It builds a synthetic profile and index in a temporary directory,
isolates the companion token from your real one, and never touches your Thunderbird profile or index.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HARNESS = Path(__file__).resolve().parent
EDGE = os.environ.get("EDGE") or next((str(path) for path in (
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe")) if path.is_file()), "msedge")
COMPANION_PORT, SERVER_PORT = 49998, 8801
SCENARIOS = {
    "layout": "cport=49998", "whatsnew": "cport=49998", "narrow": "cport=49998", "search": "cport=49998",
    "email": "cport=49998", "offline": "cport=49997", "notsetup": "cport=none", "measure": "cport=49998",
    "composeEmpty": "page=compose&tabtype=messageCompose", "composeSelection": "page=compose&tabtype=messageCompose&sel=1",
}
wanted = sys.argv[1:] or list(SCENARIOS)
screenshots = os.environ.get("SHOTS")

work = Path(tempfile.mkdtemp(prefix="tq-harness-"))
processes = []


def run_edge(command, timeout=180):
    """Runs Edge once and returns its output. Edge's helper processes can keep a pipe open after the page is dumped,
    so the output goes to a file, and the whole process tree is stopped as soon as the dump (or screenshot) is complete."""
    output = work / f"edge-output-{time.monotonic_ns()}.txt"
    screenshot = next((arg.split("=", 1)[1] for arg in command if arg.startswith("--screenshot=")), None)
    with output.open("wb") as sink:
        process = subprocess.Popen(command, stdout=sink, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and process.poll() is None:
            if screenshot:
                if Path(screenshot).is_file():
                    time.sleep(1)
                    break
            elif "</html>" in output.read_text(encoding="utf-8", errors="replace"):
                break
            time.sleep(0.5)
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(process.pid)], capture_output=True)
    return output.read_text(encoding="utf-8", errors="replace")


def probe(token):
    """A quick check that the companion still answers. Printed after each scenario with VERBOSE=1 or on a failure."""
    started = time.monotonic()
    try:
        request = urllib.request.Request(f"http://127.0.0.1:{COMPANION_PORT}/status", headers={"Authorization": f"Bearer {token}"})
        state = json.load(urllib.request.urlopen(request, timeout=5))["state"]
    except Exception as error:
        state = f"NOT ANSWERING ({type(error).__name__})"
    return f"companion {state} in {time.monotonic() - started:.2f}s"


def start(args, **kwargs):
    # Never use an unread pipe here: the companion logs every request, and a full pipe would block it.
    log = (work / f"process-{len(processes)}.log").open("wb")
    process = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT, **kwargs)
    processes.append(process)
    return process


try:
    subprocess.run([sys.executable, str(HARNESS / "make_data.py"), str(work)], check=True)
    env = {**os.environ, "LOCALAPPDATA": str(work / "appdata"), "PYTHONWARNINGS": "ignore"}
    token = subprocess.run([sys.executable, "-W", "ignore", "-m", "companion", "--show-token"], cwd=REPO, env=env,
                           capture_output=True, text=True, check=True).stdout.strip()
    companion = start([sys.executable, "-W", "ignore", "-m", "companion", "--profile", str(work / "profile"),
                       "--db-dir", str(work / "db"), "--port", str(COMPANION_PORT), "--poll-seconds", "0"], cwd=REPO, env=env)
    for _ in range(240):
        try:
            health = json.load(urllib.request.urlopen(f"http://127.0.0.1:{COMPANION_PORT}/health", timeout=2))
            if health["state"] == "ready":
                print("companion ready:", health)
                break
        except OSError:
            pass
        time.sleep(0.5)
    else:
        raise SystemExit("companion did not become ready")
    start([sys.executable, str(HARNESS / "server.py"), str(REPO / "extension"), str(work / "data.json"),
           str(SERVER_PORT), str(COMPANION_PORT), token])
    time.sleep(1)

    failures = 0
    for name in wanted:
        profile = work / f"edge-{name}"
        page = "compose" if name.startswith("compose") else "chat"
        url = f"http://127.0.0.1:{SERVER_PORT}/{page}.html?window=1&scenario={name}&{SCENARIOS[name]}"
        command = [EDGE, "--headless=new", "--disable-gpu", f"--user-data-dir={profile}", "--window-size=440,820",
                   "--virtual-time-budget=90000", "--dump-dom", url]
        output = run_edge(command)
        match = re.search(r'<pre id="__result">(.*?)</pre>', output, re.S)
        if not match:
            print(f"[{name}] NO RESULT\n{output[:600]}")
            failures += 1
            continue
        import html
        result = json.loads(html.unescape(match.group(1)))
        print(f"[{name}] {'PASS' if result['ok'] else 'FAIL'}")
        for item in result["checks"]:
            if not item["ok"] or os.environ.get("VERBOSE"):
                print(f"    {'ok  ' if item['ok'] else 'FAIL'} {item['label']} :: {item['detail']}")
        if not result["ok"] or os.environ.get("VERBOSE"):
            print(f"    {probe(token)}")
        failures += not result["ok"]
        if screenshots:
            run_edge([EDGE, "--headless=new", "--disable-gpu", f"--user-data-dir={profile}-shot", "--window-size=440,820",
                      "--virtual-time-budget=90000", f"--screenshot={screenshots}/{name}.png", url])
    print("FAILURES:", failures)
finally:
    for process in processes:
        process.terminate()
    time.sleep(1)
    shutil.rmtree(work, ignore_errors=True)
