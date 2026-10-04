"use strict";

const t = (key, ...subs) => browser.i18n.getMessage(key, subs);
const $ = (id) => document.getElementById(id);
const ask = (message) => browser.runtime.sendMessage(message).then(render);

// Ícones no traço da casa: grade de 24, linha de 2.3, pontas redondas.
const ICONS = {
  check: "M5 12.5 9.5 17 19 7.5",
  alert: "M12 4 21 20H3ZM12 10v4.5M12 17.5v.1",
  idle: "M6 12h12",
  pause: "M9 6v12M15 6v12",
  play: "M8 5.5v13l11-6.5Z",
};

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  for (const [key, value] of Object.entries({ fill: "none", stroke: "currentColor", "stroke-width": "2.3", "stroke-linecap": "round", "stroke-linejoin": "round" })) {
    path.setAttribute(key, value);
  }
  svg.append(path);
  return svg;
}

function status(el, kind, iconName, text) {
  el.className = `status ${kind}`;
  el.replaceChildren(icon(iconName), text);
}

function render(view) {
  status($("bridge"), view.online ? "good" : "crit", view.online ? "check" : "alert", t(view.online ? "bridgeOn" : "bridgeOff"));
  const sessions = view.sessions === 0 ? t("sessionsNone") : view.sessions === 1 ? t("sessionsOne") : t("sessionsMany", String(view.sessions));
  status($("sessions"), view.sessions ? "good" : "", view.sessions ? "check" : "idle", sessions);
  $("hint").hidden = view.online;
  $("hint").textContent = [t("bridgeHint"), view.hostError].filter(Boolean).join(" ");

  $("sticker").hidden = !view.paused;
  $("sticker").textContent = t("pausedSticker");

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
    release.className = "btn small";
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

  const pause = $("pause");
  pause.className = view.paused ? "btn ink" : "btn gold";
  pause.replaceChildren(icon(view.paused ? "play" : "pause"), t(view.paused ? "resume" : "pause"));
  pause.onclick = () => ask({ kfx: "popup:pause", paused: !view.paused });
  $("paused-note").hidden = !view.paused;
}

$("tabs-title").textContent = t("tabsTitle");
$("paused-note").textContent = t("pausedNote");
ask({ kfx: "popup:state" });
setInterval(() => ask({ kfx: "popup:state" }), 1500);
