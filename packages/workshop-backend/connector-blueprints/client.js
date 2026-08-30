// Shared UI for CinaSeek's official connector templates. The specialized server returns the
// connector-specific title, action schema, and normalized resource rows.

const zh = (navigator.language || "").toLowerCase().startsWith("zh");
const copy = zh ? {
  workspace: "连接器工作台", search: "搜索资源", overview: "概览", resources: "资源",
  activity: "活动", refresh: "刷新", run: "执行操作", connected: "已连接", connecting: "连接中",
  error: "连接错误", empty: "没有找到资源", emptyHint: "请调整搜索条件或刷新连接。",
  loading: "正在加载连接资源…", open: "打开", details: "详细信息", recent: "最近活动",
  noActivity: "尚无本地活动记录。", back: "返回", cancel: "取消", submit: "提交审批",
  actionTitle: "执行连接器操作", actionHelp: "写操作会进入 CinaSeek 审批流程，批准前不会生效。",
  selectAction: "选择操作", required: "此字段为必填项。", failed: "无法完成请求。",
  records: "条记录", readOnly: "此模板当前仅提供只读操作。", exported: "导出快照",
} : {
  workspace: "Connector Workspace", search: "Search resources", overview: "Overview",
  resources: "Resources", activity: "Activity", refresh: "Refresh", run: "Run action",
  connected: "Connected", connecting: "Connecting", error: "Connection error",
  empty: "No resources found", emptyHint: "Try adjusting your search or refreshing the connection.",
  loading: "Loading connected resources…", open: "Open", details: "Details",
  recent: "Recent activity", noActivity: "No local activity has been recorded yet.", back: "Back",
  cancel: "Cancel", submit: "Submit for approval", actionTitle: "Run connector action",
  actionHelp: "Write operations enter CinaSeek's approval flow and do not apply before approval.",
  selectAction: "Select an action", required: "This field is required.", failed: "The request failed.",
  records: "records", readOnly: "This template currently exposes read-only operations.",
  exported: "Export snapshot",
};

const icons = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  overview: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  resources: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  activity: '<path d="M3 12h4l2.5-7 5 14 2.5-7h4"/>',
  refresh: '<path d="M20 6v5h-5M4 18v-5h5"/><path d="M18.5 9a7 7 0 0 0-12-2L4 11m16 2-2.5 4a7 7 0 0 1-12-2"/>',
  play: '<path d="m9 6 9 6-9 6z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  status: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
};

