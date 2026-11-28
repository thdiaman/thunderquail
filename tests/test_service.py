import hashlib
import re
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path
from time import monotonic

import numpy as np

from companion.__main__ import create_app
from companion.embeddings import Embedder
from companion.profile import Mailbox
from companion.service import IndexService


LOOPBACK = "http://127.0.0.1"


class FakeEmbedder:
    """Deterministic bag-of-words vectors. Embedding text with GATE_WORD blocks until `gate` is set."""

    identity = ["fake", "bag-of-words"]
    model = "fake-model"
    GATE_WORD = "gatedword"

    def __init__(self):
        self.gate = threading.Event()
        self.gate.set()

    def embed(self, texts, *, query=False):
        if not query and any(self.GATE_WORD in text for text in texts):
            assert self.gate.wait(30), "gate was never opened"
        vectors = []
        for text in texts:
            vector = np.zeros(32, dtype=np.float32)
            for word in re.findall(r"[a-z]+", text.lower()):
                vector[int(hashlib.sha256(word.encode()).hexdigest(), 16) % 32] += 1
            vector[0] += 0.01
            vectors.append((vector / np.linalg.norm(vector)).tolist())
        return vectors


def message(number, subject, body):
    return (f"From sender@example.com Mon Jan  1 00:00:00 2024\nFrom: Sender <sender@example.com>\n"
            f"To: me@example.com\nSubject: {subject}\nDate: Mon, 01 Jan 2024 00:00:00 +0000\n"
            f"Message-ID: <m{number}@example.com>\n\n{body}\n\n")


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.directory, ignore_errors=True)
        self.inbox = self.directory / "INBOX"
        self.archive = self.directory / "Archive"
        self.inbox.write_text(message(1, "Invoice", "Please pay the invoice for the garden project."))
        self.archive.write_text(message(2, "Holiday", "The gatedword trip to the mountains was great."))
        self.embedder = FakeEmbedder()
        self.services = []

    def service(self, **options):
        mailboxes = [Mailbox("account1", "Test", (self.archive.name,), self.archive),  # Deliberately first.
                     Mailbox("account1", "Test", ("INBOX",), self.inbox)]
        labels = {mailbox.path: " / ".join(("Test", *mailbox.folders)) for mailbox in mailboxes}
        options.setdefault("poll_seconds", 0)
        service = IndexService(self.directory / "index", (mailboxes, [], labels), lambda: self.embedder,
                               report=lambda line: None, **options)
        self.services.append(service)
        self.addCleanup(service.stop)
        return service

    def wait_for(self, condition, timeout=20):
        deadline = monotonic() + timeout
        while monotonic() < deadline:
            if condition():
                return
            time.sleep(0.02)
        self.fail("Timed out waiting for the condition.")

    def folder_states(self, service):
        return {folder["folders"][-1]: folder["state"] for folder in service.status()["folders"]}

    def test_search_works_during_the_first_build_and_inbox_comes_first(self):
        self.embedder.gate.clear()
        service = self.service()
        service.start()
        self.wait_for(lambda: self.folder_states(service).get("INBOX") == "indexed")
        status = service.status()
        self.assertEqual(status["state"], "indexing")
        self.assertTrue(status["searchable"])
        self.assertEqual(self.folder_states(service)["Archive"], "indexing")
        folders = {folder["folders"][-1]: folder for folder in status["folders"]}
        self.assertIsNone(folders["Archive"]["indexed_through"])
        self.assertTrue(folders["INBOX"]["indexed_through"])
        self.assertEqual(status["progress"]["folders_total"], 2)
        results = service.search("invoice garden", 3)
        self.assertEqual([row["subject"] for row in results], ["Invoice"])
        self.embedder.gate.set()
        self.wait_for(lambda: service.status()["state"] == "ready")
        self.assertEqual(set(self.folder_states(service).values()), {"indexed"})
        self.assertEqual({row["subject"] for row in service.search("holiday mountains invoice", 5)},
                         {"Invoice", "Holiday"})

    def test_rescan_picks_up_new_mail_and_coalesces_requests(self):
        service = self.service()
        service.start()
        self.wait_for(lambda: service.status()["state"] == "ready")
        scans = []
        original = service._scan
        service._scan = lambda: scans.append(1) or original()
        with self.inbox.open("a") as mailbox:
            mailbox.write(message(3, "Lunch", "Shall we meet for lunch on Friday?"))
        self.assertEqual(service.search("lunch friday", 3)[0]["subject"], "Invoice")  # Not indexed yet.
        for _ in range(10):
            service.request_rescan()
        self.wait_for(lambda: any(row["subject"] == "Lunch" for row in service.search("lunch friday", 3)))
        self.wait_for(lambda: service.status()["state"] == "ready")
        time.sleep(0.3)
        self.assertLessEqual(len(scans), 2)  # Ten requests cause at most two passes.

    def test_polling_finds_new_mail_without_a_request(self):
        service = self.service(poll_seconds=1)
        service.start()
        self.wait_for(lambda: service.status()["state"] == "ready")
        with self.archive.open("a") as mailbox:
            mailbox.write(message(4, "Tax", "The tax return is due in April."))
        self.wait_for(lambda: any(row["subject"] == "Tax" for row in service.search("tax return april", 3)))

    def test_unchanged_poll_does_not_flip_to_indexing(self):
        service = self.service(poll_seconds=1)
        service.start()
        self.wait_for(lambda: service.status()["state"] == "ready")
        states = set()
        end = monotonic() + 3.5
        while monotonic() < end:
            states.add(service.status()["state"])
            time.sleep(0.02)
        self.assertEqual(states, {"ready"})

    def test_new_mail_makes_the_folder_pending_with_its_old_indexed_through_time(self):
        service = self.service()
        service.start()
        self.wait_for(lambda: service.status()["state"] == "ready")
        before = {folder["folders"][-1]: folder["indexed_through"] for folder in service.status()["folders"]}
        self.assertTrue(all(before.values()))
        self.embedder.gate.clear()
        with self.archive.open("a") as mailbox:
            mailbox.write(message(5, "Slow", "Another gatedword message."))
        service.request_rescan()
        self.wait_for(lambda: self.folder_states(service)["Archive"] in ("indexing", "pending"))
        folders = {folder["folders"][-1]: folder for folder in service.status()["folders"]}
        self.assertEqual(folders["Archive"]["indexed_through"], before["Archive"])
        self.assertEqual(folders["INBOX"]["state"], "indexed")
        self.embedder.gate.set()
        self.wait_for(lambda: self.folder_states(service)["Archive"] == "indexed")

    def test_restart_reuses_the_index_and_serves_immediately(self):
        first = self.service()
        first.start()
        self.wait_for(lambda: first.status()["state"] == "ready")
        first.stop()
        second = self.service()
        second.start()
        self.wait_for(lambda: second.status()["state"] == "ready")
        self.assertEqual(second.search("invoice garden", 3)[0]["subject"], "Invoice")

    def test_a_failing_scan_reports_an_error_and_keeps_serving(self):
        service = self.service()
        service.start()
        self.wait_for(lambda: service.status()["state"] == "ready")
        self.archive.write_bytes(b"this is not an mbox file\n")
        service.request_rescan()
        self.wait_for(lambda: service.status()["state"] == "error")
        self.assertTrue(service.status()["error"])
        self.assertEqual(service.search("invoice garden", 3)[0]["subject"], "Invoice")

    def test_http_endpoints_require_the_token_and_rescan_returns_at_once(self):
        service = self.service()
        service.start()
        self.wait_for(lambda: service.status()["state"] == "ready")
        client = create_app(service, "t" * 43).test_client()
        auth = {"Authorization": "Bearer " + "t" * 43}
        health = client.get("/health", base_url=LOOPBACK).get_json()
        self.assertEqual((health["state"], health["searchable"]), ("ready", True))
        self.assertNotIn("folders", health)
        for method, path in (("get", "/status"), ("post", "/rescan"), ("get", "/scopes"), ("post", "/search")):
            self.assertEqual(getattr(client, method)(path, base_url=LOOPBACK).status_code, 401, path)
        started = monotonic()
        response = client.post("/rescan", headers=auth, base_url=LOOPBACK)
        self.assertEqual(response.status_code, 202)
        self.assertLess(monotonic() - started, 2)
        self.assertIn("folders", client.get("/status", headers=auth, base_url=LOOPBACK).get_json())
        found = client.post("/search", headers=auth, base_url=LOOPBACK, json={"query": "invoice garden", "top_k": 2}).get_json()
        self.assertEqual(found["results"][0]["subject"], "Invoice")
        self.assertEqual(found["index"]["state"] in ("ready", "indexing"), True)

    def test_searching_while_commits_land_never_fails(self):
        folders = []
        for number in range(8):
            path = self.directory / f"Folder{number}"
            path.write_text("".join(message(100 * number + item, f"Topic {number}-{item}",
                                            f"Discussion {number} about project word{item} in folder {number}.")
                                    for item in range(40)))
            folders.append(Mailbox("account1", "Test", (path.name,), path))
        labels = {mailbox.path: mailbox.path.name for mailbox in folders}
        service = IndexService(self.directory / "stress-index", (folders, [], labels), lambda: self.embedder,
                               poll_seconds=0, report=lambda line: None)
        self.addCleanup(service.stop)
        failures, searches, seen = [], [0], set()
        done = threading.Event()

        def search_loop():
            while not done.is_set():
                try:
                    seen.add(len(service.search("project discussion", 50)))
                    searches[0] += 1
                except Exception as error:  # Any exception here is a failure of the design.
                    failures.append(repr(error))

        searcher = threading.Thread(target=search_loop)
        searcher.start()
        service.start()
        self.wait_for(lambda: service.status()["state"] == "ready", timeout=60)
        done.set()
        searcher.join()
        self.assertEqual(failures, [])
        self.assertGreater(searches[0], 5)
        self.assertGreater(len(seen), 2)  # Results grew as commits landed.
        self.assertEqual(len(service.search("project discussion", 50)), 50)

    def test_search_before_any_index_exists_returns_nothing(self):
        self.embedder.gate.clear()
        service = self.service()
        self.assertEqual(service.search("anything", 3), [])
        self.assertEqual(service.status()["state"], "starting")


class QueryPriorityTests(unittest.TestCase):
    def test_a_query_runs_between_indexing_slices(self):
        embedder = object.__new__(Embedder)
        embedder._turn = threading.Condition()
        embedder._queries_waiting = 0
        order = []

        def fake_embed(texts, query):
            order.append("query" if query else "index")
            time.sleep(0.2)
            return [[1.0]] * len(texts)

        embedder._embed = fake_embed
        indexing = threading.Thread(target=lambda: embedder.embed(["text"] * 32))
        indexing.start()
        time.sleep(0.3)
        started = monotonic()
        embedder.embed(["question"], query=True)
        waited = monotonic() - started
        indexing.join()
        self.assertLess(waited, 0.7)  # At most the running slice plus its own run, not the 4 slices.
        self.assertLess(order.index("query"), len(order) - 2)


if __name__ == "__main__":
    unittest.main()
