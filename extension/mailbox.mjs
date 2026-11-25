const definitions = {
  create_folder: ["Create a folder under an explicitly requested parent.", ["parent", "name"]],
  rename_folder: ["Rename the specified folder.", ["folder", "name"]],
  move_folder: ["Move the specified folder under an explicitly requested parent.", ["folder", "parent"]],
  move_selected_messages: ["Move all selected messages to an explicitly requested destination. Never use for removal or Junk.", ["folder"]],
  move_selected_to_junk: ["For email removal or spam requests, move all selected messages to their own accounts' configured Junk folders.", []]
};

export function mailboxTools(junkOnly) {
  return Object.entries(definitions)
    .filter(([name]) => !junkOnly || name === "move_selected_to_junk")
    .map(([name, [description, keys]]) => ({
      type: "function",
      function: {
        name,
        description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(keys.map(key => [key, { type: "string" }])),
          required: keys,
          additionalProperties: false
        }
      }
    }));
}

export function isRemovalRequest(question) {
  return /\b(?:delet\w*|remov\w*|discard\w*|eras\w*|purge\w*|trash|spam|j[ua]nk|get rid of|throw away)\b/i.test(question);
}

export function collectToolDelta(calls, delta) {
  if (delta.index !== 0 || (delta.type && delta.type !== "function")) {
    throw new Error("The chat provider requested more than one tool or an unsupported tool type.");
  }
  const call = calls[0] ??= { name: "", arguments: "" };
  if (delta.id) call.id = delta.id;
  call.name += delta.function?.name ?? "";
  call.arguments += delta.function?.arguments ?? "";
}

async function selectedMessages(tabId) {
  if (tabId === null) {
    return [];
  }
  const tab = await browser.tabs.get(tabId);
  if (!["mail", "messageDisplay"].includes(tab.type)) {
    return [];
  }
  const list = tab.type === "mail" ? await browser.mailTabs.getSelectedMessages(tabId)
    : await browser.messageDisplay.getDisplayedMessages(tabId);
  if (list.id) {
    throw new Error("Select fewer messages and try again.");
  }
  return list.messages ?? list;
}

export async function getMailboxContext(tabId) {
  const [accounts, folders, selected] = await Promise.all([
    browser.accounts.list(false), browser.folders.query({}), selectedMessages(tabId)
  ]);
  const names = new Map(accounts.map(account => [account.id, account.name]));
  const byId = new Map([...folders, ...accounts.map(account => account.rootFolder)]
    .filter(folder => folder?.accountId && !folder.isVirtual)
    .map(folder => [folder.id, folder]));
  const trash = [...byId.values()].filter(folder => folder.specialUse?.includes("trash"));
  const available = [...byId.values()].filter(folder => !trash.some(parent =>
    parent.accountId === folder.accountId && (folder.path === parent.path || folder.path.startsWith(parent.path + "/"))));
  const byRef = new Map(available.map((folder, index) => [`F${index + 1}`, folder]));
  const describe = folder => `${names.get(folder.accountId) ?? folder.accountId} ${folder.path}`;
  const data = {
    folders: [...byRef].map(([ref, folder]) => ({ ref, location: describe(folder), specialUse: folder.specialUse })),
    selected: selected.map(message => ({ subject: message.subject, folder: message.folder && describe(message.folder) }))
  };
  return { byRef, selected, describe, data };
}

function getArguments(call, junkOnly) {
  if (!Object.hasOwn(definitions, call.name) || (junkOnly && call.name !== "move_selected_to_junk")) {
    throw new Error("That mailbox action is unavailable for this request.");
  }
  const args = JSON.parse(call.arguments);
  const keys = definitions[call.name][1];
  if (!args || Array.isArray(args) || typeof args !== "object" ||
      Object.keys(args).length !== keys.length || keys.some(key => typeof args[key] !== "string" || !args[key].trim())) {
    throw new Error("The model returned invalid mailbox action arguments.");
  }
  return args;
}

function resolveFolder(context, ref) {
  const folder = context.byRef.get(ref);
  if (!folder) {
    throw new Error("The model did not identify a folder from the mailbox list.");
  }
  return folder;
}

