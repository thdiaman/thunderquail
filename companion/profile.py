import json
import re
from base64 import b64decode
from collections import defaultdict
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

from .mbox import fingerprint


_PREF = re.compile(r'^user_pref\(("(?:[^"\\]|\\.)*"),\s*(.*?)\);$')
_MAIL_TYPES = {"none", "pop3", "imap", "rss"}
_MBOX_STORE = "@mozilla.org/msgstore/berkeleystore;1"


@dataclass(frozen=True)
class Mailbox:
    account: str
    account_name: str
    folders: tuple[str, ...]
    path: Path
    account_email: str = ""


@dataclass(frozen=True)
class SearchScope:
    label: str
    kind: str
    paths: tuple[Path, ...]


def _read_preferences(profile):
    source = profile / "prefs.js"
    before = fingerprint(source.stat())
    text = source.read_text(encoding="utf-8-sig")
    if fingerprint(source.stat()) != before:
        raise ValueError("Thunderbird preferences changed during profile discovery. Try again.")
    prefs = {}
    for line in text.splitlines():
        match = _PREF.fullmatch(line.strip())
        if match:
            try:
                prefs[json.loads(match[1])] = json.loads(match[2])
            except json.JSONDecodeError:
                continue
    return prefs


def _store_path(profile, get):
    relative = get("directory-rel")
    if isinstance(relative, str) and relative.startswith("[ProfD]"):
        return profile / relative[len("[ProfD]"):]
    absolute = get("directory")
    if isinstance(absolute, str) and Path(absolute).is_absolute():
        return Path(absolute)
    return None


def _scan_store(directory, account, name, parents, warnings, *, email=""):
    try:
        directory = directory.resolve(strict=True)
        entries = sorted(directory.iterdir(), key=lambda path: path.name.casefold())
    except OSError:
        warnings.append(f"{name}: could not read {directory}.")
        return
    for entry in entries:
        if entry.is_symlink():
            continue
        if entry.is_dir():
            if entry.name.endswith(".sbd") and entry.stem:
                if entry.resolve().parent == directory:
                    yield from _scan_store(entry, account, name, (*parents, entry.stem), warnings, email=email)
                else:
                    warnings.append(f"{name}: skipped linked folder {' / '.join((*parents, entry.stem))}.")
            continue
        if entry.suffix.lower() == ".msf":
            # A summary without an MBOX can belong to an empty folder.
            continue
        if entry.name == "msgFilterRules.dat" or not entry.is_file():
            continue
        summary = entry.with_name(entry.name + ".msf").is_file()
        try:
            with entry.open("rb") as source:
                header = source.read(5)
            if header == b"From " or (not header and summary):
                yield Mailbox(account, name, (*parents, entry.name), entry.resolve(), email)
            elif summary:
                warnings.append(f"{name}: {' / '.join((*parents, entry.name))} is not an MBOX file.")
        except OSError:
            warnings.append(f"{name}: could not read {' / '.join((*parents, entry.name))}.")


def discover_profile(profile):
    prefs = _read_preferences(profile)
    accounts = prefs.get("mail.accountmanager.accounts", "")
    if not isinstance(accounts, str) or not accounts.strip():
        raise ValueError("The selected Thunderbird profile has no configured mail accounts.")
    mailboxes, warnings = [], []
    for account in dict.fromkeys(value.strip() for value in accounts.split(",") if value.strip()):
        server = prefs.get(f"mail.account.{account}.server")
        if not server:
            warnings.append(f"{account}: no account server configuration.")
            continue
        prefix = f"mail.server.{server}."
        def get(key, default=None):
            return prefs.get(prefix + key, default)

        name = get("name") or get("hostname") or account
        kind = get("type")
        if kind not in _MAIL_TYPES or get("storeContractID", _MBOX_STORE) != _MBOX_STORE:
            warnings.append(f"{name}: unsupported account or message store type.")
            continue
        directory = _store_path(profile, get)
        if directory is None:
            warnings.append(f"{name}: no configured local mailbox directory.")
            continue
        if get("deferred_to_account"):
            warnings.append(f"{name}: mail delivered to another account is searchable under that account.")
        identity = str(prefs.get(f"mail.account.{account}.identities", "")).split(",")[0].strip()
        email = prefs.get(f"mail.identity.{identity}.useremail", "")
        mailboxes.extend(_scan_store(directory, account, name, (), warnings, email=email if isinstance(email, str) else ""))
    return mailboxes, warnings


def _imap_display_name(name):
    def decode(match):
        encoded = match[1].replace(",", "/")
        if not encoded:
            return "&"
        try:
            return b64decode(encoded + "=" * (-len(encoded) % 4), validate=True).decode("utf-16-be")
        except ValueError:
            return match[0]

    return re.sub(r"&([A-Za-z0-9+,]*)-", decode, name)


def mailbox_labels(profile, mailboxes):
    try:
        cache = json.loads((profile / "folderCache.json").read_text(encoding="utf-8-sig"))
        entries = cache.items() if isinstance(cache, dict) else ()
        cache = {Path(key): value for key, value in entries if isinstance(value, dict)}
    except (OSError, ValueError):
        cache = {}

    labels = {}
    for mailbox in mailboxes:
        path = mailbox.path
        names = []
        for fallback in reversed(mailbox.folders):
            entry = cache.get(path.with_name(path.name + ".msf"), {})
            name = entry.get("folderName")
            if not isinstance(name, str) or not name:
                name = fallback
                online = entry.get("onlineName")
                delimiter = entry.get("hierDelim")
                if isinstance(online, str) and online:
                    if isinstance(delimiter, int) and 0 < delimiter < 128:
                        online = online.rsplit(chr(delimiter), 1)[-1]
                    name = _imap_display_name(online) or fallback
            names.append("Inbox" if name == "INBOX" else name)
            path = path.parent.with_suffix("") if path.parent.suffix == ".sbd" else path.parent
        account = mailbox.account_name
        if mailbox.account_email and mailbox.account_email.casefold() not in account.casefold():
            account = f"{account} ({mailbox.account_email})"
        labels.setdefault(mailbox.path, " / ".join((account, *reversed(names))))
    return labels


def build_scopes(mailboxes):
    folders = defaultdict(list)
    for mailbox in mailboxes:
        folders[(mailbox.account, mailbox.account_name)].append(mailbox)
    scopes = {}

    def add(kind, account, path, label, members):
        key = sha256(json.dumps([kind, account, path], ensure_ascii=False).encode()).hexdigest()
        scopes[key] = SearchScope(label, kind, tuple(dict.fromkeys(member.path for member in members)))

    for (account, name), members in folders.items():
        if account:
            add("account", account, (), name, members)
        parents = defaultdict(list)
        for member in members:
            label = " / ".join((name, *member.folders)) if name else " / ".join(member.folders)
            add("folder", account, member.folders, label, [member])
            for depth in range(1, len(member.folders) + 1):
                parents[member.folders[:depth]].append(member)
        for path, descendants in parents.items():
            if any(len(member.folders) > len(path) for member in descendants):
                add("subtree", account, path, " / ".join((name, *path)), descendants)
    return scopes
