export async function composeSenderName(tabId) {
  try {
    const { identityId } = await browser.compose.getComposeDetails(tabId);
    if (identityId) return (await browser.identities.get(identityId))?.name?.trim();
  } catch {
    // Drafting is still available when Thunderbird cannot resolve an identity.
  }
  return undefined;
}

export async function replySenderName(message) {
  const accountId = message.folder?.accountId;
  if (!accountId) return undefined;
  try {
    const { identities = [] } = await browser.accounts.get(accountId, false) ?? {};
    if (identities.length === 1) return identities[0].name?.trim();
    const recipients = new Set([...(message.recipients ?? []), ...(message.ccList ?? [])]
      .map(value => (value.match(/<([^<>]+)>\s*$/)?.[1] ?? value).trim().toLowerCase()));
    const matches = identities.filter(identity => identity.email && recipients.has(identity.email.toLowerCase()));
    if (matches.length === 1) return matches[0].name?.trim();
  } catch {
    // Ask the model to leave out the sender name if the identity is ambiguous.
  }
  return undefined;
}
