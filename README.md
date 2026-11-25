# ThunderQuail

A local-first AI assistant for Thunderbird. The extension provides streaming chat, optional email context, compose tools, and confirmed mailbox actions. The companion adds semantic search over incrementally indexed MBOX files.

## Install the XPI

In Thunderbird 128 or later, open **Add-ons and Themes → Extensions → gear icon → Install Add-on From File…** and choose [dist/thunderquail-0.12.4.xpi](dist/thunderquail-0.12.4.xpi). Thunderbird shows an expanded permission prompt because the in-window panel uses an Experiment API. Build or refresh the package from the project root with `python package_extension.py`. Run the companion separately if you want indexed search. [Thunderbird's packaging guide](https://developer.thunderbird.net/add-ons/hello-world-add-on) · [Experiment API permissions](https://developer.thunderbird.net/add-ons/mailextensions#experiment-apis)

## Try the development build

1. In Thunderbird 128 or later, open **Add-ons and Themes → Extensions → gear icon → Debug Add-ons**.
2. Click **Load Temporary Add-on…** and select [extension/manifest.json](extension/manifest.json).
3. Click **ThunderQuail** in the lower-right corner of the Mail window, then choose **Settings**.
4. Enter the chat provider's API root, API key if required, and model name. Click **Test chat connection** to send a synthetic prompt. Click **Save settings** to make the configuration available to chat and compose.

Use **Reload** on the Debug Add-ons page after editing the extension. Load the manifest again after restarting Thunderbird. The API key is stored locally in your Thunderbird profile.

## Try standalone chat

1. Save a chat model and the API base URL for a running OpenAI-compatible provider. For example, a base URL of `http://127.0.0.1:11434/v1` sends chat requests to `http://127.0.0.1:11434/v1/chat/completions`.
2. Click the lower-right quail icon and send a prompt with **Enter**. Use **Shift+Enter** for a new line. Messages support Markdown. Drag the upper-left corner to resize the panel. The controls minimize it, maximize or restore its saved size, and reset to the default size.
3. To summarize emails as you browse, select or open one email. ThunderQuail shows its subject below the prompt and includes its readable text when you send a message such as “Summarize this email in three bullets.” Selecting mail updates the subject preview. **Send** shares the text with the configured chat provider.

The companion is optional for these steps. The chat provider receives your prompts, the email context you include, and earlier turns from the same chat. Use **Settings → Clear chat history** to clear the panel conversation. Email context contains the subject, sender, and up to 12,000 characters of readable body text.

## Search indexed mail from chat

1. Start the companion using the instructions below. In ThunderQuail settings, set **Local indexer URL** to `http://127.0.0.1:5000` (or your configured port) and **Companion token** to the same value as `THUNDERQUAIL_TOKEN`.
2. **Search Index** starts enabled in the chat panel. Click it to turn indexed search off or on. ThunderQuail remembers your choice and searches when you send a prompt. It starts with **All indexed mail**. Under **Settings → Indexed search scope** you can choose an account, a folder, or a folder and its subfolders. The selected or open email is included independently of the search scope.
3. Expand **Indexed mail used** under the answer to match the model's references to the retrieved excerpts. ThunderQuail sends up to four matching excerpts to your chat provider for that turn. The raw excerpts are excluded from later requests, though earlier answers may refer to or quote them.

If search exceeds the configured timeout, the token is rejected, or the companion is unavailable, chat continues with the prompt and any readable selected email. The timeout defaults to two seconds and can be increased in Settings for larger indexes. Compose tools and mailbox actions work independently of the companion.

## Configure chat and local embeddings

Chat and compose use the provider set in the extension. Choose local Ollama at `http://127.0.0.1:11434/v1` or Ollama Cloud at `https://ollama.com/v1`. For direct cloud access use an Ollama API key and a cloud chat model. Mailbox proposals also require the chat model to support streaming tool calls. [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)

**Settings → Writing system prompt** adds style instructions to chat and compose. The default asks for idiomatic language, natural email greetings and closings, and a level of formality suited to the recipient.

The companion downloads the default `intfloat/multilingual-e5-small` model from Hugging Face on the first run and loads it in Python with ONNX Runtime on the CPU. It embeds mail chunks and queries locally. Once the model has been cached, set `HF_HUB_OFFLINE=1` for offline startup. To use `--embedding-model` with a different repository, choose one with a tokenizer and a compatible self-contained `onnx/model.onnx` export that provides sentence embeddings or token embeddings intended for mean pooling. Use `--embedding-revision` to pin a revision. [Default model card](https://huggingface.co/intfloat/multilingual-e5-small)

After installing the companion requirements, run this check from the project root. It embeds synthetic text locally and requires no mailbox, database, or companion token.

```powershell
.\.venv\Scripts\python.exe -m companion --check-embeddings
```

The companion keeps the embedding model loaded while Flask is running. Each indexed search uses the same model to embed one query. Changing the chat model does not require reindexing.

## Try compose tools

1. Configure the chat provider, then open a new message or draft. To rewrite a passage, select it in the message body before clicking **ThunderQuail** in the compose toolbar.
2. Choose **Draft from a prompt**, **Rewrite selected text**, or **Rewrite entire draft**. Enter instructions and click **Generate preview**. For rewrites, a blank instruction asks for improvements to clarity and grammar.
3. Review or edit the preview, then apply it. Draft mode appends the generated text. The rewrite options replace the selected passage or the whole body with the preview's plain text.

Test with a disposable draft that has a recipient, subject, attachment, and text before and after a selected passage. After applying a selection rewrite, verify those fields and the surrounding text, then try Thunderbird's **Undo**. The companion can be stopped.

## Try mailbox actions

1. Use a chat model that supports streaming function calls. Open ThunderQuail chat from the Mail tab or the message you want to work with.
2. Ask for a change directly in chat. For example, ask “Create a folder named ThunderQuail Test under Local Folders” or “Move the selected messages to ThunderQuail Test.” Use account names and full folder paths when names overlap.
3. Review the exact folders and messages in the confirmation card. Click **Apply action** to proceed or **Cancel** to leave the mailbox untouched.

For a Junk test, select a disposable message and ask “Move the selected message to Junk.” Requests to delete or remove mail are routed to Move to Junk. Each selected message uses its source account's configured Junk folder. If the destination is unavailable or ambiguous, the action stops. The companion can be stopped for all these tests.

When the chat model requests a mailbox proposal, ThunderQuail sends account and folder names and selected message subjects for planning. The proposal requires confirmation before Thunderbird changes anything.

## Run the local companion

In Thunderbird, open **Help → Troubleshooting Information → Profile Folder → Open Folder**. Copy the path to the folder containing `prefs.js`. Run these commands from the project root in PowerShell with Python 3.10 or later.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r companion/requirements.txt
$env:THUNDERQUAIL_TOKEN = [guid]::NewGuid().ToString('N')
.\.venv\Scripts\python.exe -m companion --profile 'C:\path\to\profile' --db-dir "$env:LOCALAPPDATA\ThunderQuail\index"
```

Profile mode discovers the configured local MBOX stores and nested folders. Search covers message bodies already stored locally. Maildir stores and IMAP messages available only on the server are outside that coverage. The startup log and **Settings → Index coverage** report detected store and folder issues. A folder summary alone does not indicate a coverage problem. Folder labels use the mailbox names on disk.

Restart the companion to rediscover folders and refresh the index. Startup skips mailboxes whose modification time, size, and file identity match the last successful scan. It rescans changed files in binary read-only mode and reuses embeddings for unchanged chunk text. After a successful scan, chunks for removed mailboxes and messages are dropped from search. If a file changes during the scan, startup stops and preserves the last successful index. For manual indexing, use repeated `--mbox` arguments instead of `--profile` and pass the full list of files each time.

The console periodically reports scanned mailboxes, scan percentage by bytes, embeddings generated or reused, throughput, and an estimated time remaining. The estimate can move as mailbox contents vary. LanceDB finalization is shown separately, and **Index ready** means the update has been committed.

## Use the GPU through SSH for the first build

Keep the GPU host's embedding service on loopback and the SSH tunnel open on the Thunderbird host. Use `--gpu-url http://127.0.0.1:15100` when starting the companion and set `THUNDERQUAIL_GPU_TOKEN` to the GPU host's bearer token. Keep `THUNDERQUAIL_TOKEN` set separately for Thunderbird. You can add `--gpu-url` to `--check-embeddings` to verify the tunnel and compare CPU and GPU vectors using synthetic text before opening any mail.

GPU mode sends subject and chunk text through the SSH tunnel. The profile and LanceDB stay on the Thunderbird host. The companion takes a stable local copy of one mailbox at a time so Thunderbird can keep using the original after the copy. Leave enough disk space for the index, pending vectors, and the largest mailbox. The first pass represents each mailbox as of its copy time. A later refresh catches up with new mail.

The companion saves each completed embedding batch until the index is successfully committed. If the build stops, restart with the same database directory and embedding model. The companion rereads the mailboxes and reuses the saved vectors. Keep the index directory between retries. After the first build, omit `--gpu-url` to use the local CPU model for updates. Searches always embed queries locally.

The first startup with this release rebuilds any index made with the previous HTTP embedding backend. Changing the Hugging Face model or resolved model revision also rebuilds the index.

Use a dedicated database directory outside the Thunderbird profile. The database stores searchable text locally. Indexed excerpts can still go to a remote chat provider when you select **Search indexed mail**.

The server listens on `127.0.0.1:5000` by default. In a second PowerShell window, set `THUNDERQUAIL_TOKEN` to the same value used at startup, then run:

```powershell
Invoke-RestMethod 'http://127.0.0.1:5000/health'
Invoke-RestMethod 'http://127.0.0.1:5000/search' -Method Post `
  -Headers @{ Authorization = "Bearer $env:THUNDERQUAIL_TOKEN" } `
  -ContentType 'application/json' -Body (@{ query = 'project timeline'; top_k = 3 } | ConvertTo-Json)
```

Search returns a `results` array of ranked chunks with their text, subject, sender, recipients, date, Message-ID, mailbox path, chunk index, and cosine distance.

To use a specific scope from the API, fetch authenticated `GET /scopes` and pass the chosen `id` as the optional `scope` field in `POST /search`. The companion filters eligible email chunks before ranking them. An unknown scope returns an error.
