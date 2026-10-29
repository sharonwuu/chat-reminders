const $ = (id) => document.getElementById(id);
document.documentElement.lang = RTime.lang();
document.querySelectorAll("[data-i18n]").forEach((n) => { n.textContent = RTime.t(n.dataset.i18n); });
const send = (msg) =>
  chrome.runtime.sendMessage(msg).then((r) => {
    if (!r || !r.ok) throw new Error((r && r.error) || "no response");
    return r.data;
  });

async function render() {
  const items = (await send({ type: "list" })).filter((r) => !r.done).sort((x, y) => x.when - y.when);
  const ul = $("list");
  ul.replaceChildren();
  $("empty").style.display = items.length ? "none" : "block";
  const now = Date.now();
  const dueCount = items.filter((r) => r.when <= now).length;
  $("sub").textContent = !items.length ? "" : dueCount ? RTime.t("sub_due", { due: dueCount, total: items.length }) : RTime.t("sub_up", { n: items.length });
  for (const r of items) {
    const li = document.createElement("li");
    const t = document.createElement("div");
    t.className = "t";
    if (r.sender) {
      const f = document.createElement("div");
      f.className = "from";
      f.textContent = r.sender;
      t.append(f);
    }
    const b = document.createElement("b");
    b.textContent = r.text;
    b.title = r.text;
    const meta = document.createElement("div");
    meta.className = "meta";
    if (r.when <= now) {
      const due = document.createElement("span");
      due.className = "due";
      due.textContent = RTime.t("due");
      meta.append(due);
    }
    const when = document.createElement("span");
    when.textContent = RTime.formatDue(r.when, now);
    meta.append(when);
    t.append(b, meta);

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "check";
    check.title = RTime.t("mark_done");
    check.setAttribute("aria-label", RTime.t("mark_done"));
    check.addEventListener("click", async (e) => {
      e.stopPropagation();
      await send({ type: "complete", id: r.id });
      render();
    });

    const mk = (label, title, fn, cls) => {
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = label;
      x.title = title;
      x.setAttribute("aria-label", title);
      x.className = cls;
      x.addEventListener("click", async (e) => { e.stopPropagation(); await fn(); render(); });
      return x;
    };
    const del = mk("", RTime.t("del"), () => send({ type: "delete", id: r.id }), "del");
    del.appendChild(RTime.icon("close", 16));
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(mk(RTime.t("snooze_10"), RTime.t("snooze_10_title"), () => send({ type: "snooze", id: r.id, ms: 10 * 60e3 }), "snooze"), del);

    li.title = RTime.t("open_msg");
    li.addEventListener("click", () => send({ type: "open", id: r.id }));
    li.append(check, t, actions);
    ul.appendChild(li);
  }
}

chrome.storage.local.get("update").then(({ update }) => {
  if (!update || RTime.compareVersions(update.version, chrome.runtime.getManifest().version) <= 0) return;
  const a = $("update");
  a.textContent = RTime.t("banner", { version: update.version });
  a.hidden = false;
  a.addEventListener("click", (e) => { e.preventDefault(); send({ type: "openUpdate" }); });
});

$("emptyIcon").appendChild(RTime.icon("check", 40));

$("all").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("reminders.html") });
});

render();
