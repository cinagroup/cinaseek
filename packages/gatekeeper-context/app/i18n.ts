import { useSyncExternalStore } from "react";
import type { GatekeeperAppLocale } from "@gadgets/workshop-shared/theme";

type Variables = Record<string, string | number>;

const zhCN: Record<string, string> = {
  "Context & Skills": "上下文与技能",
  "Collections of documents, skills, and other files your agents can use.": "整理智能体可使用的文档、技能和其他文件。",
  "Choose an icon": "选择图标",
  "Provided by your organization for everyone": "由你的组织提供给所有成员",
  "A collection you created": "你创建的集合",
  "Required by your organization": "组织要求启用",
  "Created by you": "由你创建",
  "No description": "暂无描述",
  "Optional": "可选",
  "Name": "名称",
  "A short name, e.g., Brand guidelines": "简短名称，例如：品牌指南",
  "Description": "描述",
  "What it contains and when to use it, e.g., voice and tone rules for customer-facing writing": "说明包含的内容及使用场景，例如：面向客户写作的语调与风格规则",
  "Close": "关闭",
  "This permanently deletes": "此操作将永久删除",
  "and all": "以及其中的全部",
  "inside it": "",
  ". This cannot be undone.": "。此操作无法撤销。",
  "{{count}} document": "{{count}} 篇文档",
  "{{count}} documents": "{{count}} 篇文档",
  "{{count}} file": "{{count}} 个文件",
  "{{count}} files": "{{count}} 个文件",
  "Only me": "仅自己",
  "Private to your account. Only you can view and edit it.": "仅限你的账户访问。只有你可以查看和编辑。",
  "Everyone": "所有成员",
  "Shared across your organization and turned on for all users.": "在组织内共享，并为所有用户启用。",
  "Editable documents": "可编辑文档",
  "Create, edit, and delete files through the CinaSeek UI.": "通过 CinaSeek 界面创建、编辑和删除文件。",
  "Git mirror": "Git 镜像",
  "Push content from git using repository mirroring. All changes must be made through git.": "通过仓库镜像从 Git 推送内容；所有更改都必须通过 Git 完成。",
  "Collection created": "集合已创建",
  "Failed to create collection": "创建集合失败",
  "New collection": "新建集合",
  "A collection of documents, skills, and other files your agents can use.": "包含智能体可使用的文档、技能和其他文件。",
  "Type": "类型",
  "Collection type": "集合类型",
  "Visibility": "可见范围",
  "Cancel": "取消",
  "Create collection": "创建集合",
  "Search collections…": "搜索集合…",
  "No collections match": "没有匹配的集合",
  "No collections yet": "还没有集合",
  "Try a different search term.": "请尝试其他搜索词。",
  "Create a collection to give your agents context to work with.": "创建集合，为智能体提供工作所需的上下文。",
  "Context collection": "上下文集合",
  "Refresh": "刷新",
  "Source": "来源",
  "Your organization": "你的组织",
  "You": "你",
  "Access": "访问范围",
  "Everyone (required)": "所有成员（必需）",
  "Private to you": "仅自己可见",
  "Documents": "文档",
  "Refreshed": "刷新时间",
  "Updated": "更新时间",
  "Git synchronization unavailable": "Git 同步不可用",
  "Git content is read-only and shows its most recently cached version.": "Git 内容为只读，当前显示最近缓存的版本。",
  "No description yet.": "暂无描述。",
  "No files in this collection": "此集合中没有文件",
  "This git mirror is empty. Mirror content from git, then refresh.": "此 Git 镜像为空。请从 Git 镜像内容后刷新。",
  "No Git content was cached before synchronization became unavailable.": "同步不可用前没有缓存任何 Git 内容。",
  "Use the + in the Files panel to create or upload skills or files. Agents use the names and descriptions to decide what to read.": "使用“文件”面板中的 + 创建或上传技能及文件。智能体会根据名称和描述判断需要读取的内容。",
  "This collection is empty.": "此集合为空。",
  "Collection options": "集合选项",
  "Options": "选项",
  "Edit details": "编辑详情",
  "Manage git tokens": "管理 Git 令牌",
  "Delete collection": "删除集合",
  "Name can't be empty": "名称不能为空",
  "Collection updated": "集合已更新",
  "Failed to update collection": "更新集合失败",
  "Collection deleted": "集合已删除",
  "Failed to delete collection": "删除集合失败",
  "Edit collection": "编辑集合",
  "Git branch": "Git 分支",
  "This branch to pull from when refreshing the collection.": "刷新集合时从此分支拉取内容。",
  "Save": "保存",
  "to confirm": "以确认",
  "Failed to load Git tokens: {{error}}": "加载 Git 令牌失败：{{error}}",
  "Git token created": "Git 令牌已创建",
  "Failed to create Git token: {{error}}": "创建 Git 令牌失败：{{error}}",
  "Git token revoked": "Git 令牌已撤销",
  "Failed to revoke Git token: {{error}}": "撤销 Git 令牌失败：{{error}}",
  "Create a token to mirror content from an external git repository.": "创建令牌，以便从外部 Git 仓库镜像内容。",
  "Create token": "创建令牌",
  "Token created": "令牌已创建",
  "Use these credentials to push content to your collection. The password is only shown once.": "使用这些凭据将内容推送到集合。密码仅显示一次。",
  "Remote URL": "远程 URL",
  "Remote URL copied": "远程 URL 已复制",
  "Failed to copy remote URL": "复制远程 URL 失败",
  "Password": "密码",
  "Password copied": "密码已复制",
  "Failed to copy password": "复制密码失败",
  "Copy": "复制",
  "Configure GitLab mirroring": "配置 GitLab 镜像",
  "These steps are specific to GitLab. Other git providers may use different setup flows.": "以下步骤适用于 GitLab；其他 Git 提供商的设置流程可能不同。",
  "Open your GitLab project and go to Settings > Repository > Mirroring repositories": "打开 GitLab 项目，然后前往“设置 > 仓库 > 镜像仓库”",
  "Click \"Add new\" button to open setup flow": "点击“新增”按钮开始设置",
  "Set Git repository URL to the remote URL above": "将 Git 仓库 URL 设置为上方的远程 URL",
  "Set Mirror direction to Push": "将镜像方向设置为“推送”",
  "Set Authentication method to Username and Password": "将身份验证方式设置为“用户名和密码”",
  "Set Username to \"gitlab\"": "将用户名设置为“gitlab”",
  "Set Password to the password above": "将密码设置为上方的密码",
  "Select Mirror specific branches and type in \"{{branch}}\"": "选择“镜像指定分支”并输入“{{branch}}”",
  "Click \"Mirror repository\" button to finish": "点击“镜像仓库”按钮完成设置",
  "Click \"Update now\" button to trigger an initial push": "点击“立即更新”按钮触发首次推送",
  "Loading tokens…": "正在加载令牌…",
  "No Git tokens yet.": "还没有 Git 令牌。",
  "expires {{date}}": "到期日期：{{date}}",
  "Revoke": "撤销",
  "Contains a valid Agent Skill": "包含有效的智能体技能",
  "skill": "技能",
  "Actions for {{name}}": "{{name}} 的操作",
  "New file": "新建文件",
  "New folder": "新建文件夹",
  "Rename": "重命名",
  "Delete": "删除",
  "Collection refreshed": "集合已刷新",
  "Failed to refresh: {{error}}": "刷新失败：{{error}}",
  "Failed to create file": "创建文件失败",
  "Failed to rename: {{error}}": "重命名失败：{{error}}",
  "Failed to move: {{error}}": "移动失败：{{error}}",
  "Failed to delete folder": "删除文件夹失败",
  "Failed to delete document": "删除文档失败",
  "Uploaded {{files}}{{failed}}": "已上传 {{files}}{{failed}}",
  ", {{count}} failed": "，{{count}} 个失败",
  "This collection is no longer available": "此集合已不可用",
  "It may have been deleted.": "它可能已被删除。",
  "Delete folder": "删除文件夹",
  "Delete document": "删除文档",
  "Collection overview": "集合概览",
  "Files": "文件",
  "Add": "添加",
  "Add file or folder": "添加文件或文件夹",
  "Upload files": "上传文件",
  "Upload folder": "上传文件夹",
  "Loading…": "正在加载…",
  "No files yet. Mirror content from git, then refresh.": "还没有文件。请从 Git 镜像内容后刷新。",
  "No files yet. Use + to create or upload skills or files.": "还没有文件。使用 + 创建或上传技能及文件。",
  "No files yet.": "还没有文件。",
  "This document is empty.": "此文档为空。",
  "Binary document ({{type}}, {{size}} KB). Use Replace to update it.": "二进制文档（{{type}}，{{size}} KB）。请使用“替换”进行更新。",
  "Failed to load document: {{error}}": "加载文档失败：{{error}}",
  "Saved": "已保存",
  "Failed to save": "保存失败",
  "File name can't contain '/'": "文件名不能包含“/”",
  "Rename failed: {{error}}": "重命名失败：{{error}}",
  "File name — edit to rename (the extension sets the type)": "文件名——编辑即可重命名（扩展名决定文件类型）",
  "Replace": "替换",
  "View": "查看",
  "Source code": "源代码",
  "Edit": "编辑",
  "When to use this": "何时使用",
  "Defined in this file; edit it in the document below.": "此描述在文件中定义；请在下方文档中编辑。",
  "from file": "来自文件",
  "No description in this file yet.": "此文件中暂无描述。",
  "Describe what this document contains and when an agent should use it…": "说明此文档包含的内容，以及智能体应在何时使用它…",
  "Something went wrong": "出现错误",
  "Reload": "重新加载",
};

