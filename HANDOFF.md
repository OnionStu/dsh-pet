# dsh-pet fork —— 跨会话审批提醒（方案 A）**已交付**

> 开工交接写于 2026-09-17；**交付验收于 2026-09-18**（用户逐项实测确认）。本文现为完成记录 + 维护指南：功能清单、全部问题修复史、验证过的 API 契约、已知限制。下一个会话按「后续维护」直接接手，不需要重新考古。

## 目标（用户拍板：方案 A，不做 B / fork 外打补丁）—— ✅ 全部落地

DSH 的「等待审批」卡片只在发起会话内显示（core 把 ApprovalPanel 注册在 `conversation.composer` 插槽），切不到会话就永远发现不了。dsh-pet fork 补上跨会话通知：

1. **宠物气泡卡带会话名、可点击跳转** ✅：任何**非当前**会话挂待审批（含等待选择题）时，主宠物头顶显示「「会话标题」 ● 等你审批 · 工具名 / ● 等你选择 · 问题」，点卡 = `ctx.sessions.open` 跳回该会话；当前会话过滤不提醒。
2. **系统 toast 带会话名 + 聚焦也弹（外来会话）** ✅代码就绪（toast 链路 host 帧已带 sessionId、聚焦门按会话归属放行）；⏳「聚焦弹出」一项尚未被用户肉眼确认，留待自然使用中验证。
3. **标签页标题角标 `[N 待审批]`** ✅：N=外来会话待审批数，清零还原；shell 改标题时以新值为干净基线。实测确认出现。

## 交付的功能（实现形态）

- **新文件 `dsh-pet/src/client/approvals.ts`**（核心引擎，~270 行）：
  - 纯 client 数据源：订阅 `ctx.uiSession.pendingInteractions`（HostObservable，条目处理即移除）+ `ctx.sessions.list`（current/byId.displayTitle 出会话标题）；`INTERACTIVE_KINDS = approval|question|plan-review`；过滤 `sessionId !== list.current`。
  - 气泡卡：**body 级 fixed 浮层 + JS 像素定位**。每拍 `placeAlerts`：读主宠物 `.dsh-pet-root` 的 rect + 拷贝 `--dsh-pet-size` 到浮层（见坑 ②），**底边对齐原生 `.dsh-pet-bubble` 节点的实测 rect.bottom**（不是纸面公式），水平以宠物中线居中、左右各 clamp 8px。500ms 轮询跟随宠物拖动。样式复刻原生气泡（白底圆角/下尾巴/软糖体字号随 size 缩放），内容 `white-space:normal;overflow-wrap:anywhere` 换行完整，max-width 0.7×size。整卡 `pointer-events:auto`，行点击跳转。
  - 标题角标：`TITLE_BADGE = /^\s*\[\d+\s*待审批\]\s*/` 幂等替换/剥离。
  - 审批优先级：挂起期间宠物自身气泡全部让位（`data-dsh-pet-alerts` 属性 + `display:none!important`；**500ms 轮询双向同步该属性**，防订阅通知缺位导致卡死残留）。
- **toast 会话归属（host+shared+client 三处小改，commit `8f0535b` 起）**：`/notify` 帧携带 `sessionId`（host `notify-events.ts` reduce 传入，`src/host/index.ts` 监听器像 work-status 那样提取 `session?.header?.id ?? session?.id`）；`shared/notify.ts` `frameToToast` 透传；`client/notify.ts` 聚焦门改造——approval/question 帧属外来会话时**不受 `isPageActive()` 抑制**，toast 文案带「「标题」」，点击先 `sessions.open` 再 `window.focus()`。
- **`src/client/app.ts`**：inject 追加 `'uiSession','sessions'`；启动 `startApprovalAlerts`；`startNotify(ctx, signal)` 改签名。
- **方案 1 前作保留**：`~/.dsh/dsh-pet/main-config.json` main 宠物 `workStatusEnabled: true`（其它会话挂审批时宠物播 waiting 动画，host 现读磁盘改完刷新即可）。
- **顺带修复的上游互斥缺陷**：`src/client/pet.ts` 渲染层气泡互斥（余额 > 碎碎念/对话 > work-status 常驻，临时显式气泡优先点亮、10s 收起后 work 自动恢复）。

## 问题修复史（全部记录，按时间序）

