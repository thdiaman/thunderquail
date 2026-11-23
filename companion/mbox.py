import json
import os
import re
from email import policy
from email.parser import BytesParser
from hashlib import sha256
from html.parser import HTMLParser


CHUNK_LENGTH = 1200
CHUNK_OVERLAP = 150
_QUOTED_FROM = re.compile(rb"^>+From ")
_HTML_BREAKS = {"blockquote", "br", "div", "h1", "h2", "h3", "hr", "li", "p", "pre", "tr"}
_HTML_IGNORED = {"head", "script", "style", "template"}


class BodyText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.ignored = []

    def handle_starttag(self, tag, attrs):
        if tag in _HTML_IGNORED:
            self.ignored.append(tag)
        elif not self.ignored and tag in _HTML_BREAKS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if self.ignored:
            if self.ignored[-1] == tag:
                self.ignored.pop()
        elif tag in _HTML_BREAKS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.ignored:
            self.parts.append(data)


def fingerprint(stat):
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns


def read_messages(path, expected):
    parser = BytesParser(policy=policy.default)
    with path.open("rb") as source:
        if fingerprint(os.fstat(source.fileno())) != expected:
            raise ValueError(f"Mailbox changed before reading: {path}")
        message = None
        in_headers = False
        for line in source:
            if line.startswith(b"From "):
                if message:
                    yield parser.parsebytes(bytes(message))
                message = bytearray()
                in_headers = True
            elif message is not None:
                if not in_headers and _QUOTED_FROM.match(line):
                    line = line[1:]
                message.extend(line)
                if not line.strip():
                    in_headers = False
            elif line.strip():
                raise ValueError(f"File does not start with an MBOX separator: {path}")
        if message:
            yield parser.parsebytes(bytes(message))
        if fingerprint(os.fstat(source.fileno())) != expected:
            raise ValueError(f"Mailbox changed during indexing: {path}")


def _clean_unicode(text):
    return text.encode("utf-8", errors="replace").decode("utf-8")


def _body_text(message):
    part = message.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    try:
        body = part.get_content()
    except LookupError:
        body = (part.get_payload(decode=True) or b"").decode("utf-8", errors="replace")
    if part.get_content_type() == "text/html":
        parser = BodyText()
        parser.feed(body)
        parser.close()
        body = "".join(parser.parts)
    return _clean_unicode(body).replace("\r\n", "\n").replace("\r", "\n").strip()


def _expunged(message):
    try:
        return bool(int(str(message.get("X-Mozilla-Status", "0")).strip(), 16) & 0x0008)
    except ValueError:
        return False


def _chunk_text(text):
    start = 0
    while start < len(text):
        end = min(start + CHUNK_LENGTH, len(text))
        if end < len(text):
            boundary = max(text.rfind(" ", start + CHUNK_LENGTH // 2, end),
                           text.rfind("\n", start + CHUNK_LENGTH // 2, end))
            if boundary >= 0:
                end = boundary
        chunk = text[start:end].strip()
        if chunk:
            yield chunk
        if end == len(text):
            break
        start = end - CHUNK_OVERLAP


def mailbox_chunks(path, expected):
    seen = set()
    for message in read_messages(path, expected):
        if _expunged(message):
            continue
        metadata = {
            key: _clean_unicode(str(message.get(header, "")))
            for key, header in (("subject", "Subject"), ("from", "From"), ("to", "To"),
                                ("date", "Date"), ("message_id", "Message-ID"))
        }
        body = _body_text(message)
        # The Message-ID is part of the identity. Content distinguishes reused or missing IDs.
        identity = sha256(json.dumps([metadata, body], ensure_ascii=False).encode("utf-8")).hexdigest()
        if identity in seen:
            continue
        seen.add(identity)
        texts = _chunk_text(body or metadata["subject"])
        for chunk_index, text in enumerate(texts):
            yield {
                **metadata,
                "mailbox": str(path),
                "chunk_index": chunk_index,
                "text": text,
                "message_key": identity,
            }
