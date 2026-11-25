(() => {
  if (globalThis.thunderQuailComposeLoaded) {
    return;
  }
  globalThis.thunderQuailComposeLoaded = true;
  let snapshot;

  function capture() {
    const body = document.body;
    const selection = document.getSelection();
    const range = selection?.rangeCount === 1 && !selection.isCollapsed
      ? selection.getRangeAt(0) : null;
    const withinBody = range && body.contains(range.commonAncestorContainer);
    const selected = withinBody ? selection.toString() : "";
    snapshot = {
      id: Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-"),
      body,
      html: body.innerHTML,
      // Save the original positions. A live Range can move as the draft changes.
      boundaries: withinBody ? {
        start: range.startContainer,
        startOffset: range.startOffset,
        end: range.endContainer,
        endOffset: range.endOffset
      } : null
    };
    return { id: snapshot.id, selected, text: body.innerText };
  }

  function apply({ id, mode, text }) {
    const body = document.body;
    if (!snapshot || id !== snapshot.id || body !== snapshot.body || body.innerHTML !== snapshot.html) {
      return { error: "The draft changed. Reopen ThunderQuail to capture it again." };
    }
    const range = document.createRange();
    if (mode === "selection") {
      const boundaries = snapshot.boundaries;
      if (!boundaries || !body.contains(boundaries.start) || !body.contains(boundaries.end)) {
        return { error: "The original selection is unavailable. Select the text again." };
      }
      range.setStart(boundaries.start, boundaries.startOffset);
      range.setEnd(boundaries.end, boundaries.endOffset);
    } else {
      range.selectNodeContents(body);
      if (mode === "draft") {
        range.collapse(false);
        if (body.innerText.trim()) {
          text = "\n\n" + text;
        }
      } else if (mode === "reply") {
        range.collapse(true);
        if (body.innerText.trim()) {
          text += "\n\n";
        }
      } else if (mode !== "body") {
        return { error: "Unknown compose action." };
      }
    }

    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    // Use the native editor so the change participates in Thunderbird's Undo.
    if (!document.execCommand("insertText", false, text)) {
      return { error: "Thunderbird could not apply the preview to this editor." };
    }
    snapshot = undefined;
    return { applied: true };
  }

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "thunderquail-compose-capture") {
      sendResponse(capture());
    } else if (message.type === "thunderquail-compose-apply") {
      sendResponse(apply(message));
    }
  });
})();
