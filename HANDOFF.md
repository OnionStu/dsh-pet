# dsh-pet fork 交接文档 —— 跨会话审批提醒（方案 A 落地）

> 交接日期：2026-09-17。写给下一个会话：按本文直接开工，**不需要重新考古**（所有 API 契约已逐一验证，路径行号给全）。

## 目标（用户已拍板：方案 A，不做 B/fork 外打补丁）

DSH 的「等待审批」卡片目前只在发起审批的那个会话内显示（core 把 ApprovalPanel 注册在 `conversation.composer` 插槽），用户切不到会话就永远发现不了。要在 **dsh-pet fork** 里补上跨会话通知：

1. **宠物气泡带会话名、可点击跳转**：任何会话挂着待审批（含等待用户选择题）时，在宠物头顶显示「「会话标题」等你审批 · 工具名」，点击 = 切到该会话；当前正看着的会话**过滤不提醒**（已经在看就别催）。
2. **系统 toast 复活并带会话名**：页面失焦时弹 Web Notification（dsh-pet 0.2.11 的 toast 链路已被上游修好，只差会话归属）；**且当审批不属于当前会话时，即使页面聚焦也要弹**（现在的聚焦门一刀切，正是用户痛点）。toast 点击 = 聚焦页面 + 跳到该会话。
3. **标签页标题角标**：`[N 待审批]` 前缀（N=非当前会话的待审批数），清零还原。

## 当前状态（已完成 ✅）

- **方案 1 已生效**：`~/.dsh/dsh-pet/main-config.json` 给 main 宠物（蓝毛小女仆）加了 `"workStatusEnabled": true`。实测确认：其它会话挂审批时，宠物在全局任何界面都会播 waiting 动画 + 弹通用气泡（「需要你确认一下呢」档位文案，来自 config `workStatusTexts[3]`）。**用户看到了，确认有效**——但不知道是哪个会话、点不动，这就是本 fork 要补的。
  - 该配置 host 按请求现读磁盘，改完只需刷新页面（不用重启 dsh）。
- **fork 就位**：仓库根 `<仓库根>`（monorepo，**插件包在 `dsh-pet/` 子目录**）。origin=`https://github.com/OnionStu/dsh-pet`，upstream=`https://github.com/PC2005-cloud/dsh-pet`。main=**0.2.11**=上游最新（用户装的旧版 0.2.7 已在 profile `node_modules/dsh-pet`）。
- **依赖装好、构建可用**：`pnpm install` 在 `dsh-pet/` 子包完成（全局 store `<pnpm 全局 store>`，走代理 127.0.0.1:7897，pnpm=10.15.1 与 profile 一致）。`lib/` 已产出（prepare 生命周期跑过）。
- **测试基线**：`npm test` → **176/177 通过**。唯一失败：`src/host/helper-process.test.ts` 的 `resolveElectronPath —— 候选优先级`（Electron 桌面路径解析，与本特性无关，**克隆后原样失败、非我们弄坏**）。
- git 身份已配（OnionStu）。**规矩：本地 commit 随便，`git push` 一律由用户本人执行**。

## 已验证的关键契约（照抄即可，别再全局 grep）

DSH dist 根：`<全局 node_modules>/@deepseek-ai/dsh/node_modules/@deepseek-ai/`（下称 `$D`）。

