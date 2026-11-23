# ThunderQuail

A local-first AI assistant for Thunderbird. The extension provides streaming chat, optional email context, compose tools, and confirmed mailbox actions. The companion adds semantic search over incrementally indexed MBOX files.

## Install the XPI

In Thunderbird 128 or later, open **Add-ons and Themes → Extensions → gear icon → Install Add-on From File…** and choose [dist/thunderquail-0.9.0.xpi](dist/thunderquail-0.9.0.xpi). Build or refresh the package from the project root with `python package_extension.py`. It contains the extension files. Run the companion separately if you want indexed search. [Thunderbird's packaging guide](https://developer.thunderbird.net/add-ons/hello-world-add-on)

## Try the development build

1. In Thunderbird 128 or later, open **Add-ons and Themes → Extensions → gear icon → Debug Add-ons**.
2. Click **Load Temporary Add-on…** and select [extension/manifest.json](extension/manifest.json).
3. In the Mail space, click **ThunderQuail → Open settings**.
4. Enter the chat provider's API root, API key if required, and model name. Click **Test chat connection** to send a synthetic prompt. Click **Save settings** to make the configuration available to chat and compose.

Use **Reload** on the Debug Add-ons page after editing the extension. Load the manifest again after restarting Thunderbird. The API key is stored locally in your Thunderbird profile.

## Try standalone chat

1. Save a chat model and the API base URL for a running OpenAI-compatible provider. For example, a base URL of `http://127.0.0.1:11434/v1` sends chat requests to `http://127.0.0.1:11434/v1/chat/completions`.
2. Select one email in the Mail space or open it in a message tab, then click **ThunderQuail → Open chat**. Enter a prompt and click **Send**. Grant access to the provider host when prompted.
3. To summarize the email, click **Include email**, verify the subject shown, and send a prompt such as “Summarize this email in three bullets.”

The companion is optional for these steps. The chat provider receives your prompts, the email context you include, and earlier turns from the same chat. **Clear chat** removes that conversation from the tab so earlier turns are excluded from future requests. Email context contains the subject, sender, and up to 12,000 characters of readable body text.

## Search indexed mail from chat

1. Start the companion using the instructions below. In ThunderQuail settings, set **Local indexer URL** to `http://127.0.0.1:5000` (or your configured port) and **Companion token** to the same value as `THUNDERQUAIL_TOKEN`.
2. Open a new ThunderQuail chat tab and check **Search indexed mail**. Use **All indexed mail**, or choose an account, a folder, or a folder and its subfolders under **Search scope**. Then ask your question. You can also explicitly add the open or selected email with **Include email**, even if it is outside the indexed search scope.
3. Expand **Indexed mail used** under the answer to match the model's references to the retrieved excerpts. ThunderQuail sends up to four matching excerpts to your chat provider for that turn. The raw excerpts are excluded from later requests, though earlier answers may refer to or quote them.

If search exceeds the configured timeout, the token is rejected, or the companion is unavailable, chat continues with the prompt and any email you explicitly included. The timeout defaults to two seconds and can be increased in Settings for larger indexes. Compose tools and mailbox actions work independently of the companion.

## Configure chat and local embeddings

Chat and compose use the provider set in the extension. Choose local Ollama at `http://127.0.0.1:11434/v1` or Ollama Cloud at `https://ollama.com/v1`. For direct cloud access use an Ollama API key and a cloud chat model. Mailbox proposals also require the chat model to support streaming tool calls. [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)

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
2. Check **Propose a mailbox action**, then ask for one change. For example, ask “Create a folder named ThunderQuail Test under Local Folders” or “Move the selected messages to ThunderQuail Test.” Use account names and full folder paths when names overlap.
3. Review the exact folders and messages in the confirmation dialog. Click **Apply action** to proceed or **Cancel** to leave the mailbox untouched.

For a Junk test, select a disposable message and ask “Move the selected message to Junk.” Requests to delete or remove mail are routed to Move to Junk. Each selected message uses its source account's configured Junk folder. If the destination is unavailable or ambiguous, the action stops. The companion can be stopped for all these tests.

Mailbox mode sends account and folder names and selected message subjects to the configured provider. It sends no email bodies, and the mailbox mode checkbox resets after each request.

## Run the local companion

In Thunderbird, open **Help → Troubleshooting Information → Profile Folder → Open Folder**. Copy the path to the folder containing `prefs.js`. Run these commands from the project root in PowerShell with Python 3.10 or later.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r companion/requirements.txt
$env:THUNDERQUAIL_TOKEN = [guid]::NewGuid().ToString('N')
.\.venv\Scripts\python.exe -m companion --profile 'C:\path\to\profile' --db-dir "$env:LOCALAPPDATA\ThunderQuail\index"
```

Profile mode discovers the configured local MBOX stores and nested folders. Search covers message bodies already stored locally. Maildir stores and IMAP messages available only on the server are outside that coverage. The startup log and the chat scope picker's **Index coverage** section report skipped stores or folders where detectable. Folder labels use the mailbox names on disk.

Restart the companion to rediscover folders and refresh the index. Startup skips mailboxes whose modification time, size, and file identity match the last successful scan. It rescans changed files in binary read-only mode and reuses embeddings for unchanged chunk text. After a successful scan, chunks for removed mailboxes and messages are dropped from search. If a file changes during the scan, startup stops and preserves the last successful index. For manual indexing, use repeated `--mbox` arguments instead of `--profile` and pass the full list of files each time.

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
