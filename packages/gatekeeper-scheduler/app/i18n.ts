import { useSyncExternalStore } from "react";
import type { GatekeeperAppLocale } from "@gadgets/workshop-shared/theme";

type Variables = Record<string, string | number>;

const zhCN: Record<string, string> = {
  "Scheduled tasks": "定时任务",
  "Wake a workspace and run its code on a schedule you choose.": "按你选择的计划唤醒工作区并运行其中的代码。",
  "Create schedule": "创建定时任务",
  "Search scheduled tasks": "搜索定时任务",
  "Search scheduled tasks…": "搜索定时任务…",
  "Schedule status": "定时任务状态",
  "All": "全部",
  "Active": "运行中",
  "Needs attention": "需要处理",
  "Finished": "已结束",
  "Loading scheduled tasks…": "正在加载定时任务…",
  "Couldn’t load scheduled tasks.": "无法加载定时任务。",
  "Try again": "重试",
  "No scheduled tasks match these filters.": "没有符合当前筛选条件的定时任务。",
  "Loading…": "正在加载…",
  "Load more": "加载更多",
  "Get started": "快速开始",
  "Unavailable workspace": "工作区不可用",
  "Hide why {{title}} needs attention": "收起 {{title}} 需要处理的原因",
  "Show why {{title}} needs attention": "展开 {{title}} 需要处理的原因",
  "Daily brief": "每日简报",
  "Weekdays at 8:00 AM": "工作日上午 8:00",
  "Your calendar for the day plus the unread mail that needs a reply": "汇总当天日历和需要回复的未读邮件",
  "Weekly roundup": "每周汇总",
  "Fridays at 4:00 PM": "每周五下午 4:00",
  "Turn the week’s Linear issues and GitHub pull requests into a status update": "将本周 Linear 问题和 GitHub 拉取请求整理成状态更新",
  "Follow-up monitor": "跟进监控",
  "Weekdays at 9:00 AM": "工作日上午 9:00",
  "Flag the Gmail threads that are waiting on your reply": "标记等待你回复的 Gmail 会话",
  "Metrics snapshot": "指标快照",
  "Mondays at 8:00 AM": "每周一上午 8:00",
  "Refresh a spreadsheet or query and call out what moved": "刷新电子表格或查询，并指出关键变化",
  "Help me create a scheduled task. Ask me what it should do, which workspace and resources it should use, when it should run, and which timezone to use. Then set up the schedule.": "帮我创建一个定时任务。请询问任务内容、要使用的工作区和资源、运行时间以及时区，然后设置该任务。",
  "Every weekday at 8:00 AM, send me a short brief of my calendar for the day and the unread email that needs a reply. Ask me which calendar and mailbox to use and which timezone to use, then set up the schedule.": "每个工作日上午 8:00，向我发送当天日历和需要回复的未读邮件简报。请先询问要使用的日历、邮箱和时区，然后设置定时任务。",
  "Every Friday at 4:00 PM, turn this week’s Linear issues and GitHub pull requests into a status update. Ask me which Linear team, GitHub repositories, and timezone to use, then set up the schedule.": "每周五下午 4:00，将本周 Linear 问题和 GitHub 拉取请求整理成状态更新。请先询问 Linear 团队、GitHub 仓库和时区，然后设置定时任务。",
  "Every weekday at 9:00 AM, flag the Gmail threads that are waiting on my reply. Ask me which mailbox, destination, and timezone to use, then set up the schedule.": "每个工作日上午 9:00，标记等待我回复的 Gmail 会话。请先询问邮箱、发送目标和时区，然后设置定时任务。",
  "Every Monday at 8:00 AM, refresh a spreadsheet or query and call out what moved. Ask me which data source, destination, and timezone to use, then set up the schedule.": "每周一上午 8:00，刷新电子表格或查询并指出关键变化。请先询问数据源、发送目标和时区，然后设置定时任务。",
  "Every hour": "每小时",
  "Every {{count}} hours": "每 {{count}} 小时",
  "Every day": "每天",
  "Every {{count}} days": "每 {{count}} 天",
  "Every week": "每周",
  "Every {{count}} weeks": "每 {{count}} 周",
  "Every minute": "每分钟",
  "Every {{count}} minutes": "每 {{count}} 分钟",
  "Every second": "每秒",
  "Every {{count}} seconds": "每 {{count}} 秒",
  "Every millisecond": "每毫秒",
  "Every {{count}} milliseconds": "每 {{count}} 毫秒",
  "Once on {{date}} at {{time}}": "于 {{date}} {{time}} 执行一次",
  "Hourly at :{{minute}}": "每小时的 :{{minute}}",
  "Every {{count}} hours at :{{minute}}": "每 {{count}} 小时的 :{{minute}}",
  "Daily at {{time}}": "每天 {{time}}",
  "Every {{count}} days at {{time}}": "每 {{count}} 天的 {{time}}",
  "Weekdays at {{time}}": "工作日 {{time}}",
  "Weekly on {{days}} at {{time}}": "每周{{days}} {{time}}",
  "Every {{count}} weeks on {{days}} at {{time}}": "每 {{count}} 周的{{days}} {{time}}",
  "{{current}} of {{total}} occurrence": "已执行 {{current}} / {{total}} 次",
  "{{current}} of {{total}} occurrences": "已执行 {{current}} / {{total}} 次",
  "until {{date}}": "截止 {{date}}",
  "Next run pending": "等待确定下次运行时间",
  "Next run {{relative}}": "下次运行：{{relative}}",
  "Next run {{relative}} (retry)": "下次重试：{{relative}}",
  "Failed {{relative}}": "失败于{{relative}}",
  "Completed {{relative}}": "完成于{{relative}}",
  "Expired {{relative}}": "已于{{relative}}过期",
  "Authorization failed after retries.": "多次重试后授权仍然失败。",
  "Task callback failed after retries.": "多次重试后任务回调仍然失败。",
  "This recurring task used its last scheduled occurrence.": "此周期任务已完成最后一次计划运行。",
  "This one-time task completed.": "此一次性任务已完成。",
  "This one-time task passed without delivery.": "此一次性任务已过期且未执行。",
  "This recurring task's cutoff passed before its first occurrence.": "此周期任务在首次运行前已超过截止时间。",
  "Something went wrong": "出现错误",
  "Reload": "重新加载",
};