| 事项 | 结论 | 出处 |
| --- | --- | --- |
| 审批卡片为何只在会话内 | `ApprovalPanel` 注入 `conversation.composer`，select 匹配 `pendingInteraction instanceof PendingApproval` | `$D/dsh-client-ui-approval/lib/client.js`（236-291 行，`answerApproval`/`apply`） |
| **全局待审批数据源（纯 client，本次主力）** | `ctx.uiSession.pendingInteractions: HostObservable<ReadonlyMap<SessionId, SessionPendingInteraction>>`；条目含 `kind:'approval'｜'question'、sessionId、toolName、reason、key`；审批被处理即从 map 移除（天然消失） | `$D/dsh-client-ui-session/lib/types/client/index.d.ts`（13-39、96 行）；注册方=approval 插件 `registerPendingInteraction` |
| observable 订阅面 | `.subscribe(cb)` + `.getSnapshot()`（core 自己就这么用） | `$D/dsh-client-ui-session/lib/client.js` 117、204 行 |
| **会话跳转 API** | `ctx.sessions.open(sessionId)` | 用户本地插件实证：`<邻居插件>/lib/client.js` 392 行 |
| 会话列表/当前/标题 | `ctx.sessions.list: ObservableSnapshot<SessionListState>`；`SessionListState{ids, byId: SessionSummary, current}`；`SessionSummary{sessionId, cwd?, running, projections?}`；标题在 `projections?.values?.title`（=`SessionTitleSnapshot.title`，缺时 fallback `basename(cwd)`，再缺显示 sessionId 前 8 位） | `$D/dsh-api-session-controller/lib/types/client/contract/sessions.d.ts`（19-45 行）+ `types.d.ts`（138-146 行 SessionSummary、21-26 行投影注册）+ `$D/dsh-session-title/lib/types/types.d.ts`（36-50 行） |
| 转发事件 allowlist | 现在只有 `approval/request`、`user-questions/request`（waterfall）+ `api-session/*` 等；**0.2.7 监听的 `api.events.mux` 已被删** → 那条 toast 链路死透，0.2.11 才换掉 | `$D/dsh-api-remotes/lib/types/remote-events.js` |
| host 会话 id 提取写法 | `session?.header?.id ?? session?.id ?? 'unknown'`（work-status 监听器里现成） | fork `dsh-pet/src/host/index.ts` ~960 行 |
| 宠物侧现状（0.2.11，fork 内） | toast 引擎=`client/notify.ts`：1s 轮询 `/dsh-pet-7340/notify?since=seq`（host 由 `session/event`+`agent/error` 生成帧，见 `src/host/notify-events.ts` 文件头注释）；聚焦门 `isPageActive()` 一刀切（notify.ts 顶部）；帧→文案在 `src/shared/notify.ts frameToToast`（approval 分支已含 toolName/reason，**无 sessionId**）；work-status 轮询在容器层，PetCard 的 `workBubbleOn` 效果块在 `src/client/pet.ts` ~358-390 行；气泡样式 `src/client/bubble.ts`（`.dsh-pet-bubble`，`pointer-events:none` 要出可点变体）；app.ts `inject=['slots','locale','connection','remote','remote.commands','commandUi']`（28 行） | fork 源码 |
| 广播通道不可用 | 宠物 `/broadcast` 缓存只能 host 内 `/chat` 命令写，**没有对外写接口** → 「让宠物原生气泡说话」不可行，自绘气泡卡是正解 | `src/host/index.ts` 222-230、720-730 行 |
| 其它已装件 | 第二只宠物 `@linxin666/dsh-pet@0.3.22`（dsh-web-all 套件带的 Live2D 宠物，无任何审批逻辑，别碰）；`dsh-better-sidebar` 无审批徽标；`~/.dsh/dsh-pet/` 下只有 main-config.json + memory.json | 已核实 |

## 待办（设计定案，直接写码）

**总原则：v1 走纯 client 路线**——气泡卡、标题角标、toast 的会话归属/跳转全部用 `uiSession.pendingInteractions` + `sessions.list`（client 内存现成数据，**零 host 改动、零新事件源**）。仅 toast 帧里加 sessionId 需要小动 host/shared（下面第 4 步）；若想再省，toast 的归属判断也可以不依赖帧——用 pendingInteractions 兜住。

改动文件（fork `dsh-pet/` 子包内）：

1. `src/client/app.ts`
   - inject 追加 `'uiSession'`、`'sessions'`。
   - apply 里启动新的审批提醒引擎：`startApprovalAlerts(ctx, signal)`（新文件），并把 `ctx` 传入 `startNotify`（改签名，见第 3 步）。
   - `shell.overlay` 槽已挂 `PetMulti`；气泡卡作为**独立浮层 DOM**由 alerts 模块自挂（学 dsh-my-prs 的 MutationObserver 锚定法，或最简：`position:fixed` 锚宠物角落——宠物角落从 `GET /dsh-pet-7340/config` 的 `pets[].position` 读，该端点本机免鉴权），**只挂一份**，不塞进 React 宠物卡（少碰上游代码，合并友好）。
2. 新文件 `src/client/approvals.ts`
   - 订阅 `ctx.uiSession.pendingInteractions` + `ctx.sessions.list`；派生行列表：`kind in ('approval','question') 且 sessionId !== list.current` → `{sessionId, label(标题链), text(等待审批/等你选择 · toolName/reason)}`。
   - 渲染行列表气泡，行点击 → `ctx.sessions.open(sessionId)`；样式对齐 `.dsh-pet-bubble`（白泡+尾巴+软糖体，尺寸随 `--dsh-pet-size` 缩放那套，抄 bubble.ts 的 css），`pointer-events:auto; cursor:pointer`。
   - `document.title` 角标 `[N 待审批]`：记录干净标题，N>0 加前缀、回 0 还原（shell 若改标题，变化时以新值为干净基线）。
   - 文案：先中文为主（仓库现状 zh-first），要 i18n 就挂进 settings.ts 的 NS 字典。
