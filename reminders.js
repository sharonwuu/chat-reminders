const send = (msg) =>
  chrome.runtime.sendMessage(msg).then((r) => {
    if (!r || !r.ok) throw new Error((r && r.error) || "no response");
    return r.data;
  });

document.documentElement.lang = RTime.lang();
document.querySelectorAll("[data-i18n]").forEach((n) => { n.textContent = RTime.t(n.dataset.i18n); });

const DAY = 24 * 3600e3;

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function sectionOf(r, now) {
  if (r.done) return "Completed";
  if (r.when <= now) return "Overdue";
  const today = startOfDay(now);
  if (r.when < today + DAY) return "Today";
  if (r.when < today + 2 * DAY) return "Tomorrow";
  return "Later";
}
const ORDER = ["Overdue", "Today", "Tomorrow", "Later", "Completed"];

let openMenu = null;
function closeMenu() {
  openMenu && openMenu.remove();
  openMenu = null;
}

function btn(label, cls, fn, title) {
  const b = document.createElement("button");
  b.type = "button";
  if (label instanceof Node) b.appendChild(label);
  else b.textContent = label;
  if (cls) b.className = cls;
  if (title) b.title = title;
  b.addEventListener("click", (e) => { e.stopPropagation(); fn(e); });
  return b;
}

async function snoozeMenu(r, li) {
  closeMenu();
  const presets = await RTime.loadPresets();
  const m = document.createElement("div");
  m.className = "menu";
  m.addEventListener("click", (e) => e.stopPropagation());
  const apply = (when) => { closeMenu(); send({ type: "snooze", id: r.id, when }); };
  presets.forEach((p) => m.appendChild(btn(p.label, "", () => apply(p.at(Date.now())))));
  m.appendChild(document.createElement("hr"));
  const picker = RTime.createPicker(Date.now() + 3600e3);
  m.appendChild(picker.el);
  m.appendChild(btn(RTime.t("set_custom"), "go primary", () => {
    const when = picker.get();
    if (Number.isFinite(when)) apply(when);
  }));
  li.appendChild(m);
  openMenu = m;
}

function row(r) {
  const li = document.createElement("li");
  if (r.done) li.className = "done";
  const t = document.createElement("div");
  t.className = "t";
  if (r.sender) {
    const f = document.createElement("div");
    f.className = "from";
    f.textContent = r.sender;
    t.appendChild(f);
  }
  const b = document.createElement("b");
  b.textContent = r.text;
  b.title = r.text;
  const s = document.createElement("span");
  s.textContent = r.done
    ? RTime.t("completed_at", { when: RTime.formatWhen(r.done) })
    : RTime.formatDue(r.when, Date.now()) + (r.source === "message" ? ` · ${RTime.t("from_message")}` : "");
  t.append(b, s);
  li.appendChild(t);
  li.title = RTime.t("open_msg");
  li.addEventListener("click", () => send({ type: "open", id: r.id }));

  const withIcon = (text, name) => {
    const s = document.createElement("span");
    s.className = "lbl";
    s.append(text, RTime.icon(name, 16));
    return s;
  };
  li.appendChild(btn(r.done ? RTime.t("reactivate") : withIcon(RTime.t("snooze"), "caret"), "", () => snoozeMenu(r, li)));
  if (!r.done) li.appendChild(btn(withIcon(RTime.t("mark_done"), "check"), "", () => send({ type: "complete", id: r.id })));
  li.appendChild(btn(RTime.icon("close", 16), "danger icon", () => send({ type: "delete", id: r.id }), RTime.t("del")));
  return li;
}

async function render() {
  closeMenu();
  const items = await send({ type: "list" });
  const now = Date.now();
  const groups = {};
  items.forEach((r) => (groups[sectionOf(r, now)] ||= []).push(r));
  groups.Completed?.sort((a, b) => b.done - a.done);

  const root = document.getElementById("sections");
  root.replaceChildren();
  document.getElementById("empty").style.display = items.length ? "none" : "block";
  for (const name of ORDER) {
    if (!groups[name]) continue;
    const h = document.createElement("h2");
    h.textContent = `${RTime.t("sec_" + name.toLowerCase())} (${groups[name].length})`;
    if (name === "Overdue") h.className = "overdue";
    const ul = document.createElement("ul");
    groups[name].forEach((r) => ul.appendChild(row(r)));
    root.append(h, ul);
  }
}

chrome.storage.onChanged.addListener((_c, area) => area === "local" && render());
document.addEventListener("click", closeMenu);
setInterval(render, 60e3); // refresh sections as time passes
render();