const zhTWPhrases: Array<[string, string]> = [
  ["智能体", "代理程式"],
  ["文档", "文件"],
  ["通过", "透過"],
  ["查看", "檢視"],
  ["创建", "建立"],
  ["加载", "載入"],
  ["暂无", "尚無"],
  ["还没有", "尚無"],
  ["用户", "使用者"],
  ["账户", "帳戶"],
  ["组织", "組織"],
  ["文件夹", "資料夾"],
  ["仓库", "儲存庫"],
  ["远程", "遠端"],
  ["令牌", "權杖"],
  ["源代码", "原始碼"],
  ["可复用", "可重複使用"],
];

const traditionalCharacters: Record<string, string> = {
  "与": "與", "个": "個", "义": "義", "为": "為", "仅": "僅", "从": "從",
  "仓": "倉", "会": "會", "传": "傳", "体": "體", "关": "關", "内": "內",
  "写": "寫", "决": "決", "凭": "憑", "击": "擊", "则": "則", "创": "創",
  "删": "刪", "动": "動", "发": "發", "启": "啟", "员": "員", "围": "圍",
  "图": "圖", "场": "場", "复": "復", "夹": "夾", "将": "將", "尝": "嘗",
  "库": "庫", "应": "應", "开": "開", "当": "當", "户": "戶", "扩": "擴",
  "择": "擇", "换": "換", "据": "據", "断": "斷", "无": "無", "时": "時",
  "显": "顯", "暂": "暫", "来": "來", "标": "標", "档": "檔", "没": "沒",
  "点": "點", "现": "現", "码": "碼", "确": "確", "称": "稱", "简": "簡",
  "类": "類", "组": "組", "织": "織", "给": "給", "缓": "緩", "编": "編",
  "见": "見", "规": "規", "览": "覽", "触": "觸", "认": "認", "设": "設",
  "访": "訪", "证": "證", "词": "詞", "试": "試", "详": "詳", "语": "語",
  "误": "誤", "说": "說", "请": "請", "读": "讀", "调": "調", "败": "敗",
  "账": "賬", "载": "載", "辑": "輯", "输": "輸", "过": "過", "还": "還",
  "这": "這", "进": "進", "远": "遠", "适": "適", "选": "選", "钮": "鈕",
  "销": "銷", "错": "錯", "镜": "鏡", "闭": "閉", "问": "問", "间": "間",
  "项": "項", "须": "須", "风": "風", "验": "驗", "骤": "驟",
};

