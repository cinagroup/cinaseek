const zh = navigator.language.toLowerCase().startsWith("zh");
const copy = zh ? {
  query: "搜索内容", limit: "最多结果数", search: "搜索（使用个人额度）", busy: "正在搜索…",
  notice: "请先连接自己的账户。每次提交会消耗该账户的搜索额度，具体计费由供应商决定。不抓取网页、不深度研究、不使用平台额度、不自动重试。",
  empty: "输入关键词后点击搜索。打开或刷新页面不会自动搜索；结果仅保留在当前页面。",
  none: "没有找到结果。", unknown: "供应商未返回额度消耗数值。", credits: "本次供应商报告的 credits：",
  failed: "搜索失败或状态未知，可能已扣除额度。未自动重试。",
} : {
  query: "Search query", limit: "Maximum results", search: "Search using personal credits", busy: "Searching…",
  notice: "Connect your own account first. Each submission uses that account's search credits at the provider's rates. No scraping, deep research, platform-paid fallback, or automatic retries.",
  empty: "Enter a query to begin. Opening or refreshing this page never searches automatically. Results stay only in this page.",
  none: "No results found.", unknown: "The provider did not report credit usage.", credits: "Provider-reported credits used: ",
  failed: "Search failed or its outcome is unknown; credits may have been consumed. No automatic retry was made.",
};

const style = document.createElement("style");
style.textContent = `
  :root { color-scheme: light dark; font-family: system-ui,sans-serif; }
  * { box-sizing: border-box; } body { margin: 0; background: Canvas; color: CanvasText; }
  main { max-width: 900px; margin: auto; padding: 32px 24px; }
  header { display: flex; align-items: center; gap: 16px; } h1 { font-size: 28px; margin: 0; }
  header img { width: 56px; height: 56px; object-fit: contain; background: white; border-radius: 12px; padding: 6px; }
  p { line-height: 1.6; } .notice { opacity: .8; } form { display: grid; grid-template-columns: 1fr 130px; gap: 16px; margin: 28px 0; }
  label { display: grid; gap: 8px; font-size: 14px; } input,button { font: inherit; border: 1px solid GrayText; border-radius: 8px; padding: 12px; min-width: 0; }
  button { grid-column: 1/-1; cursor: pointer; background: ButtonFace; color: ButtonText; } button:disabled { cursor: wait; opacity: .6; }
  input:focus-visible,button:focus-visible,a:focus-visible { outline: 2px solid Highlight; outline-offset: 3px; }
  #status { white-space: pre-wrap; overflow-wrap: anywhere; } article { border-top: 1px solid GrayText; padding: 20px 0; overflow-wrap: anywhere; }
  h2 { font-size: 19px; margin: 0; } a { color: LinkText; } article p { margin-bottom: 0; }
  @media(max-width: 520px) { main { padding: 24px 16px; } form { grid-template-columns: 1fr; } h1 { font-size: 24px; } }
  @media print { form { display: none; } main { max-width: none; padding: 0; } }
`;
document.head.append(style);
const main = document.createElement("main");
document.body.append(main);
let busy = false;

async function start() {
  const config = await gadget.getConfig();
  document.title = config.title;
  main.innerHTML = `<header><img alt=""><h1></h1></header><p class="notice"></p>
    <form><label><span id="queryLabel"></span><input name="query" required maxlength="2000" autocomplete="off"></label>
    <label><span id="limitLabel"></span><input name="limit" type="number" step="1" max="10" required></label><button type="submit"></button></form>
    <p id="status" role="status" aria-live="polite"></p><section id="results"></section>`;
  main.querySelector("img").src = config.logoUrl;
  main.querySelector("h1").textContent = config.title;
  main.querySelector(".notice").textContent = copy.notice;
  main.querySelector("#queryLabel").textContent = copy.query;
  main.querySelector("#limitLabel").textContent = copy.limit;
  const form = main.querySelector("form");
  form.elements.limit.min = String(config.minResults);
  form.elements.limit.value = String(config.minResults);
  const button = main.querySelector("button");
  const status = main.querySelector("#status");
  const results = main.querySelector("#results");
  button.textContent = copy.search;
  status.textContent = copy.empty;
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;
    busy = true; button.disabled = true; button.textContent = copy.busy;
    status.textContent = copy.busy; results.replaceChildren();
    try {
      const result = await gadget.search(form.elements.query.value, Number(form.elements.limit.value));
      status.textContent = (result.rows.length ? "" : `${copy.none} `) +
        (result.creditsUsed === null ? copy.unknown : `${copy.credits}${result.creditsUsed}`);
      for (const row of result.rows) {
        const article = document.createElement("article");
        const title = document.createElement("h2");
        if (row.url) {
          const link = document.createElement("a"); link.href = row.url; link.target = "_blank"; link.rel = "noopener noreferrer";
          link.textContent = row.title || row.url; title.append(link);
        } else title.textContent = row.title;
        const description = document.createElement("p"); description.textContent = row.description;
        article.append(title, description); results.append(article);
      }
    } catch (error) {
      status.textContent = `${copy.failed}\n${error?.message || ""}`;
    } finally { busy = false; button.disabled = false; button.textContent = copy.search; }
  });
}
start().catch(error => { main.textContent = error?.message || copy.failed; });
