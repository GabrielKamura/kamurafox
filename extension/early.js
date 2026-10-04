// Records the console from the very start of a page; anything injected later
// would miss the page's first scripts. Registered for web pages only while
// Claude controls at least one tab. It asks the background whether this tab is
// one of them, and if not it undoes itself and throws the recording away.
(() => {
  "use strict";
  if (globalThis.__kamurafoxEarly) return;

  const page = window.wrappedJSObject;
  const backlog = [];
  const originals = {};
  let state = "asking"; // asking | on | off
  let timer = null;

  function show(value) {
    try {
      if (typeof value === "string") return value;
      if (value === null || (typeof value !== "object" && typeof value !== "function")) return String(value);
      if (typeof value.message === "string" && typeof value.name === "string") return `${value.name}: ${value.message}`;
      const json = page.JSON.stringify(value.wrappedJSObject || value);
      return typeof json === "string" ? json : String(value);
    } catch {
      try {
        return String(value);
      } catch {
        return "[object]";
      }
    }
  }

  function flush() {
    timer = null;
    if (backlog.length) browser.runtime.sendMessage({ kfx: "console", entries: backlog.splice(0) }).catch(() => {});
  }

  function record(level, text) {
    if (state === "off") return;
    backlog.push({ level, text: String(text).slice(0, 2000) });
    if (backlog.length > 500) backlog.shift();
    if (state === "on" && !timer) timer = setTimeout(flush, 100);
  }

  function drain() {
    clearTimeout(timer);
    timer = null;
    return backlog.splice(0);
  }

  function onError(event) {
    if (event.message) record("error", `Uncaught ${event.message} (${event.filename}:${event.lineno})`);
    else if (event.target && event.target !== window && event.target.localName) {
      record("error", `Failed to load <${event.target.localName}> ${event.target.src || event.target.href || ""}`);
    }
  }

  function onRejection(event) {
    record("error", `Unhandled promise rejection: ${show(event.reason)}`);
  }

  // Whatever is still unsent goes out when the page is leaving.
  function onLeave() {
    if (state === "on") flush();
  }

  function stop() {
    state = "off";
    drain();
    window.removeEventListener("pagehide", onLeave);
    for (const level of Object.keys(originals)) page.console[level] = originals[level];
    window.removeEventListener("error", onError, true);
    window.removeEventListener("unhandledrejection", onRejection);
    delete globalThis.__kamurafoxEarly;
  }

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = page.console[level];
    if (typeof original !== "function") continue;
    originals[level] = original;
    page.console[level] = exportFunction(function (...args) {
      try {
        record(level, args.map(show).join(" "));
      } catch {}
      return Reflect.apply(original, page.console, args);
    }, window);
  }
  window.addEventListener("error", onError, true);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("pagehide", onLeave);

  globalThis.__kamurafoxEarly = { record, drain, stop, show };

  browser.runtime.sendMessage({ kfx: "hello" }).then((answer) => {
    if (!answer || !answer.controlled) return stop();
    state = "on";
    if (backlog.length) flush();
    return undefined;
  }, stop);
})();