| commit | 症状（用户实测） | 根因 | 修法 |
| --- | --- | --- | --- |
| `daf26fc`→`93a5061` | 「歪了」：卡不在宠物头顶 | 挂进 pet root 被 `isConnected` early-return 卡死（b849c93）、固定角落读不到成品配置嵌套结构（宠物在 `main.pets[]`） | 最终回到 body fixed + JS rect 定位，确定性跟随（`e477e74`/`e658e9f`/`e5f1e36` 为中间路线，已被终态取代） |
| `69182ad` | 「没有尾巴、没有圆角、内容越界」 | **CSS 自定义属性作用域**：`--dsh-pet-size` 定义在 `.dsh-pet-root` 上，body 级浮层读不到 → 所有 `calc()` 静默失效 | `placeAlerts` 里 `getComputedStyle(host).getPropertyValue` 拷贝 `setProperty` 到浮层，每拍同步 |
| `9e41966` | 长工具名截断「看不清」 | 0.5×size 上限 + nowrap/ellipsis | 加宽 0.7×size；文本 `white-space:normal;overflow-wrap:anywhere`；字号 0.0455×size |
| `4771099`→`0be0817` | **回归**：/balance、碎碎念气泡永远不弹 | `:has(~ .is-on)` 「最后一个赢」优先级倒置——work-status waiting 档**常驻点亮**且 DOM 排最后 → 永远压死后点亮的余额/碎碎念 | 互斥从 CSS 迁到 React 状态层（`pet.ts` 渲染表达式），`bubble.ts` 删 `:has` 规则 |
| `e60e3d2` | 防御性 | `data-dsh-pet-alerts` 若因订阅通知时机缺位未清 → 宠物气泡永久全哑 | 500ms 定位轮询每拍按浮层显隐**双向同步**该属性 |
| `277b523` | 宠物拖到屏幕右侧时卡片被裁一半 | `left` 只 clamp 了左边 | 补 `window.innerWidth - w - 8` 右侧 clamp |
| `a77ec24`→…→`a2e56da`→`18a50d1` | 位置六轮拉锯：「偏下压脸」↔「偏高离头远」（含 `da34f4b`+revert `f333e2c`、`bd6f3eb` 5%、`a2e56da` 对齐 10.8% 公式） | 纸面复刻锚点公式与真实渲染始终有肉眼高差 | **终态：直接测量原生 `.dsh-pet-bubble` 节点 rect.bottom 对齐**（原生气泡未点亮仅 opacity:0、布局可测）——用户确认「这次齐了 ✅」。教训见坑 ⑤ |

**排查记录（非 bug，两个"假故障"）**：
- 「/balance 敲了没反应」「碎碎念点了没弹」曾同时发生：真凶是**另一会话一个挂起问题一直没被回答**，审批优先规则正确地把宠物全部气泡隐藏了（设计如此）。教训见坑 ⑥。
- 碎碎念点击后 host 要 **~6 秒** LLM 现生成一句才弹——用户点完立刻移开视线会误判失败。
- `/balance` 命令通道曾疑注册失败，实为上述挂起审批压制：host `balanceTriggerCount` 计数 + 浏览器 1s 轮询 + 气泡显示链路逐段验证全通。

## 验收结果

- 气泡卡：出现/隐藏、圆角、尾巴、换行完整不截断、位置对齐碎碎念、**点卡跳回会话** —— 用户多轮截图实测 ✅
- 标签页角标 `[1 待审批]` —— 用户确认 ✅
- 审批挂起时宠物气泡让位、清空后恢复（含 work 气泡回来） —— 实测 ✅
- 余额气泡（「当前服务商暂不支持余额查询」说明卡） —— 实测 ✅（真数字需 provider=`deepseek-official` + `DEEPSEEK_API_KEY`，当前 moark 走不支持说明，属设计内）
- **聚焦 toast —— 尚未肉眼确认**（代码路径就绪；若一直不弹先查 macOS 系统通知权限里浏览器/DSH 是否允许）

## 提交状态

- 本地 main：`8f0535b`（notify 帧带 sessionId）→ … → `18a50d1`（底边对齐终态），共 20 个 commit，工作区干净。
- 测试基线：`npm test` **178/179**（唯一失败 `helper-process.test.ts` Electron 路径解析，克隆前既有、与本特性无关）。
- 联调接入：profile `~/.dsh/profiles/web/package.json` 已 `"dsh-pet": "link:<仓库根>/dsh-pet"`；宿主半改动已在 2026-09-17 用户重启后生效；此后全部为 client 半改动（硬刷新即验）。
- **`git push` 由用户执行**（硬规矩，agent 不推不建 PR）。

## 已知限制与后续可做

