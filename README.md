# ThunderQuail

ThunderQuail adds streaming chat, email drafting, and confirmed mailbox actions to Thunderbird. The optional Python companion searches a local index of cached mail.

## Install and configure the extension

For published builds, see the [downloads and channel-switching guide](https://thdiaman.github.io/thunderquail/). To build and install from source, follow the steps below.

1. Run `python package_extension.py` from the repository root.
2. In Thunderbird 128 or later, open **Add-ons and Themes > Extensions > gear icon > Install Add-on From File**. Select the XPI in `dist/`. Thunderbird prompts for extra permissions because the in-window panel uses an Experiment API.
3. Click the quail icon in the Mail window, then **Settings**. Enter an OpenAI-compatible API base URL ending in `/v1`, the model name, and its API key if required. Examples include local Ollama at `http://127.0.0.1:11434/v1` and Ollama Cloud at `https://ollama.com/v1`.
4. Click **Test chat connection**, grant access to the provider when prompted, then click **Save settings**.

For development, use **Debug Add-ons > Load Temporary Add-on** and select `extension/manifest.json`. Use **Reload** there after making changes.

## Publish a release

1. In the GitHub repository's **Settings > Pages**, set the source to **GitHub Actions**. Allow release tags in the `github-pages` environment if deployment restrictions apply. The release workflow's `GITHUB_TOKEN` needs permission to push the feed commit to `main`.
2. Bump the version in `extension/manifest.json` (for example, to `0.13.1`), commit the change on `main`, and push with `git push origin main`.
3. With the release commit still checked out, create and push a tag using `v` followed by the exact manifest version.

   ```powershell
   git tag v0.13.1
   git push origin v0.13.1
   ```

4. Wait for the GitHub Actions release workflow to finish. It publishes both packages, commits `docs/updates.json` to `main`, and deploys GitHub Pages. With `main` checked out, run `git pull --ff-only origin main` to get the workflow’s commit. Verify the [published update feed](https://thdiaman.github.io/thunderquail/updates.json) points to the new GitHub XPI. If a run fails after publishing the release, rerun it from the same tag.
5. Download `thunderquail-atn.xpi` from the release and submit it manually to Add-ons for Thunderbird (ATN). Once the listing is public, replace the search link in `docs/index.html` with the direct listing URL.

## Use ThunderQuail

- **Chat.** An empty chat follows the email selected in Thunderbird. The context strip below the chat header shows the provider host and lets you preview or remove the attachment before sending. Switch to **Full thread** to include excerpts from up to 24 messages in Thunderbird’s same-folder thread. The first send or a manual removal stops the chat from following the selection. Use **Sync** or **+ Attach selected** to change what you share. Turn off **Auto-attach selected email on new chat** under **Settings > Chat & compose** to attach messages manually.
- **Quick actions.** In an empty chat, a pill fills the composer so you can edit the prompt before sending. **New chat** clears the conversation. Press **Enter** to send or **Shift+Enter** for a new line. Use **Stop** during search or streaming and **Retry** after a failed turn.
- **Compose.** Click **ThunderQuail** in the compose toolbar to draft or rewrite. Select text before opening it to access **Rewrite**, **Shorten**, **Translate**, and tone shortcuts. Review the preview, then apply it to replace the selected text. **Writing system prompt** in Settings customizes phrasing, greetings, and tone for chat and compose.
- **Thunderbird identity.** When you share an email in chat, ThunderQuail includes the account’s display name if it can resolve the identity. The attachment preview shows the name alongside the email text. In the compose window, drafting uses the active From identity. New drafts leave the signature to Thunderbird unless you ask for one.
- **Message actions.** Use **Copy** to copy an assistant reply and **Context used** to see which email or indexed excerpts were shared. **Draft reply** prepares a prompt for the email used in that reply. Generated drafts offer **Open Reply in Thunderbird** when an original email is available, or **New Draft** to start a separate message. Review, edit, and send from the compose window.
- **Writing profile.** In **Settings > Writing > Writing profile from Sent mail**, all Sent folders start checked. Uncheck any you want to exclude, then click **Review Sent samples**. ThunderQuail selects up to 12 excerpts from the last 90 days, favoring a mix of folders, Greek and Latin writing, and message lengths. Each preview shows its source folder and can be edited or removed. Only the remaining excerpt text goes to your chat provider when you approve sharing. Review and save the resulting style guide to use it in compose and reply drafts. Repeat to rebuild it, or clear the profile and save to turn it off.
- **Mailbox actions.** Use a model that supports streaming tool calls, then ask to create, rename, or move a folder or to move messages. Review the action before approving it. Requests to delete or remove mail move it to the account's Junk folder after confirmation.

## Add indexed search

1. Use your checkout or extract **Source code (zip)** from the [latest ThunderQuail release](https://github.com/thdiaman/thunderquail/releases/latest). From that directory, use Python 3.10 or later. Install dependencies once, then start the companion:

   ```powershell
   python -m pip install -r companion/requirements.txt
   python -m companion
   ```

2. Wait for **Index ready** and leave that terminal open. In a second terminal in the same directory, run `python -m companion --show-token`. In **Settings > Indexing**, paste the token into **Companion token**, set the URL to `http://127.0.0.1:49371`, click **Test companion connection**, and save.
3. On later runs, use `python -m companion`. The companion reuses its token and index. If it cannot choose the profile, use `--profile` with the path shown under Thunderbird’s **Help > Troubleshooting Information > Profile Folder**. For an existing index in a custom location, pass the same `--db-dir` each time.
4. **Search Index** starts in **On demand** mode when the companion is configured. The chat model can request a search when your question needs mailbox history. Review and approve the excerpts before they go to your provider. Click a source beneath the answer to open the email in Thunderbird. Click **Search Index** to turn searching off. Under **Settings > Indexing**, use **Indexed search scope** to restrict results by account or folder and **Index coverage** to check for skipped stores. Chat continues if the companion is offline or a search times out.

The companion reads MBOX files without locking or modifying them. It downloads `intfloat/multilingual-e5-small` on first use, runs embeddings locally with ONNX Runtime, and stores the vectors and searchable text in LanceDB outside the Thunderbird profile. Coverage includes mail bodies cached locally in MBOX format. Restart the companion with the same database directory to pick up changes or resume an interrupted build. Existing embeddings are reused when possible. On Windows, the default index is in `%LOCALAPPDATA%\ThunderQuail\index`. The companion keeps the token in a separate file in the parent directory.

On startup, unchanged MBOX files are skipped. For files that have changed, the companion verifies old bytes sequentially and checks appended messages or records in changed blocks. It keeps existing search rows when only Thunderbird’s status headers changed and reconciles message offsets after compaction. An older index needs one scan to record offsets and block hashes. If the MBOX still matches the index checkpoint, unique Message-IDs let the companion reuse the existing rows without decoding and chunking those messages again.

Run `python -m companion --check-embeddings` to verify the embedding model without opening a mailbox. The companion binds to loopback. `GET /health` reports readiness, and `GET /scopes` and `POST /search` require the companion bearer token.

## What the chat provider receives

ThunderQuail checks outgoing model text locally for common credentials, including private keys, API tokens, and passwords in configuration snippets. When detected in a prompt, compose request, or email preview, the values are masked for review. The check is pattern-based and may miss unfamiliar formats.

Use **Never share** in an email preview to exclude that message from selected-email context, indexed excerpts, and Sent samples. **Skip this time** applies only to the current preview unless you also mark an email for exclusion. Manage saved exclusions in **Settings > Privacy**. Exclusions match the email's Message-ID across folders and accounts. ThunderQuail skips mail without a usable ID. The rule applies when ThunderQuail selects an email as a source.

On Send, the configured provider receives your prompt and prior chat turns. If you attached an email, it also receives its subject, sender, and up to 12,000 characters of readable body on each send. You can preview or exclude that email in the composer. With **Search Index** enabled, the model can send a search query to the local companion. If you approve the results preview, the provider receives up to four excerpts with subject, sender, date, and up to 1,200 characters of text each. Prior replies may still quote email text. Use **New chat** to clear the current conversation and its attachment. Mailbox proposals can also include folder names and the subjects of selected messages. The LanceDB database and embedding vectors stay local.
