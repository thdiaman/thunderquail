import json
import logging
import os
import re
from email import errors, policy
from email.parser import BytesParser
from hashlib import sha256
from html.parser import HTMLParser


CHUNK_LENGTH = 1200
CHUNK_OVERLAP = 150
_QUOTED_FROM = re.compile(rb"^>+From ")
_HTML_BREAKS = {"blockquote", "br", "div", "h1", "h2", "h3", "hr", "li", "p", "pre", "tr"}
_HTML_IGNORED = {"head", "script", "style", "template"}
_MAIL_PARSE_ERRORS = (
    errors.MessageError, ValueError, LookupError, TypeError, AttributeError, AssertionError, RecursionError,
)
_LOGGER = logging.getLogger(__name__)


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


def _parse_message(parser, message):
    try:
        return parser.parsebytes(bytes(message))
    except _MAIL_PARSE_ERRORS as error:
        _LOGGER.warning("Skipping a malformed MBOX message (%s).", type(error).__name__)
        return None


class MailboxChanged(ValueError):
    pass


def read_records(path, expected, *, start=0, end=None, on_bytes=None, on_position=None):
    end = expected[2] if end is None else end
    parser = BytesParser(policy=policy.default)
    with path.open("rb") as source:
        if fingerprint(os.fstat(source.fileno())) != expected:
            raise MailboxChanged(f"Mailbox changed before reading: {path}")
        source.seek(start)
        message = None
        in_headers = False
        offset = start
        while offset < end:
            line = source.readline(end - offset)
            if not line:
                raise MailboxChanged(f"Mailbox changed during indexing: {path}")
            line_start = offset
            offset += len(line)
            if on_bytes is not None:
                on_bytes(line)
            if line.startswith(b"From "):
                if message is not None:
                    if on_position is not None:
                        on_position(line_start)
                    yield message_start, line_start, _parse_message(parser, message) if message else None
                message = bytearray()
                message_start = line_start
                in_headers = True
            elif message is not None:
                if not in_headers and _QUOTED_FROM.match(line):
                    line = line[1:]
                message.extend(line)
                if not line.strip():
                    in_headers = False
            elif line.strip():
                raise ValueError(f"File does not start with an MBOX separator: {path}")
        if message is not None:
            if on_position is not None:
                on_position(end)
            yield message_start, end, _parse_message(parser, message) if message else None
        if fingerprint(os.fstat(source.fileno())) != expected:
            raise MailboxChanged(f"Mailbox changed during indexing: {path}")


def _clean_unicode(text):
    return text.encode("utf-8", errors="replace").decode("utf-8")


def _header_text(message, name, fallback):
    try:
        value = str(message.get(name, ""))
    except _MAIL_PARSE_ERRORS:
        value = " ".join(fallback.splitlines()).strip()
    return _clean_unicode(value)


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


def message_chunks(message):
    if message is None or _expunged(message):
        return None, []
    raw_headers = {}
    for name, value in message.raw_items():
        raw_headers.setdefault(name.lower(), value)
    metadata = {
        key: _header_text(message, header, raw_headers.get(header.lower(), ""))
        for key, header in (("subject", "Subject"), ("from", "From"), ("to", "To"),
                            ("date", "Date"), ("message_id", "Message-ID"))
    }
    try:
        body = _body_text(message)
    except _MAIL_PARSE_ERRORS as error:
        _LOGGER.warning("Using subject only for an unreadable MBOX body (%s).", type(error).__name__)
        body = ""
    # The Message-ID is part of the identity. Content distinguishes reused or missing IDs.
    identity = sha256(json.dumps([metadata, body], ensure_ascii=False).encode("utf-8")).hexdigest()
    rows = [{**metadata, "chunk_index": index, "text": text, "message_key": identity}
            for index, text in enumerate(_chunk_text(body or metadata["subject"]))]
    return (identity if rows else None), rows