1. 聚焦 toast 待用户自然使用中确认（见上）。
2. 宠物贴视口**顶边**时卡片被 clamp 8 兜底、会部分贴头——把宠物往下拖即可；如需更好表现可做「空间不足自动翻到宠物下方」策略。
3. 文案 zh-first 硬编码在 approvals.ts，未进 settings.ts 的 NS i18n 字典（可选）。
4. 上游 PR（可选，步骤 9）：README 加 fork 差异一节 + 整理提交；`git push`/PR 均用户执行。互斥修复（`0be0817`）值得单独反哺上游。
5. 多宠物时审批卡锚定 `PET_ROOT_SELECTOR` 主宠物（设计内）；第二只 Live2D 宠物（`@linxin666/dsh-pet`）无关别碰。

## 已验证的关键契约（维护时照抄，别再全局 grep）

DSH dist 根：`<全局 node_modules>/@deepseek-ai/dsh/node_modules/@deepseek-ai/`（下称 `$D`）。

| 事项 | 结论 | 出处 |
| --- | --- | --- |
| 全局待审批数据源 | `ctx.uiSession.pendingInteractions: HostObservable<ReadonlyMap<SessionId, SessionPendingInteraction>>`，条目 `kind:'approval'|'question'、sessionId、toolName、reason、key`，处理即移除并通知订阅 | `$D/dsh-client-ui-session/lib/types/client/index.d.ts`；实测：UI 随回答自动消失 |
| 会话列表/跳转 | `ctx.sessions.list`（`current`/`byId[].displayTitle`）、`ctx.sessions.open(id)` | `$D/dsh-api-session-controller/.../sessions.d.ts`；跳转已实测可用 |
| 插件 slash 命令 | host `ctx.commands.register`（`@deepseek-ai/dsh-commands`）全局生效；handler 执行会写会话日志 `command/run`/`command/done`——**排查"命令没反应"先查日志有没有 run 事件** | `$D/dsh-commands/lib/types/index.d.ts`；/balance 实测通 |
| `/config` 返回形态 | 成品聚合 `{main:{…pets:[…],animations:{idle,turn,drag,clicks,moves,categories,events}}}`；动画池在 **main.animations**（非 pets[i].animations，条目级由 client `flattenConfigPets` 吹入）；`/config` 本机免鉴权 | fork host + curl 实测 |
| 余额触发链路 | 命令 → `balanceTriggerCount+1` → 浏览器 1s 轮询 `GET /dsh-pet-7340/balance/trigger` → 计数变化才刷余额并弹泡（`pet.ts` ~1542 起；首次仅记基线防重放） | fork 源码 + curl 实测 |
| 原生气泡锚点 | `.dsh-pet-bubble{position:absolute;bottom:calc(100% - size*0.108)}` 挂 `.dsh-pet-stage`（高=9/16 size）；**未点亮只是 opacity:0，rect 可测** | `src/client/bubble.ts` 22-28 行 |

## 环境坑（都踩过，别再踩）

- ① 沙箱 workspace-write：写 `~/.dsh/**` 被拒 → 原样重试一次带 `sandbox_permissions`+justification（弹用户审批）。`git add` 注意 cwd 在 `dsh-pet/` 子包时用包内相对路径。
- ② **CSS 自定义属性作用域**：body 级浮层读不到宠物 root 上的 `--dsh-pet-size`，calc 全灭且无报错——跨子树复刻样式必须显式拷贝变量。
- ③ **`:has()` 选择器做优先级是陷阱**：常驻点亮 + DOM 靠后的元素会把"最后一个赢"规则变成永久压制。时间性优先级只能在状态层做。
- ④ 宿主重启规则（AGENTS.md）：agent 绝不重启 3080 宿主；重启日志只有「stopping」没「started」时仍要探活确认真实状态（实测端口有响应、改动已生效）。
- ⑤ 像素级视觉对齐**别信纸面公式**：直接 `getBoundingClientRect` 测参照物节点对齐实测值，一轮收敛（六轮公式拉锯的教训）。
- ⑥ 排查"气泡全哑"先看是否有**长期被遗忘的挂起审批/问题**（审批优先隐藏是设计）；视觉桥（modlens/describe_image）超时时可 pip venv + Pillow 本地像素分析。
- ⑦ 质量门：`npm run typecheck && npm run lint && npx prettier --check && npm test（178/179 基线）&& npm run bundle`（tsdown → gitignored `lib/`，浏览器硬刷新吃 client 半改动）。

## 后续维护启动清单

1. `cd  <仓库根>&& git log --oneline 8f0535b~1..HEAD`（交付链完整、工作区干净）。
2. `npm test` 预期 178/179（helper-process electron 已知失败）。
3. 视觉问题：让用户贴截图 + 说方向；对齐类改动一律用「测原生气泡 rect」策略，系数改动见 approvals.ts `placeAlerts`。
4. 需要用户配合的节点：批准沙箱外写、跑 `~/.dsh/profiles/web/restart-dsh-web.sh`（仅动 host 半时）、`git push`。
