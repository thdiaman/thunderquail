// Optional: asks the local companion to check for new mail about a minute after mail arrives.
// The companion also checks every few minutes on its own, so this only makes the index catch up sooner.
// The listener is always registered, because event pages must register listeners synchronously,
// but it does nothing while the setting "Update the index when new mail arrives" is off.
import { companionSearchUrl, isCompanionToken } from "./companion-search.mjs";
import { requestRescan } from "./index-status.mjs";

const ALARM = "thunderquail-rescan";
const QUIET_MINUTES = 1;

browser.messages.onNewMailReceived.addListener(async () => {
  try {
    const { index_on_new_mail } = await browser.storage.local.get({ index_on_new_mail: false });
    // Creating the alarm again moves it back, so a burst of mail causes one rescan after it ends.
    if (index_on_new_mail === true) await browser.alarms.create(ALARM, { delayInMinutes: QUIET_MINUTES });
  } catch {
    // The next message tries again.
  }
});

browser.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM) return;
  try {
    const { index_on_new_mail, indexer_url, indexer_token } = await browser.storage.local.get({
      index_on_new_mail: false, indexer_url: "", indexer_token: ""
    });
    if (index_on_new_mail !== true || !indexer_url || !isCompanionToken(indexer_token)) return;
    await requestRescan({ url: companionSearchUrl(indexer_url), token: indexer_token });
  } catch {
    // The companion may be stopped. It still checks for new mail by itself when it runs.
  }
});