const zhTW: Record<string, string> = {
  "Scheduled tasks": "排程任務",
  "Wake a workspace and run its code on a schedule you choose.": "依你選擇的排程喚醒工作區並執行其中的程式碼。",
  "Create schedule": "建立排程任務",
  "Search scheduled tasks": "搜尋排程任務",
  "Search scheduled tasks…": "搜尋排程任務…",
  "Schedule status": "排程任務狀態",
  "All": "全部",
  "Active": "執行中",
  "Needs attention": "需要處理",
  "Finished": "已結束",
  "Loading scheduled tasks…": "正在載入排程任務…",
  "Couldn’t load scheduled tasks.": "無法載入排程任務。",
  "Try again": "重試",
  "No scheduled tasks match these filters.": "沒有符合目前篩選條件的排程任務。",
  "Loading…": "正在載入…",
  "Load more": "載入更多",
  "Get started": "快速開始",
  "Unavailable workspace": "工作區無法使用",
  "Daily brief": "每日簡報",
  "Weekly roundup": "每週彙整",
  "Follow-up monitor": "跟進監控",
  "Metrics snapshot": "指標快照",
  "Something went wrong": "發生錯誤",
  "Reload": "重新載入",
};

const schedulerTraditionalPhrases: Array<[string, string]> = [
  ["定时任务", "排程任務"],
  ["计划", "排程"],
  ["运行", "執行"],
  ["工作区", "工作區"],
  ["加载", "載入"],
  ["拉取请求", "拉取請求"],
  ["电子表格", "試算表"],
  ["仓库", "儲存庫"],
  ["日历", "行事曆"],
  ["回复", "回覆"],
  ["汇总", "彙整"],
];

const schedulerTraditionalCharacters: Record<string, string> = {
  "个": "個", "仓": "倉", "会": "會", "关": "關", "内": "內", "划": "劃",
  "创": "創", "务": "務", "区": "區", "历": "歷", "发": "發", "变": "變",
  "唤": "喚", "团": "團", "处": "處", "复": "復", "将": "將", "帮": "幫",
  "库": "庫", "开": "開", "当": "當", "态": "態", "总": "總", "执": "執",
  "报": "報", "择": "擇", "据": "據", "数": "數", "无": "無", "时": "時",
  "权": "權", "条": "條", "标": "標", "汇": "匯", "没": "沒", "状": "狀",
  "现": "現", "电": "電", "监": "監", "码": "碼", "确": "確", "筛": "篩",
  "简": "簡", "结": "結", "计": "計", "记": "記", "设": "設", "试": "試",
  "话": "話", "询": "詢", "该": "該", "误": "誤", "请": "請", "读": "讀",
  "调": "調", "败": "敗", "资": "資", "载": "載", "过": "過", "运": "運",
  "进": "進", "选": "選", "邮": "郵", "钟": "鐘", "错": "錯", "键": "鍵",
  "问": "問", "间": "間", "队": "隊", "题": "題", "周": "週", "于": "於",
  "显": "顯", "项": "項", "启": "啟", "续": "續", "满": "滿",
};

function toSchedulerTraditional(value: string): string {
  let result = value;
  for (const [from, to] of schedulerTraditionalPhrases) result = result.replaceAll(from, to);
  return [...result]
    .map((character) => schedulerTraditionalCharacters[character] ?? character)
    .join("");
}

const listeners = new Set<() => void>();
let currentLocale: GatekeeperAppLocale = "en";

/** Applies the host locale and notifies mounted Scheduler surfaces. */
export function setSchedulerLocale(locale: GatekeeperAppLocale): void {
  document.documentElement.lang = locale;
  document.title = schedulerMessageForLocale(locale, "Scheduled tasks");
  if (currentLocale === locale) return;
  currentLocale = locale;
  for (const listener of listeners) listener();
}

/** Returns the locale currently supplied by the Workshop host. */
export function getSchedulerLocale(): GatekeeperAppLocale {
  return currentLocale;
}

/** Subscribes a component to live host-locale changes. */
export function useSchedulerLocale(): GatekeeperAppLocale {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSchedulerLocale,
    getSchedulerLocale,
  );
}

/** Translates an English Scheduler source message in the current host locale. */
export function schedulerMessage(source: string, variables?: Variables): string {
  return schedulerMessageForLocale(currentLocale, source, variables);
}

/** Translates an English Scheduler source message for an explicit locale. */
export function schedulerMessageForLocale(
  locale: string,
  source: string,
  variables?: Variables,
): string {
  const normalized = locale.toLowerCase();
  const traditional = normalized.startsWith("zh-tw") || normalized.startsWith("zh-hant");
  const template = traditional
    ? zhTW[source] ?? toSchedulerTraditional(zhCN[source] ?? source)
    : normalized.startsWith("zh")
      ? zhCN[source] ?? source
      : source;
  if (!variables) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.hasOwn(variables, key) ? String(variables[key]) : match,
  );
}