function toTraditional(value: string): string {
  let result = value;
  for (const [from, to] of zhTWPhrases) result = result.replaceAll(from, to);
  return [...result].map((character) => traditionalCharacters[character] ?? character).join("");
}

const listeners = new Set<() => void>();
let currentLocale: GatekeeperAppLocale = "en";

/** Applies the host locale and notifies mounted Context Library surfaces. */
export function setContextLocale(locale: GatekeeperAppLocale): void {
  document.documentElement.lang = locale;
  document.title = contextMessageForLocale(locale, "Context & Skills");
  if (currentLocale === locale) return;
  currentLocale = locale;
  for (const listener of listeners) listener();
}

/** Returns the locale currently supplied by the Workshop host. */
export function getContextLocale(): GatekeeperAppLocale {
  return currentLocale;
}

/** Subscribes a component to live host-locale changes. */
export function useContextLocale(): GatekeeperAppLocale {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getContextLocale,
    getContextLocale,
  );
}

/** Translates an English Context Library source message in the current host locale. */
export function contextMessage(source: string, variables?: Variables): string {
  return contextMessageForLocale(currentLocale, source, variables);
}

/** Translates an English Context Library source message for an explicit locale. */
export function contextMessageForLocale(
  locale: string,
  source: string,
  variables?: Variables,
): string {
  const normalized = locale.toLowerCase();
  const simplified = zhCN[source];
  const template = normalized.startsWith("zh-tw") || normalized.startsWith("zh-hant")
    ? simplified ? toTraditional(simplified) : source
    : normalized.startsWith("zh")
      ? simplified ?? source
      : source;
  if (!variables) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.hasOwn(variables, key) ? String(variables[key]) : match,
  );
}

/** Formats a count-aware Context Library noun. */
export function contextCount(count: number, noun: "document" | "file"): string {
  return contextMessage(`{{count}} ${noun}${count === 1 ? "" : "s"}`, { count });
}
