const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
const { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");

const MAIL_WINDOW = "chrome://messenger/content/messenger.xhtml";
const HTML = "http://www.w3.org/1999/xhtml";
const DEFAULT_SIZE = { width: 400, height: 610 };
const SIZE_PREFERENCE = "extensions.thunderquail.overlaySize";

function savedSize() {
  try {
    const { width, height } = JSON.parse(Services.prefs.getStringPref(SIZE_PREFERENCE, "null"));
    if (Number.isFinite(width) && width >= 280 && Number.isFinite(height) && height >= 300) {
      return { width, height };
    }
  } catch {
    // New or invalid preferences use the default panel size.
  }
  return { ...DEFAULT_SIZE };
}

this.quailOverlay = class extends ExtensionCommon.ExtensionAPI {
  onStartup() {
    this.windows = new Map();
    this.listener = `${this.extension.id}-overlay`;
    ExtensionSupport.registerWindowListener(this.listener, {
      chromeURLs: [MAIL_WINDOW],
      onLoadWindow: window => this.mount(window),
      onUnloadWindow: window => this.unmount(window)
    });
  }

  mount(window) {
    if (this.windows.has(window)) {
      return;
    }
    const extension = this.extension;
    const doc = window.document;
    const element = name => doc.createElementNS(HTML, name);
    const host = element("div");
    host.id = "thunderquail-overlay";
    host.style.cssText = "position:fixed;right:16px;bottom:30px;z-index:2147483647;color-scheme:light dark;";

    const launcher = element("button");
    launcher.setAttribute("aria-label", "Open ThunderQuail");
    launcher.title = "Open ThunderQuail";
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-controls", "thunderquail-panel");
    launcher.style.cssText = "appearance:none;box-sizing:border-box;display:grid;place-items:center;background:#155e63;color:white;border:1px solid #2c7a7b;border-radius:50%;width:46px;height:46px;min-width:0;min-height:0;padding:0;cursor:pointer;box-shadow:0 3px 14px #0003;";
    const icon = element("img");
    icon.src = extension.baseURI.resolve("overlay/quail.svg");
    icon.alt = "";
    icon.width = 28;
    icon.height = 28;
    launcher.append(icon);

    const panel = element("section");
    panel.id = "thunderquail-panel";
    panel.hidden = true;
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "ThunderQuail assistant");
    panel.style.cssText = "position:relative;box-sizing:border-box;background:Canvas;color:CanvasText;border:1px solid GrayText;border-radius:14px;overflow:hidden;box-shadow:0 6px 28px #0005;";

    const bar = element("header");
    bar.style.cssText = "position:relative;z-index:1;height:40px;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;padding:0 12px 0 23px;background:#155e63;color:white;font:600 14px system-ui;";
    const title = element("span");
    title.textContent = "ThunderQuail";
    const controls = element("div");
    controls.style.cssText = "display:flex;align-items:center;gap:1px;";
    const button = (glyph, label) => {
      const node = element("button");
      node.textContent = glyph;
      node.title = label;
      node.setAttribute("aria-label", label);
      node.style.cssText = "appearance:none;box-sizing:border-box;color:white;background:transparent;border:0;width:29px;height:29px;min-width:0;min-height:0;cursor:pointer;font:600 17px system-ui;padding:0;";
      return node;
    };
    const minimize = button("−", "Minimize ThunderQuail");
    const maximize = button("□", "Maximize ThunderQuail");
    const reset = button("↺", "Restore default size");
    controls.append(minimize, maximize, reset);
    bar.append(title, controls);
    const resize = element("div");
    resize.title = "Drag to resize";
    resize.style.cssText = "position:absolute;z-index:2;left:0;top:0;width:22px;height:32px;cursor:nwse-resize;touch-action:none;background:linear-gradient(135deg,transparent 20%,#fff9 21%,#fff9 29%,transparent 30%,transparent 43%,#fff9 44%,#fff9 52%,transparent 53%) 5px 6px / 13px 13px no-repeat;";
    panel.append(bar, resize);
    host.append(panel, launcher);
    doc.documentElement.append(host);

    let size = savedSize();
    let maximized = false;
    let frame;
    let drag;
    const applySize = () => {
      panel.style.width = maximized ? "calc(100vw - 32px)" : `min(${size.width}px, calc(100vw - 32px))`;
      panel.style.height = maximized ? "calc(100vh - 60px)" : `min(${size.height}px, calc(100vh - 80px))`;
      const title = maximized ? "Restore previous size" : "Maximize ThunderQuail";
      maximize.textContent = maximized ? "❐" : "□";
      maximize.title = title;
      maximize.setAttribute("aria-label", title);
      resize.hidden = maximized;
    };
    const saveSize = () => Services.prefs.setStringPref(SIZE_PREFERENCE, JSON.stringify(size));
    const finishDrag = () => {
      if (!drag) return;
      const { id, listeners } = drag;
      drag = undefined;
      listeners.abort();
      if (resize.hasPointerCapture(id)) resize.releasePointerCapture(id);
      if (frame) frame.style.pointerEvents = "";
      saveSize();
    };
    maximize.addEventListener("click", () => {
      finishDrag();
      maximized = !maximized;
      applySize();
    });
    reset.addEventListener("click", () => {
      finishDrag();
      maximized = false;
      size = { ...DEFAULT_SIZE };
      saveSize();
      applySize();
    });
    const moveDrag = event => {
      if (drag?.id !== event.pointerId) return;
      if (!(event.buttons & 1)) {
        finishDrag();
        return;
      }
      size = {
        width: Math.round(Math.max(280, Math.min(window.innerWidth - 32, drag.width + drag.x - event.clientX))),
        height: Math.round(Math.max(300, Math.min(window.innerHeight - 80, drag.height + drag.y - event.clientY)))
      };
      applySize();
    };
    resize.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      finishDrag();
      const { width, height } = panel.getBoundingClientRect();
      const listeners = new window.AbortController();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, width, height, listeners };
      const options = { capture: true, signal: listeners.signal };
      const end = event => {
        if (event.pointerId === drag?.id) finishDrag();
      };
      window.addEventListener("pointermove", moveDrag, options);
      window.addEventListener("pointerup", end, options);
      window.addEventListener("pointercancel", end, options);
      window.addEventListener("blur", finishDrag, { signal: listeners.signal });
      resize.addEventListener("lostpointercapture", end, options);
      // Keep the embedded remote browser from taking mouse input during a resize.
      if (frame) frame.style.pointerEvents = "none";
      resize.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    applySize();

    const setVisible = opening => {
      if (opening === !panel.hidden) return;
      finishDrag();
      launcher.setAttribute("aria-expanded", String(opening));
      panel.hidden = !opening;
      launcher.style.display = opening ? "none" : "grid";
      if (!opening) {
        launcher.focus();
        return;
      }
      if (!frame) {
        frame = doc.createXULElement("browser");
        frame.setAttribute("type", "content");
        frame.setAttribute("nodefaultsrc", "true");
        frame.setAttribute("disableglobalhistory", "true");
        frame.setAttribute("messagemanagergroup", "webext-browsers");
        frame.setAttribute("selectmenulist", "ContentSelectDropdown");
        frame.setAttribute("autocompletepopup", "PopupAutoComplete");
        frame.setAttribute("initialBrowsingContextGroupId", extension.policy.browsingContextGroupId);
        frame.setAttribute("webextension-view-type", "popup");
        if (extension.remote) {
          frame.setAttribute("remote", "true");
          frame.setAttribute("remoteType", extension.remoteType);
        }
        frame.style.cssText = "position:absolute;display:block;top:40px;left:0;width:100%;height:calc(100% - 40px);border:0;";
        panel.append(frame);
        ExtensionParent.apiManager.emit("extension-browser-inserted", frame);
        const windowId = extension.windowManager.getWrapper(window).id;
        const url = extension.baseURI.resolve(`chat.html?window=${windowId}`);
        frame.loadURI(Services.io.newURI(url), { triggeringPrincipal: extension.principal });
      }
      minimize.focus();
    };
    const toggle = () => setVisible(panel.hidden);
    launcher.addEventListener("click", toggle);
    minimize.addEventListener("click", toggle);
    host.addEventListener("keydown", event => {
      if (event.key === "Escape" && !panel.hidden) {
        toggle();
      }
    });
    this.windows.set(window, { host, toggle, setVisible, finishDrag });
  }

  unmount(window) {
    const overlay = this.windows.get(window);
    overlay?.finishDrag();
    overlay?.host.remove();
    this.windows.delete(window);
  }

  onShutdown(isAppShutdown) {
    if (!isAppShutdown && this.windows) {
      ExtensionSupport.unregisterWindowListener(this.listener);
      for (const window of this.windows.keys()) {
        this.unmount(window);
      }
      Services.obs.notifyObservers(null, "startupcache-invalidate");
    }
  }

  getAPI(context) {
    return {
      quailOverlay: {
        toggle: async (windowId, visible) => {
          const window = this.extension.windowManager.get(windowId, context).window;
          const overlay = this.windows?.get(window);
          if (typeof visible === "boolean") {
            overlay?.setVisible(visible);
          } else {
            overlay?.toggle();
          }
        }
      }
    };
  }
};
