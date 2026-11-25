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
2. Set the release version in `extension/manifest.json` and land the change on `main`. Tag that commit with `v` followed by the exact manifest version, such as `v0.12.4`, and push the tag. Wait for the release workflow to finish before pushing the next release tag.
3. Verify the [published update feed](https://thdiaman.github.io/thunderquail/updates.json) points to the new GitHub XPI. The workflow publishes both packages before it commits the new feed and deploys GitHub Pages. If a run fails after publishing the release, rerun it from the same tag.
4. Download `thunderquail-atn.xpi` from the release and submit it manually to Add-ons for Thunderbird (ATN). Once the listing is public, replace the search link in `docs/index.html` with the direct listing URL.

## Use ThunderQuail

- **Chat.** Select one email to include it as context. Press **Enter** to send or **Shift+Enter** for a new line. Use **Stop** during search or streaming and **Retry** after a failed turn.
- **Compose.** Click **ThunderQuail** in the compose toolbar to draft or rewrite. Review the preview before applying it. **Writing system prompt** in Settings customizes phrasing, greetings, and tone for chat and compose.
- **Mailbox actions.** Use a model that supports streaming tool calls, then ask to create, rename, or move a folder or to move messages. Review the action before approving it. Requests to delete or remove mail move it to the account's Junk folder after confirmation.

## Add indexed search

1. Open **Help > Troubleshooting Information > Profile Folder > Open Folder** in Thunderbird and copy the path to the folder containing `prefs.js`.
2. From the repository root, use Python 3.10 or later. This example runs in PowerShell:

   ```powershell
   python -m pip install -r companion/requirements.txt
   $env:THUNDERQUAIL_TOKEN = [guid]::NewGuid().ToString('N')
   python -m companion --profile 'C:\path\to\profile' --db-dir "$env:LOCALAPPDATA\ThunderQuail\index"
   ```

3. Wait for **Index ready**. In ThunderQuail Settings, set **Local indexer URL** to `http://127.0.0.1:5000` and **Companion token** to the same value as `THUNDERQUAIL_TOKEN`. Save the settings.
4. **Search Index** starts enabled. Click it in the chat panel to toggle retrieval. Use **Settings > Indexed search scope** to restrict results by account or folder, and **Index coverage** to check for skipped stores. Chat continues if the companion is offline or a search times out.

The companion reads MBOX files without locking or modifying them. It downloads `intfloat/multilingual-e5-small` on first use, runs embeddings locally with ONNX Runtime, and stores the vectors and searchable text in LanceDB outside the Thunderbird profile. Coverage includes mail bodies cached locally in MBOX format. Restart the companion with the same database directory to pick up changes or resume an interrupted build. Existing embeddings are reused when possible.

Run `python -m companion --check-embeddings` to verify the embedding model without opening a mailbox. The companion binds to loopback. `GET /health` reports readiness, and `GET /scopes` and `POST /search` require the companion bearer token.

## What the chat provider receives

On Send, the configured provider receives your prompt, prior turns in the current chat, and the selected email's subject, sender, and up to 12,000 characters of readable body. With **Search Index** enabled, it can also receive up to four excerpts with subject, sender, date, and up to 1,200 characters of text each. Turning search off excludes indexed excerpts for new requests. Prior replies may still quote email text. Use **Settings > Clear chat history** to clear that history. Mailbox proposals can also include folder names and the subjects of selected messages. The LanceDB database and embedding vectors stay local.