function icon(name, className = "") {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.file}</svg>`;
}

const style = document.createElement("style");
style.textContent = `
:root{color-scheme:light;--accent:#1473e6;--bg:#fff;--soft:#f7f9fc;--soft-2:#eef3f8;--line:#dce3eb;--line-strong:#c7d0db;--text:#182230;--muted:#667085;--faint:#98a2b3;--good:#179c6b;--bad:#d92d20;--warn:#c47b0a;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--text)}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}.icon{width:20px;height:20px;display:block}.app{height:100vh;display:grid;grid-template-rows:72px 76px minmax(0,1fr);overflow:hidden}
.global{display:grid;grid-template-columns:112px 280px minmax(280px,600px) 1fr;align-items:center;border-bottom:1px solid var(--line);padding:0 24px;gap:18px}.menu{border:0;background:transparent;width:40px;height:40px;display:grid;place-items:center;border-radius:8px}.menu:hover{background:var(--soft-2)}.brand{font-size:18px;font-weight:680;letter-spacing:-.025em}.global-search{height:46px;border:1px solid var(--line-strong);border-radius:8px;display:flex;align-items:center;gap:10px;padding:0 14px;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.03)}.global-search:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 14%,transparent)}.global-search input{border:0;outline:0;width:100%;background:transparent}.shortcut{font-size:12px;color:var(--muted);border:1px solid var(--line);padding:2px 7px;border-radius:5px;white-space:nowrap}
.connector-head{grid-column:1/-1;display:flex;align-items:center;gap:14px;padding:0 28px 0 152px;border-bottom:1px solid var(--line)}.mark{width:38px;height:38px;border-radius:8px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:750;font-size:16px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.28)}.connector-title{font-size:18px;font-weight:700;letter-spacing:-.02em}.connection{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:13px}.dot{width:8px;height:8px;border-radius:50%;background:var(--good)}.dot.loading{background:var(--warn);animation:pulse 1s infinite}.dot.error{background:var(--bad)}@keyframes pulse{50%{opacity:.35}}.head-actions{margin-left:auto;display:flex;gap:10px}.btn{height:40px;border-radius:7px;border:1px solid var(--line-strong);padding:0 16px;background:#fff;display:inline-flex;align-items:center;justify-content:center;gap:8px;font-weight:620}.btn:hover{background:var(--soft)}.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn.primary:hover{filter:brightness(.96)}.btn:disabled{opacity:.5;cursor:not-allowed}
.shell{min-height:0;display:grid;grid-template-columns:128px minmax(430px,1fr) 390px}.rail{border-right:1px solid var(--line);padding:22px 12px;display:flex;flex-direction:column;gap:8px}.nav{border:0;background:transparent;border-radius:7px;min-height:72px;padding:10px 5px;color:#475467;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;font-size:12px}.nav:hover{background:var(--soft)}.nav.active{color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,white);box-shadow:inset 3px 0 var(--accent)}.nav .icon{width:22px;height:22px}.main{min-width:0;min-height:0;padding:22px;overflow:auto}.toolbar{display:flex;align-items:center;gap:10px;margin-bottom:16px}.select{height:38px;padding:0 34px 0 12px;border:1px solid var(--line-strong);border-radius:7px;background:#fff}.count{margin-left:auto;color:var(--muted);font-size:13px}.table{border:1px solid var(--line);border-radius:9px;overflow:hidden;background:#fff}.row{display:grid;grid-template-columns:minmax(220px,1.5fr) minmax(110px,.65fr) minmax(120px,.75fr) 82px;min-height:65px;align-items:center;padding:0 14px;border-bottom:1px solid var(--line);gap:12px}.row:last-child{border-bottom:0}.row.header{min-height:44px;background:var(--soft);font-size:12px;font-weight:650;color:#475467}.row.item{cursor:pointer}.row.item:hover,.row.item.selected{background:color-mix(in srgb,var(--accent) 5%,white)}.row.item.selected{box-shadow:inset 3px 0 var(--accent)}.name{display:flex;gap:11px;align-items:center;min-width:0}.resource-icon{color:var(--accent);flex:0 0 auto}.name-copy{min-width:0}.name-title{font-weight:640;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.name-sub{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}.cell{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#475467;font-size:13px}.open-btn{height:33px;padding:0 11px;border-radius:6px;border:1px solid var(--line-strong);background:#fff;font-size:13px}.state{display:inline-flex;align-items:center;gap:6px}.state::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--good)}
.empty,.loading-view{min-height:360px;display:grid;place-items:center;text-align:center;color:var(--muted)}.empty-inner{max-width:340px}.empty-symbol{width:54px;height:54px;margin:0 auto 14px;border:1px solid var(--line);border-radius:14px;display:grid;place-items:center;color:var(--faint)}.empty h2{font-size:16px;color:var(--text);margin:0 0 7px}.empty p{margin:0;line-height:1.5}.spinner{width:28px;height:28px;border:3px solid var(--soft-2);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 12px}@keyframes spin{to{transform:rotate(360deg)}}
.inspector{border-left:1px solid var(--line);min-height:0;overflow:auto;padding:24px}.inspect-empty{height:100%;display:grid;place-items:center;text-align:center;color:var(--muted)}.inspect-head{display:flex;gap:12px;align-items:flex-start;padding-bottom:20px;border-bottom:1px solid var(--line)}.inspect-head .resource-icon{margin-top:2px}.inspect-title{font-size:16px;font-weight:700;line-height:1.35}.inspect-type{font-size:12px;color:var(--muted);margin-top:4px}.inspect-close{margin-left:auto;border:0;background:transparent;padding:5px;border-radius:6px}.inspect-close:hover{background:var(--soft-2)}.section-title{font-size:13px;font-weight:700;margin:20px 0 12px}.detail-list{display:grid;gap:12px}.detail{display:grid;grid-template-columns:112px 1fr;gap:14px;font-size:13px}.detail dt{color:var(--muted)}.detail dd{margin:0;word-break:break-word}.detail a{color:var(--accent);text-decoration:none}.detail a:hover{text-decoration:underline}.activity-list{display:grid;gap:0}.event{position:relative;padding:0 0 18px 23px}.event::before{content:"";position:absolute;left:5px;top:15px;bottom:0;width:1px;background:var(--line)}.event:last-child::before{display:none}.event-dot{position:absolute;left:0;top:4px;width:11px;height:11px;border-radius:50%;background:var(--good);box-shadow:0 0 0 3px #fff}.event-title{font-weight:620;font-size:13px}.event-meta{font-size:12px;color:var(--muted);margin-top:3px}.overview{display:grid;gap:22px}.overview-copy{max-width:760px}.overview h1{font-size:28px;letter-spacing:-.035em;margin:0 0 10px}.overview p{font-size:15px;line-height:1.65;color:var(--muted);margin:0}.overview-rule{height:1px;background:var(--line)}.overview-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;border:1px solid var(--line);border-radius:9px;overflow:hidden}.overview-item{padding:22px;border-right:1px solid var(--line)}.overview-item:last-child{border-right:0}.overview-number{font-size:28px;font-weight:720;letter-spacing:-.04em}.overview-label{color:var(--muted);font-size:12px;margin-top:5px}
.modal-backdrop{position:fixed;inset:0;background:rgba(10,20,35,.42);display:grid;place-items:center;padding:20px;z-index:20}.modal{width:min(560px,100%);max-height:min(760px,90vh);overflow:auto;background:#fff;border-radius:12px;border:1px solid var(--line);box-shadow:0 24px 70px rgba(16,24,40,.24)}.modal-head{padding:22px 24px 17px;border-bottom:1px solid var(--line);display:flex;align-items:flex-start;gap:14px}.modal-head h2{font-size:18px;margin:0}.modal-head p{font-size:13px;line-height:1.5;color:var(--muted);margin:5px 0 0}.modal-body{padding:22px 24px;display:grid;gap:16px}.field{display:grid;gap:7px}.field label{font-size:13px;font-weight:650}.field input,.field textarea,.field select{width:100%;border:1px solid var(--line-strong);border-radius:7px;padding:10px 11px;outline:0;background:#fff}.field textarea{min-height:112px;resize:vertical}.field input:focus,.field textarea:focus,.field select:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 12%,transparent)}.hint{font-size:12px;color:var(--muted)}.modal-foot{padding:16px 24px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:10px}.toast{position:fixed;right:24px;bottom:24px;max-width:420px;background:#182230;color:#fff;border-radius:8px;padding:13px 16px;box-shadow:0 14px 38px rgba(16,24,40,.25);z-index:30}.toast.bad{background:#8f1d18}.mobile-back{display:none}
@media(max-width:1080px){.global{grid-template-columns:72px 230px minmax(260px,1fr)}.global>:last-child{display:none}.connector-head{padding-left:112px}.shell{grid-template-columns:92px minmax(420px,1fr) 340px}.rail{padding-inline:8px}.nav{min-height:64px}.inspector{padding:20px}.row{grid-template-columns:minmax(210px,1.4fr) minmax(100px,.65fr) 110px 74px}}
@media(max-width:820px){.app{grid-template-rows:62px 68px minmax(0,1fr)}.global{grid-template-columns:48px 1fr;padding:0 14px}.brand{font-size:16px}.global-search{grid-column:1/-1;position:absolute;top:70px;left:12px;right:12px;z-index:8;display:none}.global-search.mobile-open{display:flex}.connector-head{padding:0 14px}.mark{width:34px;height:34px}.connector-title{font-size:15px}.connection{display:none}.btn{padding:0 11px}.btn .label{display:none}.shell{grid-template-columns:1fr}.rail{position:fixed;left:0;right:0;bottom:0;height:64px;border:0;border-top:1px solid var(--line);background:#fff;z-index:10;display:grid;grid-template-columns:repeat(3,1fr);padding:4px}.nav{min-height:54px;flex-direction:row}.nav.active{box-shadow:inset 0 -3px var(--accent)}.main{padding:14px 14px 78px}.inspector{position:fixed;inset:130px 0 64px;background:#fff;z-index:9;border:0;padding:18px;transform:translateX(100%);transition:transform .2s ease}.inspector.open{transform:none}.mobile-back{display:inline-flex}.row{grid-template-columns:minmax(0,1fr) minmax(84px,100px) 36px;padding-inline:8px;gap:8px}.row .hide-mobile{display:none}.open-btn{width:36px;padding:0;font-size:0}.open-btn::after{content:"›";font-size:20px;line-height:1}.overview-list{grid-template-columns:1fr}.overview-item{border-right:0;border-bottom:1px solid var(--line)}.overview-item:last-child{border-bottom:0}.shortcut{display:none}}
@media print{.global,.connector-head,.rail,.toolbar,.inspector,.modal-backdrop,.toast{display:none!important}.app,.shell{display:block;height:auto;overflow:visible}.main{padding:0;overflow:visible}.table{border-color:#bbb}.row{break-inside:avoid}body{background:#fff}}
`;
document.head.append(style);

const state = { config: null, rows: [], activity: [], selected: null, tab: "resources", loading: true, error: "", query: "" };
const app = document.createElement("div");
app.className = "app";
document.body.append(app);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function statusText() {
  if (state.loading) return copy.connecting;
  if (state.error) return copy.error;
  return copy.connected;
}

function render() {
  const config = state.config || { title: copy.workspace, resourceName: copy.resources, searchPlaceholder: copy.search, accent: "#1473e6", actions: [], description: "" };
  document.documentElement.style.setProperty("--accent", config.accent || "#1473e6");
  app.innerHTML = `
    <header class="global">
      <button class="menu" id="menuButton" aria-label="${escapeHtml(copy.search)}">${icon("menu")}</button>
      <div class="brand">${escapeHtml(copy.workspace)}</div>
      <form class="global-search" id="searchForm">
        ${icon("search")}<input id="searchInput" value="${escapeHtml(state.query)}" placeholder="${escapeHtml(config.searchPlaceholder || copy.search)}" aria-label="${escapeHtml(copy.search)}"><span class="shortcut">⌘ K</span>
      </form><span></span>
    </header>
    <section class="connector-head">
      <div class="mark">${escapeHtml((config.title || "C").slice(0,1).toUpperCase())}</div>
      <div class="connector-title">${escapeHtml(config.title)}</div>
      <div class="connection"><span class="dot ${state.loading ? "loading" : state.error ? "error" : ""}"></span>${escapeHtml(statusText())}</div>
      <div class="head-actions">
        <button class="btn" id="refreshButton" ${state.loading ? "disabled" : ""}>${icon("refresh")}<span class="label">${escapeHtml(copy.refresh)}</span></button>
        <button class="btn primary" id="actionButton" ${config.actions?.length ? "" : "disabled"}>${icon("play")}<span class="label">${escapeHtml(copy.run)}</span></button>
      </div>
    </section>
    <div class="shell">
      <nav class="rail" aria-label="Primary">
        ${navButton("overview", copy.overview, "overview")}
        ${navButton("resources", copy.resources, "resources")}
        ${navButton("activity", copy.activity, "activity")}
      </nav>
      <main class="main">${renderMain(config)}</main>
      <aside class="inspector ${state.selected ? "open" : ""}">${renderInspector()}</aside>
    </div>`;
  bindEvents();
}

function navButton(tab, label, iconName) {
  return `<button class="nav ${state.tab === tab ? "active" : ""}" data-tab="${tab}">${icon(iconName)}<span>${escapeHtml(label)}</span></button>`;
}

function renderMain(config) {
  if (state.tab === "overview") {
    const writable = config.actions?.length || 0;
    return `<section class="overview"><div class="overview-copy"><h1>${escapeHtml(config.title)}</h1><p>${escapeHtml(config.description || "")}</p></div><div class="overview-rule"></div><div class="overview-list"><div class="overview-item"><div class="overview-number">${state.rows.length}</div><div class="overview-label">${escapeHtml(config.resourceName || copy.resources)}</div></div><div class="overview-item"><div class="overview-number">${state.activity.length}</div><div class="overview-label">${escapeHtml(copy.recent)}</div></div><div class="overview-item"><div class="overview-number">${writable}</div><div class="overview-label">${escapeHtml(writable ? copy.run : copy.readOnly)}</div></div></div></section>`;
  }
  if (state.tab === "activity") return renderActivityPage();
  if (state.loading) return `<div class="loading-view"><div><div class="spinner"></div>${escapeHtml(copy.loading)}</div></div>`;
  if (state.error) return renderEmpty(copy.error, state.error);
  return `<div class="toolbar"><select class="select" aria-label="Type"><option>${escapeHtml(state.config.resourceName || copy.resources)}</option></select><span class="count">${state.rows.length} ${escapeHtml(copy.records)}</span></div>${state.rows.length ? renderTable() : renderEmpty(copy.empty, copy.emptyHint)}`;
}

function renderEmpty(title, message) {
  return `<div class="empty"><div class="empty-inner"><div class="empty-symbol">${icon("resources")}</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></div></div>`;
}

function renderTable() {
  return `<div class="table" role="table"><div class="row header" role="row"><span>Name</span><span>Type</span><span class="hide-mobile">Updated</span><span></span></div>${state.rows.map((row, index) => `<div class="row item ${state.selected?.id === row.id ? "selected" : ""}" role="row" tabindex="0" data-row="${index}"><div class="name"><span class="resource-icon">${icon(row.icon || "file")}</span><div class="name-copy"><div class="name-title">${escapeHtml(row.title)}</div><div class="name-sub">${escapeHtml(row.subtitle || row.owner || "")}</div></div></div><div class="cell"><span class="state">${escapeHtml(row.kind || "Resource")}</span></div><div class="cell hide-mobile">${escapeHtml(formatDate(row.updatedAt))}</div><button class="open-btn" data-open="${index}">${escapeHtml(copy.open)}</button></div>`).join("")}</div>`;
}

function renderInspector() {
  const row = state.selected;
  if (!row) return `<div class="inspect-empty"><div><div class="empty-symbol">${icon("chevron")}</div><div>${escapeHtml(copy.details)}</div></div></div>`;
  const details = Array.isArray(row.details) ? row.details : [];
  return `<button class="btn mobile-back" id="backButton">${icon("chevron")} ${escapeHtml(copy.back)}</button><div class="inspect-head"><span class="resource-icon">${icon(row.icon || "file")}</span><div><div class="inspect-title">${escapeHtml(row.title)}</div><div class="inspect-type">${escapeHtml(row.kind || "Resource")}</div></div><button class="inspect-close" id="closeInspector" aria-label="Close">${icon("close")}</button></div><h3 class="section-title">${escapeHtml(copy.details)}</h3><dl class="detail-list">${details.map(item => `<div class="detail"><dt>${escapeHtml(item.label)}</dt><dd>${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.value)} ${icon("external")}</a>` : escapeHtml(item.value)}</dd></div>`).join("")}</dl>${row.url ? `<p><a class="btn" href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">${icon("external")} ${escapeHtml(copy.open)}</a></p>` : ""}<h3 class="section-title">${escapeHtml(copy.recent)}</h3>${renderActivityList(state.activity.filter(event => !event.resourceId || event.resourceId === row.id).slice(0,5))}`;
}

function renderActivityPage() {
  return `<section class="overview"><div class="overview-copy"><h1>${escapeHtml(copy.activity)}</h1><p>${escapeHtml(state.config.description || "")}</p></div><div class="overview-rule"></div>${renderActivityList(state.activity)}</section>`;
}

function renderActivityList(events) {
  if (!events.length) return `<p class="hint">${escapeHtml(copy.noActivity)}</p>`;
  return `<div class="activity-list">${events.map(event => `<div class="event"><span class="event-dot"></span><div class="event-title">${escapeHtml(event.title)}</div><div class="event-meta">${escapeHtml(formatDate(event.at))}${event.detail ? ` · ${escapeHtml(event.detail)}` : ""}</div></div>`).join("")}</div>`;
}

function bindEvents() {
  document.querySelectorAll("[data-tab]").forEach(button => button.addEventListener("click", () => { state.tab = button.dataset.tab; render(); }));
  document.getElementById("refreshButton")?.addEventListener("click", () => load());
  document.getElementById("actionButton")?.addEventListener("click", openActionModal);
  document.getElementById("menuButton")?.addEventListener("click", () => document.getElementById("searchForm")?.classList.toggle("mobile-open"));
  document.getElementById("searchForm")?.addEventListener("submit", event => { event.preventDefault(); state.query = document.getElementById("searchInput").value.trim(); load(); });
  document.querySelectorAll("[data-row]").forEach(element => {
    const choose = () => { state.selected = state.rows[Number(element.dataset.row)]; render(); };
    element.addEventListener("click", event => { if (!event.target.closest("[data-open]")) choose(); });
    element.addEventListener("keydown", event => { if (event.key === "Enter") choose(); });
  });
  document.querySelectorAll("[data-open]").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation(); const row = state.rows[Number(button.dataset.open)];
    if (row.url) window.open(row.url, "_blank", "noopener"); else { state.selected = row; render(); }
  }));
  document.getElementById("closeInspector")?.addEventListener("click", () => { state.selected = null; render(); });
  document.getElementById("backButton")?.addEventListener("click", () => { state.selected = null; render(); });
}

function openActionModal() {
  const actions = state.config.actions || [];
  if (!actions.length) return;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<form class="modal"><div class="modal-head"><div><h2>${escapeHtml(copy.actionTitle)}</h2><p>${escapeHtml(copy.actionHelp)}</p></div><button type="button" class="inspect-close" data-dismiss>${icon("close")}</button></div><div class="modal-body"><div class="field"><label>${escapeHtml(copy.selectAction)}</label><select name="action">${actions.map(action => `<option value="${escapeHtml(action.id)}">${escapeHtml(action.label)}</option>`).join("")}</select></div><div id="actionFields"></div></div><div class="modal-foot"><button type="button" class="btn" data-dismiss>${escapeHtml(copy.cancel)}</button><button type="submit" class="btn primary">${icon("play")} ${escapeHtml(copy.submit)}</button></div></form>`;
  document.body.append(backdrop);
  const form = backdrop.querySelector("form");
  const select = form.elements.action;
  const renderFields = () => {
    const action = actions.find(item => item.id === select.value) || actions[0];
    backdrop.querySelector("#actionFields").innerHTML = `<div style="display:grid;gap:16px">${(action.fields || []).map(field => `<div class="field"><label for="field-${escapeHtml(field.name)}">${escapeHtml(field.label)}</label>${field.type === "textarea" ? `<textarea id="field-${escapeHtml(field.name)}" name="${escapeHtml(field.name)}" ${field.required ? "required" : ""} placeholder="${escapeHtml(field.placeholder || "")}"></textarea>` : field.type === "file" ? `<input id="field-${escapeHtml(field.name)}" name="${escapeHtml(field.name)}" type="file" ${field.accept ? `accept="${escapeHtml(field.accept)}"` : ""} ${field.required ? "required" : ""}>` : `<input id="field-${escapeHtml(field.name)}" name="${escapeHtml(field.name)}" type="${escapeHtml(field.type || "text")}" ${field.required ? "required" : ""} placeholder="${escapeHtml(field.placeholder || "")}">`}${field.hint ? `<span class="hint">${escapeHtml(field.hint)}</span>` : ""}</div>`).join("")}</div>`;
  };
  renderFields(); select.addEventListener("change", renderFields);
  backdrop.querySelectorAll("[data-dismiss]").forEach(button => button.addEventListener("click", () => backdrop.remove()));
  backdrop.addEventListener("click", event => { if (event.target === backdrop) backdrop.remove(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
    try {
      const action = actions.find(item => item.id === select.value) || actions[0];
      const payload = {};
      for (const field of action.fields || []) {
        const control = form.elements[field.name];
        if (field.type === "file") {
          const file = control.files?.[0]; if (file) payload[field.name] = file;
        } else if (control.value !== "") payload[field.name] = control.value;
      }
      const result = await gadget.perform(action.id, payload);
      backdrop.remove(); toast(result?.message || action.label); await load(false);
    } catch (error) {
      toast(error?.message || copy.failed, true); submit.disabled = false;
    }
  });
}

function toast(message, bad = false) {
  document.querySelector(".toast")?.remove();
  const node = document.createElement("div"); node.className = `toast ${bad ? "bad" : ""}`; node.textContent = message;
  document.body.append(node); setTimeout(() => node.remove(), 5000);
}

async function load(showLoading = true) {
  if (showLoading) state.loading = true;
  state.error = ""; render();
  try {
    const result = await gadget.load(state.query);
    state.rows = Array.isArray(result.rows) ? result.rows : [];
    state.activity = Array.isArray(result.activity) ? result.activity : [];
    if (state.selected) state.selected = state.rows.find(row => row.id === state.selected.id) || null;
  } catch (error) {
    state.error = error?.message || String(error); state.rows = [];
  } finally { state.loading = false; render(); }
}

async function start() {
  try { state.config = await gadget.getConfig(); } catch (error) { state.error = error?.message || String(error); }
  render(); await load();
  if (["html", "pdf"].includes(globalThis.gadgetExportFormatId)) document.documentElement.classList.add("connector-export");
}

start();
