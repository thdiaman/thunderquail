"""Builds a synthetic Thunderbird profile (prefs.js and MBOX files) and the dataset used by the mock browser."""
import json
import sys
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path

root = Path(sys.argv[1])
now = datetime.now(timezone.utc)
ago = lambda **kw: now - timedelta(**kw)

folders = [
    {"id": "f-inbox", "accountId": "account1", "path": "/Inbox", "name": "Inbox", "specialUse": ["inbox"]},
    {"id": "f-archive", "accountId": "account1", "path": "/Archive", "name": "Archive", "specialUse": []},
    {"id": "f-sent", "accountId": "account1", "path": "/Sent", "name": "Sent", "specialUse": ["sent"]},
]
messages = []


def add(folder, subject, author, body, when, read=True, indexed=True):
    number = len(messages) + 1
    messages.append({"id": number, "folderId": folder, "headerMessageId": f"<m{number}@example.com>", "subject": subject,
                     "author": author, "date": when.isoformat(), "read": read, "body": body, "indexed": indexed})


add("f-inbox", "Invoice for the garden project", "Anna <anna@example.com>",
    "Please pay the invoice for the garden project by Friday. The amount is 450 euros.", ago(days=5), read=False)
add("f-inbox", "Lunch on Saturday?", "Bob <bob@example.com>", "Are you free for lunch on Saturday at noon?", ago(days=4))
add("f-inbox", "Flight to Athens", "Travel <travel@example.com>",
    "Your flight to Athens departs at 9am from gate B12. Please arrive two hours early.", ago(days=6))
for index in range(1, 61):
    add("f-inbox", f"Newsletter {index}", "News <news@example.com>", f"This week's news digest number {index}.",
        ago(days=2 + index % 8, hours=index), read=False)
add("f-archive", "Old holiday photos", "Carol <carol@example.com>", "Here are the holiday photos from last summer.", ago(days=40))
add("f-inbox", "Invoice reminder: second notice", "Anna <anna@example.com>",
    "This is a reminder that the invoice for the garden project is still unpaid.", ago(hours=1), read=False, indexed=False)

data = {
    "accounts": [{"id": "account1", "name": "Local Folders", "identities": [{"name": "Me", "email": "me@example.com"}]}],
    "folders": folders, "messages": messages,
}
(root / "data.json").write_text(json.dumps(data), encoding="utf-8")

profile = root / "profile"
mail = profile / "Mail" / "Local Folders"
mail.mkdir(parents=True)
(profile / "prefs.js").write_text("\n".join([
    'user_pref("mail.accountmanager.accounts", "account1");',
    'user_pref("mail.account.account1.server", "server1");',
    'user_pref("mail.account.account1.identities", "id1");',
    'user_pref("mail.identity.id1.useremail", "me@example.com");',
    'user_pref("mail.server.server1.type", "none");',
    'user_pref("mail.server.server1.name", "Local Folders");',
    'user_pref("mail.server.server1.directory-rel", "[ProfD]Mail/Local Folders");',
    'user_pref("mail.server.server1.storeContractID", "@mozilla.org/msgstore/berkeleystore;1");',
]) + "\n", encoding="utf-8")

for folder, name in (("f-inbox", "Inbox"), ("f-archive", "Archive"), ("f-sent", "Sent")):
    text = ""
    for message in messages:
        if message["folderId"] == folder and message["indexed"]:
            when = datetime.fromisoformat(message["date"])
            text += (f"From {message['author'].split('<')[-1].rstrip('>')} Mon Jan  1 00:00:00 2024\n"
                     f"From: {message['author']}\nTo: me@example.com\nSubject: {message['subject']}\n"
                     f"Date: {format_datetime(when)}\nMessage-ID: {message['headerMessageId']}\n\n{message['body']}\n\n")
    (mail / name).write_text(text, encoding="utf-8")
    (mail / f"{name}.msf").write_text("", encoding="utf-8")
print("ok", len(messages))