async function messageGroups(context, destination) {
  if (!context.selected.length) {
    throw new Error("Select or open the messages you want to move in the source tab.");
  }
  const groups = new Map();
  const sources = new Map();
  for (const message of context.selected) {
    const source = message.folder;
    if (!source?.accountId || message.external) {
      throw new Error("Each selected message must belong to a mail account.");
    }
    const candidates = destination ? [destination] : [...context.byRef.values()].filter(folder =>
      folder.accountId === source.accountId && folder.specialUse?.includes("junk"));
    if (candidates.length !== 1) {
      throw new Error(`Could not identify a single configured Junk folder for ${context.describe(source)}.`);
    }
    const target = candidates[0];
    if (source.id === target.id) {
      continue;
    }
    if (!groups.has(target.id)) {
      groups.set(target.id, { target, messages: [] });
    }
    groups.get(target.id).messages.push(message);
    sources.set(source.id, source);
  }
  if (!groups.size) {
    throw new Error("The selected messages are already in the destination.");
  }
  const capabilities = await Promise.all([...sources.keys()].map(id => browser.folders.getFolderCapabilities(id)));
  if (capabilities.some(value => !value.canDeleteMessages)) {
    throw new Error("A source folder only supports copying these messages. Choose messages that can be moved.");
  }
  return [...groups.values()];
}

export async function planMailboxAction(call, context, junkOnly) {
  const args = getArguments(call, junkOnly);
  const name = args.name?.trim();
  if (name && /[/\\\x00-\x1f]/.test(name)) {
    throw new Error("Enter a folder name without slashes or control characters.");
  }
  const folder = args.folder && resolveFolder(context, args.folder);
  const parent = args.parent && resolveFolder(context, args.parent);
  const describe = context.describe;
  if (call.name === "create_folder") {
    return {
      description: `Create “${name}” under ${describe(parent)}.`,
      identity: parent.id,
      execute: () => browser.folders.create(parent.id, name)
    };
  }
  if (call.name === "rename_folder") {
    return {
      description: `Rename ${describe(folder)} to “${name}”.`,
      identity: folder.id,
      execute: () => browser.folders.rename(folder.id, name)
    };
  }
  if (call.name === "move_folder") {
    return {
      description: `Move folder ${describe(folder)} into ${describe(parent)}.`,
      identity: JSON.stringify([folder.id, parent.id]),
      execute: () => browser.folders.move(folder.id, parent.id)
    };
  }
  if (folder?.isRoot || folder?.specialUse?.includes("junk")) {
    throw new Error("Choose a mail folder. For Junk, request Move to Junk.");
  }
  const groups = await messageGroups(context, folder);
  const description = groups.map(({ target, messages }) =>
    `Move ${messages.length} message(s) to ${describe(target)}:\n` + messages.map(message =>
      `• ${message.subject || "(no subject)"} [${describe(message.folder)}]`).join("\n")).join("\n\n");
  return {
    description,
    identity: JSON.stringify(groups.map(({ target, messages }) => [target.id, messages.map(message => message.id)])),
    execute: async () => {
      let completed = 0;
      for (const { target, messages } of groups) {
        try {
          await browser.messages.move(messages.map(message => message.id), target.id);
          const remaining = await Promise.all(messages.map(async message => {
            try {
              return (await browser.messages.get(message.id)).folder?.id === message.folder.id;
            } catch (error) {
              if (/^Message not found:/.test(error.message)) {
                return false;
              }
              throw error;
            }
          }));
          if (remaining.some(Boolean)) {
            throw new Error("At least one message is still in its source folder.");
          }
          completed += messages.length;
        } catch (error) {
          throw new Error(`Confirmed moved before the error: ${completed}. Check the source and destination folders. ${error.message}`);
        }
      }
    }
  };
}

export async function refreshMailboxContext(context, call) {
  const fresh = await getMailboxContext(null);
  const currentFolders = new Map([...fresh.byRef.values()].map(folder => [folder.id, folder]));
  const originalIds = new Set([...context.byRef.values()].map(folder => folder.id));
  const byRef = new Map([...context.byRef].flatMap(([ref, folder]) => {
    const current = currentFolders.get(folder.id);
    return current ? [[ref, current]] : [];
  }));
  const originals = call.name.startsWith("move_selected_") ? context.selected : [];
  const selected = await Promise.all(originals.map(async original => {
    const message = await browser.messages.get(original.id);
    if (message.folder?.id !== original.folder?.id || message.subject !== original.subject ||
        message.headerMessageId !== original.headerMessageId) {
      throw new Error("A selected message changed after the proposal. Ask again.");
    }
    return message;
  }));
  // Keep alias resolution stable while allowing newly configured Junk folders to be detected.
  for (const [ref, folder] of fresh.byRef) {
    if (!originalIds.has(folder.id)) {
      byRef.set(`new-${ref}`, folder);
    }
  }
  return { ...fresh, byRef, selected };
}