3. `src/client/notify.ts`
   - `startNotify(signal)` → `startNotify(ctx, signal)`。
   - 聚焦门改造：approval/question 帧若 `frame.sessionId && frame.sessionId !== ctx.sessions.list.getSnapshot().current` → **不受 isPageActive() 抑制**；其余帧保持旧语义。
   - toast body 带「「标题」」；`n.onclick` → 先 `ctx.sessions.open(sessionId)` 再 `window.focus()`。
   - app.ts 里 40 行的调用点同步改。
4. 帧携带 sessionId（让 toast 知道归属）：
   - `src/host/notify-events.ts`：`reduceNotifyFrame(event)` → `reduceNotifyFrame(event, sessionId)`，approval/asked、question(tool/call)、turn/end 帧都附 `sessionId`；`agentErrorFrame` 无会话可不加。
   - `src/host/index.ts`：notify 监听器（~1033 行）像 work-status 那样提取 sessionId 传入。
   - `src/shared/notify.ts`：`frameToToast` 的返回值类型加 `sessionId?`，approval/question 分支透传 `frame.sessionId`。
   - 同步小改两个测试：`src/host/notify-events.test.ts`（新参数/新字段）、涉及断言处。
5. 构建+质检：`npm run bundle`（生成 lib/）→ `npm test`（保持 176，别新增失败）→ `npm run typecheck && npm run lint`。
6. 提交：小碎步 commit（`feat(alerts): ...`），**不 push**。
7. 接入 profile（联调）：
   - `~/.dsh/profiles/web/package.json`：`"dsh-pet": "^0.2.7"` → `"link:<仓库根>/dsh-pet"`（**注意 link 到子目录**）。
   - profile 里 `pnpm install`（带 `npm_config_store_dir=<pnpm 全局 store>`，代理同上；装前按 AGENTS 口诀核对 `pnpm --version`=`node_modules/.modules.yaml` 的 packageManager、`pnpm store path`=storeDir）。
   - **重启 dsh web 用 `~/.dsh/profiles/web/restart-dsh-web.sh`，由用户在空闲时执行**（agent 自己跑会杀死当前会话）。重启后浏览器硬刷新。
   - 若最终只有 client 半改动（没动 host），可先只刷新页面验证气泡卡/角标，toast 改动留到重启后。
8. 端到端验证：让任意会话触发审批（现成招：`echo x > ~/.dsh/dsh-pet/.workstatus-test` 走 danger-full-access 会弹审批卡）→ 切到别的会话：气泡卡出现且带会话名 → 点击跳回 → 审批卡片就位；处理掉后一切消失；页面失焦再来一发验证 toast 带标题、点击跳转；标签页角标随 N 变化。**测完删掉 `.workstatus-test` 遗留**（profile 目录里那个测试标记文件也顺手清）。
9. 可选：README 加一节 fork 差异；整理好后可向上游提 PR（push/PR 由用户执行）。

## 环境坑（都踩过，别再踩）

- 沙箱 workspace-write：写 `~/Work/**`、`~/.dsh/**`（工作区=`~/.dsh/profiles/web`）会被拒 → 该命令**原样重试一次**并带 `sandbox_permissions`+justification（policy=ask，会弹用户审批）。
- GitHub 直连不稳（git/codeload 挂过）；代理 `http://127.0.0.1:7897` 已恢复可用（git 用 `-c http.proxy -c https.proxy` 传，环境变量对 scutil 代理无效）。Clash 节点挂了要先喊用户。
- macOS 自带 bsdtar **不支持 `--wildcards`**；临时文件用 `$DSH_TMP`。
- `git clone` 130MB 素材仓库前台 60s 必超时 → 后台跑。
- npm 装包慢直连 npmjs → 走代理；prepare 生命周期会自动构建，不用手跑 bundle 也有初版 lib/。
- 宠物角落默认 top-right/marginX24/marginY100、size 462；气泡锚定注意**别压住方案 1 的 work-status 文本气泡**（waiting 档文本气泡与审批卡二选一显示：有审批时优先审批卡）。
- DSH 版本注释里说的「0.1.5 删了 mux」指上游演进，本机是 0.1.2-alpha.4，**结论同样成立**（mux 不存在、`/notify` 轮询可用）。

## 新会话启动清单

1. `cd  <仓库根>&& git status`（应干净、main 无提交）；`ls dsh-pet/lib`（产物在）。
2. `npm test` 快速回归（预期 176/177，helper-process 那个 electron 失败为已知）。
3. 从上面「待办」第 1 步开始写码；引用 API 前信任本表格，不必重查；查契约用「已验证的关键契约」表里的文件路径直读。
4. 需要用户配合的三个节点：批准沙箱外写（会弹）、跑 restart-dsh-web.sh、GitHub push。
