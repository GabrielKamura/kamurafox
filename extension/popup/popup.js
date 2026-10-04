"use strict";

const t = (key, ...subs) => browser.i18n.getMessage(key, subs);
const $ = (id) => document.getElementById(id);
const ask = (message) => browser.runtime.sendMessage(message).then(render);

function render(view) {
  $("bridge").textContent = t(view.online ? "bridgeOn" : "bridgeOff");
  $("bridge").dataset.state = view.online ? "on" : "off";
  $("sessions").textContent = view.sessions === 0 ? t("sessionsNone") : view.sessions === 1 ? t("sessionsOne") : t("sessionsMany", String(view.sessions));
  $("sessions").dataset.state = view.sessions ? "on" : "idle";
  $("hint").hidden = view.online;
  $("hint").textContent = [t("bridgeHint"), view.hostError].filter(Boolean).join(" · ");

  const list = $("tabs");
  list.textContent = "";
  for (const tab of view.tabs) {
    const item = document.createElement("li");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = tab.title;
    title.title = tab.url;
    item.append(title);
    if (tab.adopted) {
      const own = document.createElement("span");
      own.className = "own";
      own.textContent = t("adopted");
      item.append(own);
    }
    const release = document.createElement("button");
    release.type = "button";
    release.textContent = t("release");
    release.addEventListener("click", () => ask({ kfx: "popup:release", tabId: tab.id }));
    item.append(release);
    list.append(item);
  }
  if (!view.tabs.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = t("tabsNone");
    list.append(empty);
  }

  document.body.classList.toggle("paused", view.paused);
  $("pause").textContent = t(view.paused ? "resume" : "pause");
  $("pause").onclick = () => ask({ kfx: "popup:pause", paused: !view.paused });
  $("paused-note").hidden = !view.paused;
}

$("tabs-title").textContent = t("tabsTitle");
$("paused-note").textContent = t("pausedNote");
ask({ kfx: "popup:state" });
setInterval(() => ask({ kfx: "popup:state" }), 1500);
