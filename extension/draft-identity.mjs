export async function composeSenderName(tabId) {
  try {
    const { identityId } = await browser.compose.getComposeDetails(tabId);
    if (identityId) return (await browser.identities.get(identityId))?.name?.trim();
  } catch {
    // Drafting is still available when Thunderbird cannot resolve an identity.
  }
  return undefined;
}

function mailboxAddress(value) {
  return (value.match(/<([^<>]+)>\s*$/)?.[1] ?? value).trim().toLowerCase();
}

export async function mailAccountName(message) {
  const accountId = message.folder?.accountId;
  if (!accountId) return undefined;
  try {
    const { identities = [] } = await browser.accounts.get(accountId, false) ?? {};
    if (identities.length === 1) return identities[0].name?.trim();
    const addresses = new Set([message.author ?? "", ...(message.recipients ?? []),
      ...(message.ccList ?? []), ...(message.bccList ?? [])].map(mailboxAddress));
    const matches = identities.filter(identity => identity.email && addresses.has(mailboxAddress(identity.email)));
    if (matches.length === 1) return matches[0].name?.trim();
  } catch {
    // Leave the user's name unspecified if Thunderbird cannot resolve an identity.
  }
  return undefined;
}
