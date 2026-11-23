document.querySelector("#open-settings").addEventListener("click", async () => {
  try {
    await browser.runtime.openOptionsPage();
    window.close();
  } catch {
    document.querySelector("#status").textContent = "Could not open settings.";
  }
});
document.querySelector("#open-chat").addEventListener("click", async () => {
  try {
    const [source] = await browser.tabs.query({ active: true, currentWindow: true });
    const url = new URL(browser.runtime.getURL("chat.html"));
    if (source?.id != null) {
      url.searchParams.set("source", source.id);
    }
    await browser.tabs.create({ url: url.href });
    window.close();
  } catch {
    document.querySelector("#status").textContent = "Could not open chat.";
  }
});

