import { redactContent } from "./privacy.mjs";

function eventData(block) {
  return block.split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).replace(/^ /, ""))
    .join("\n");
}

export async function streamChat({ base_url, api_key, chat_model, indexer_token }, messages, signal, onText, { tools, onToolCall } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "text/event-stream" };
  if (api_key) {
    headers.Authorization = `Bearer ${api_key}`;
  }
  const secrets = [api_key, indexer_token];
  const outgoing = messages.map(message => ({
    ...message,
    content: redactContent(message.content, secrets),
    ...(message.tool_calls && { tool_calls: message.tool_calls.map(call => ({
      ...call, function: { ...call.function, arguments: redactContent(call.function.arguments, secrets) }
    })) })
  }));

  let response;
  try {
    response = await fetch(`${base_url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      credentials: "omit",
      redirect: "error",
      body: JSON.stringify({ model: chat_model, messages: outgoing, stream: true, tools }),
      signal
    });
  } catch {
    throw new Error("Could not reach the chat endpoint. Check the provider URL and connection.");
  }
  if (!response.ok) {
    const error = new Error(`The chat provider returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  if (!response.body || !response.headers.get("Content-Type")?.toLowerCase().includes("text/event-stream")) {
    throw new Error("The chat provider did not return an event stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let finished = false;

  function consume(block) {
    const data = eventData(block);
    if (data === "[DONE]") {
      return true;
    }
    if (!data) {
      return false;
    }
    const event = JSON.parse(data);
    if (event.error) {
      throw new Error("The chat provider reported a streaming error.");
    }
    const choice = event.choices?.[0];
    for (const delta of choice?.delta?.tool_calls ?? []) {
      onToolCall?.(delta);
    }
    const text = choice?.delta?.content;
    if (typeof text === "string") {
      answer += text;
      onText(answer);
    }
    finished ||= Boolean(choice?.finish_reason);
    return false;
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        if (consume(block)) {
          return answer;
        }
      }
      if (done) {
        if (consume(buffer) || finished) {
          return answer;
        }
        throw new Error("The chat stream ended before the reply completed.");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
