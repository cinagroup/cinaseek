# Cloudflare 上游同步约定

## 分支职责

| 引用 | 用途 | 写入规则 |
| --- | --- | --- |
| `upstream/main` | `cloudflare/cloudflare-os` 的官方源码 | 只拉取，不从本项目推送 |
| `origin/origin` | `cinagroup/cinaseek` 中名为 `origin` 的镜像分支 | 仅快进到已核实的官方提交，不放 CinaSeek 定制 |
| `origin/main` | CinaSeek 的集成主分支 | 通过独立同步分支审查、测试后合并 |

`origin/origin` 是远程跟踪引用，不是另一个 Git remote，也不是本项目的默认分支。
本地 `main` 继续跟踪 `origin/main`；不改为跟踪镜像分支。

## 每次同步

1. 确认工作区干净，拉取两边并固定本次目标 SHA；同步期间不追逐更新的上游提交。

   ```sh
   git fetch upstream main
   git fetch origin
   git rev-parse upstream/main origin/origin origin/main
   git merge-base --is-ancestor origin/origin upstream/main
   ```

2. 只有祖先检查成功才快进远端镜像。将下面占位符替换为刚核实的完整 SHA；禁止强推。

   ```sh
   git push origin <verified-upstream-sha>:refs/heads/origin
   git fetch origin
   ```

   若镜像已经等于目标 SHA，无须重复推送。若出现分叉或远端已前进，停止并核实，不能覆盖。

3. 从最新 `origin/main` 创建 `codex/sync-upstream-main-<date>`，将固定 SHA 合入，逐项处理冲突。
   保留上游提交历史；不把 CinaSeek 的定制提交反向写入镜像。

4. 本地运行 `pnpm install --frozen-lockfile`、`pnpm lint` 和可用的回归测试，随后推送整合分支并创建 PR。
   Linux CI 的 Lint、Build and test 必须通过，Windows workerd 启动失败不能视为 Worker 测试通过。
   新增的 Workshop evals 是手动工作流；它会调用真实模型，不作为自动同步步骤执行。

5. 检查品牌、登录/退出、管理员权限、费用配额、R2 附件、Realtime、语音输入、草稿恢复及运行实例复用的重叠代码。
   构建入口变更要覆盖 CinaSeek 自有包，根任务过滤器必须使用本项目名 `!cinaseek`。

6. 记录 CI 结果和任何明确批准的单次豁免。确认主分支和 PR 头未变后合并；只清理已经合并的临时分支，始终保留 `origin/origin`。

## 发布边界

同步或合并源码不等于生产部署。生产发布、凭据变更、付费模型评估及自动定时同步分别需要授权。
CLA/Bonk 的单次豁免不会改写检查结果，也不自动适用于后续 PR。

## 2026-09-07 整合注意事项

本次固定上游为 `c0b6f3e52ff0ab8d44d290647e256936e88e6b57`，待整合的上游历史为 37 个提交。
同步时远端镜像已经指向该提交，无须再次推进镜像。

上游把聊天输入拆为 `features/chat/composer/`，CinaSeek 的语音输入、草稿键和休眠完整性通知在新入口保留。
上游发布清单现在规范化安装 slug：新客户安装的 Workers AI 连接器使用 `workersai` 且只允许安装一次。
这不修改现有生产 Worker 的绑定、路由或用户连接；现有部署升级时仍需核实部署服务对既有安装标识的处理。
