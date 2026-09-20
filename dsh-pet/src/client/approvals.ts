// 跨会话提醒浮层引擎（client 半侧，浏览器专属）：把「别的会话正挂着待审批/待选择」与
// 「某个会话在等你重启 DSH」变成宠物头顶的独立浮层气泡卡 + 标签页标题角标。
// 本文件是**浮层本体**（定位/渲染/让位/角标）；数据源有两条、各自独立：
//   ① 审批/选择题（本文件的 deriveAlerts）：纯 client 路线（方案 A）——
//      - 数据源 = ctx.uiSession.pendingInteractions（会话 → 待交互条目；审批被处理即从 map 移除，天然消失）
//      - 会话标题/当前会话 = ctx.sessions.list（SessionListState：byId[].displayTitle / current）
//      - 行点击 → ctx.sessions.open(sessionId) 切到该会话
//   ② 重启提醒（./restart-notice 提供轮询与派生）：agent 调 notify_restart_required 工具 →
//      host 内存表 → 1s 轮询 → 提醒行（**不过滤当前会话**，理由见 restart-notice.ts）
// 浮层是 body 级 position:fixed 的独立 DOM（不碰 React 宠物卡），每拍读取主宠物
// .dsh-pet-root 的 rect 像素定位到宠物盒顶正上方居中（拖拽/窗口变化自动跟随）；
// 有提醒行时给 root 加 data-dsh-pet-alerts 隐藏其内部所有气泡 → 提醒卡独占头顶
// （「有提醒优先提醒卡」的二选一，杜绝多气泡重叠）。
// **行序**：重启行在前、审批行在后——浮层底边锚在宠物头顶，最后一行才贴着宠物，
// 审批卡必须留在最底，否则会破坏已像素级调好的贴位（见下方 render 的说明）。
// 标题角标 [N 待处理]：N = 全部提醒行数（非当前会话的审批 + 全部重启提醒），清零还原。
// 与 notify.ts（系统 toast）解耦：本引擎管「页内看得见」的提醒，toast 管「页外」的推送。

import {
  deriveRestartRows,
  dismissRestartNotice,
  startRestartNotices,
  type RestartAlertRow,
  type RestartNoticeItem,
  type RestartNoticePoll,
} from './restart-notice';
import { handBackCenterColumn } from './hand-back';

// ---------- 待交互条目窄接口（宽松取值，防御上游形状变化） ----------

/** uiSession.pendingInteractions 的值（DSH 域自行声明 kind，这里只描述用到的面） */
interface PendingEntry {
  key?: unknown;
  kind?: unknown;
  sessionId?: unknown;
  toolName?: unknown;
  reason?: unknown;
  questions?: unknown;
}

/** sessions.list 快照的窄接口（SessionListState 的展示面） */
interface SessionListStateLike {
  current?: unknown;
  byId?: Record<string, { displayTitle?: unknown; title?: unknown }>;
}

/** 一条审批/选择题提醒行（渲染与点击的最小单元） */
interface ApprovalAlertRow {
  /** 渲染 key：交互 key 优先，退化会话+kind（同会话可能挂多个审批） */
  key: string;
  sessionId: string;
  /** 会话标题（displayTitle 已含 title → 项目名 → id 前 8 位的 fallback） */
  label: string;
  /** 「等你审批 · 工具」/「等你选择 · 问题」 */
  text: string;
  kind: 'approval' | 'question';
}

/** 浮层里的一行（两条数据源的并集；RestartAlertRow 来自 ./restart-notice） */
type AlertRow = ApprovalAlertRow | RestartAlertRow;

/** 需要用户回应的交互 kind（审批 / 选择题 / 计划评审）；其余域值忽略 */
const INTERACTIVE_KINDS = new Set(['approval', 'question', 'plan-review']);

/** 派生审批/选择题行：非当前会话的待交互条目；当前会话过滤不提醒（已经在看就别催）。
 *  重启提醒**不走**这条过滤（见 ./restart-notice 的 deriveRestartRows）。 */
export function deriveAlerts(
  pending: ReadonlyMap<string, PendingEntry>,
  list: SessionListStateLike,
): ApprovalAlertRow[] {
  const current = typeof list.current === 'string' ? list.current : '';
  const byId = list.byId ?? {};
  const rows: ApprovalAlertRow[] = [];
  for (const [sessionId, entry] of pending) {
    const kind = typeof entry?.kind === 'string' ? entry.kind : '';
    if (!INTERACTIVE_KINDS.has(kind)) continue;
    if (sessionId === current) continue;
    const summary = byId[sessionId];
    const label =
      (summary && typeof summary.displayTitle === 'string' && summary.displayTitle) || sessionId.slice(0, 8);
    const toolName = typeof entry.toolName === 'string' ? entry.toolName : '';
    const reason = typeof entry.reason === 'string' ? entry.reason : '';
    const q =
      (Array.isArray(entry.questions) && typeof entry.questions[0]?.question === 'string'
        ? entry.questions[0].question
        : '') || '';
    const text =
      kind === 'approval' ? '等你审批' + (toolName ? ' · ' + toolName : '') : '等你选择' + (q ? ' · ' + q : '');
    void reason; // 审批理由暂不进气泡主文案（保持行紧凑）；需要时拼进 text
    rows.push({
      key: typeof entry.key === 'string' && entry.key ? entry.key : sessionId + ':' + kind,
      sessionId,
      label,
      text,
      kind: kind === 'approval' ? 'approval' : 'question', // plan-review 归入「等你选择」一档（文案已按非 approval 分支拼）
    });
  }
  return rows;
}

// ---------- 标签页标题角标：N>0 加 [N 待处理] 前缀，清零还原 ----------
// 文案取「待处理」而非「待审批」：角标数的是**全部提醒行**（非当前会话的审批 + 全部重启提醒），
// 一个数字一条规则，不必按来源分两种前缀（分两种反而要处理"混合时显示哪个"的歧义）。

const TITLE_BADGE = /^\s*\[\d+\s*待处理\]\s*/;
/** 旧版前缀（[N 待审批]）：热重载/版本切换期间可能残留在标题里，一并剥掉，避免叠加成两个角标 */
const TITLE_BADGE_LEGACY = /^\s*\[\d+\s*待审批\]\s*/;

/** 干净标题基线：shell 若改标题，下次同步时以新值为准（变化时自动更新基线） */
let titleBase =
  typeof document !== 'undefined' ? document.title.replace(TITLE_BADGE, '').replace(TITLE_BADGE_LEGACY, '') : '';

function syncTitleBadge(count: number): void {
  if (typeof document === 'undefined') return;
  const current = document.title;
  // 无角标前缀 → 当前标题即干净基线（两个前缀都算"有角标"，都要剥）
  if (!TITLE_BADGE.test(current) && !TITLE_BADGE_LEGACY.test(current)) {
    titleBase = current;
  }
  document.title = count > 0 ? '[' + count + ' 待处理] ' + titleBase : titleBase;
}

// ---------- 独立浮层：body 级 fixed + JS 像素定位到主宠物头顶 ----------
// 每拍读取主宠物 .dsh-pet-root 的 getBoundingClientRect()，把浮层放到「宠物盒顶正上方居中」
// （向上长，与 work-status 气泡同语义；拖拽/窗口变化由轮询自动跟随）。
// 有审批时给 root 加 data-dsh-pet-alerts，CSS 隐藏其内部所有 .dsh-pet-bubble
// （余额/work-status 气泡）→ 实现「有审批优先审批卡」的二选一，杜绝多气泡重叠。

/** 浮层样式：白泡+软糖体系数随 --dsh-pet-size（读自主宠物 root 的 CSS 变量）缩放 */
const alertCss = [
  '.dsh-pet-alerts{position:fixed;z-index:10001;display:flex;flex-direction:column;gap:calc(var(--dsh-pet-size)*0.014);' +
    'min-width:calc(var(--dsh-pet-size)*0.26);max-width:calc(var(--dsh-pet-size)*0.7);pointer-events:none;' +
    'font-family:"ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","Comic Sans MS","PingFang SC","Microsoft YaHei",sans-serif}',
  '.dsh-pet-alerts[hidden]{display:none}',
  // 有提醒时藏掉宠物自身的全部气泡（余额/碎碎念/work-status），提醒卡独占头顶
  '.dsh-pet-root[data-dsh-pet-alerts] .dsh-pet-bubble{display:none!important}',
  // 底部小尾巴指向下方宠物（与 bubble.ts 同款三角）
  '.dsh-pet-alerts::after{content:"";position:absolute;left:50%;bottom:calc(var(--dsh-pet-size)*-0.017);' +
    'transform:translateX(-50%);border:calc(var(--dsh-pet-size)*0.017) solid transparent;' +
    'border-top-color:rgba(255,255,255,.92);border-bottom:none}',
  // 行卡片：白泡 + 悬浮反馈；整行点击跳会话（pointer-events 从容器 none 里单独放行）
  '.dsh-pet-alert-row{pointer-events:auto;cursor:pointer;background:rgba(255,255,255,.92);color:#2b2b2b;' +
    'border-radius:calc(var(--dsh-pet-size)*0.035);padding:calc(var(--dsh-pet-size)*0.018) calc(var(--dsh-pet-size)*0.028);' +
    'box-shadow:0 calc(var(--dsh-pet-size)*0.009) calc(var(--dsh-pet-size)*0.035) rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08);' +
    'backdrop-filter:blur(6px);max-width:calc(var(--dsh-pet-size)*0.7);overflow:hidden;transition:background .15s ease}',
  '.dsh-pet-alert-row:hover{background:rgba(255,255,255,.99)}',
  // 会话标题/审批内容允许换行（碎碎念变体同款）：截断看不清，宁可多占一行也要读全
  '.dsh-pet-alert-row .dsh-pet-alert-label{font-size:calc(var(--dsh-pet-size)*0.036);color:rgba(43,43,43,.62);' +
    'white-space:normal;overflow-wrap:anywhere;margin-bottom:calc(var(--dsh-pet-size)*0.006)}',
  '.dsh-pet-alert-row .dsh-pet-alert-text{font-size:calc(var(--dsh-pet-size)*0.0455);line-height:1.5;' +
    'white-space:normal;overflow-wrap:anywhere}',
  '.dsh-pet-alert-row .dsh-pet-alert-dot{color:#e53935;margin-right:calc(var(--dsh-pet-size)*0.012)}',
  // 重启提醒变体：点色改蓝（审批红=有人在等你放行、更急；重启蓝=别忘，不阻塞任何事），
  // 右侧留出 × 的位置，行内需要 relative 让 × 绝对定位
  '.dsh-pet-alert-row[data-kind="restart"]{position:relative;padding-right:calc(var(--dsh-pet-size)*0.055)}',
  '.dsh-pet-alert-row[data-kind="restart"] .dsh-pet-alert-dot{color:#1e88e5}',
  // × 手动消除：只对重启提醒出现（审批有自己的处理面板，点卡片跳过去就行）
  '.dsh-pet-alert-row .dsh-pet-alert-close{position:absolute;top:calc(var(--dsh-pet-size)*0.004);' +
    'right:calc(var(--dsh-pet-size)*0.012);width:calc(var(--dsh-pet-size)*0.042);height:calc(var(--dsh-pet-size)*0.042);' +
    'line-height:calc(var(--dsh-pet-size)*0.042);text-align:center;border-radius:50%;' +
    'font-size:calc(var(--dsh-pet-size)*0.038);color:rgba(43,43,43,.38);cursor:pointer}',
  '.dsh-pet-alert-row .dsh-pet-alert-close:hover{background:rgba(0,0,0,.07);color:rgba(43,43,43,.75)}',
].join('\n');

/** 只注入一次 */
function injectAlertCss(): void {
  if (document.querySelector('style[data-plugin-css="dsh-pet/alerts"]') !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = 'dsh-pet/alerts';
  tag.textContent = alertCss;
  document.head.appendChild(tag);
}

/** 主宠物容器选择器：PetMulti 渲染多个 .dsh-pet-root，只跟第一个（主宠物） */
const PET_ROOT_SELECTOR = '.dsh-pet-root';

function createAlertsRoot(): HTMLElement {
  injectAlertCss();
  const root = document.createElement('div');
  root.className = 'dsh-pet-alerts';
  root.hidden = true; // 无审批行时隐藏，不挡交互
  document.body.appendChild(root);
  return root;
}

/** 读取主宠物 root（用于取 CSS 变量与 rect）；不存在返回 null */
function petRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(PET_ROOT_SELECTOR);
}

/** 把浮层像素定位到与宠物碎碎念/余额气泡同高（用户多轮实测后拍板「跟碎碎念的高度
 *  一样」）：复刻 .dsh-pet-bubble 的 bottom:calc(100% - size*0.108) 锚点——底边
 *  探入盒顶 10.8% 尺寸（root 高 = 9/16 size，故 = 0.192*root 高）。左右两侧 clamp
 *  8px 防贴边裁切；顶部空间不足时 clamp 8 兜底。宠物未渲染则轮询重试。 */
function placeAlerts(overlay: HTMLElement): void {
  const host = petRoot();
  if (!host) return;
  const r = host.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  const size = parseFloat(getComputedStyle(host).getPropertyValue('--dsh-pet-size')) || r.width;
  if (size > 0) overlay.style.setProperty('--dsh-pet-size', size + 'px');
  const w = overlay.offsetWidth || Math.max(120, r.width * 0.26);
  const h = overlay.offsetHeight;
  const centered = r.left + r.width / 2 - w / 2;
  const leftMax = Math.max(8, window.innerWidth - w - 8);
  overlay.style.left = Math.round(Math.min(leftMax, Math.max(8, centered))) + 'px';
  // 目标底边 = 原生气泡的实测 rect.bottom（.dsh-pet-bubble 未点亮只是 opacity:0，
  // 布局与位置仍在，可测）——对齐真实节点比复算 0.192*root 公式可靠（用户对比图实测
  // 纸面公式与原生气泡仍有肉眼可见高差）。原生气泡不可测时回退公式值。
  const native = host.querySelector<HTMLElement>('.dsh-pet-bubble');
  const nb = native?.getBoundingClientRect();
  const bottom = nb && nb.height > 0 && nb.bottom > 0 ? nb.bottom : r.top + r.height * 0.192;
  overlay.style.top = Math.max(8, Math.round(bottom - h)) + 'px';
}

/** 有审批时藏掉主宠物内部所有气泡（二选一）；无则还原 */
function setPetBubblesHidden(hidden: boolean): void {
  const host = petRoot();
  if (!host) return;
  if (hidden) host.setAttribute('data-dsh-pet-alerts', '');
  else host.removeAttribute('data-dsh-pet-alerts');
}

/** 行列表渲染：白泡卡片，整行点击 → 切会话；重启提醒行多一个 ×（消除，不跳转） */
function renderAlerts(
  root: HTMLElement,
  rows: AlertRow[],
  openSession: (sessionId: string) => void,
  dismissRestart: (sessionId: string) => void,
): void {
  root.replaceChildren();
  for (const row of rows) {
    const el = document.createElement('div');
    el.className = 'dsh-pet-alert-row';
    el.dataset.kind = row.kind; // CSS 据此切点色 / 留 × 位置（见 alertCss）
    el.title = '切到会话：' + row.label;
    const label = document.createElement('div');
    label.className = 'dsh-pet-alert-label';
    label.textContent = '「' + row.label + '」';
    const text = document.createElement('div');
    text.className = 'dsh-pet-alert-text';
    const dot = document.createElement('span');
    dot.className = 'dsh-pet-alert-dot';
    dot.textContent = '●';
    text.appendChild(dot);
    text.appendChild(document.createTextNode(row.text));
    el.appendChild(label);
    el.appendChild(text);
    if (row.kind === 'restart') {
      const close = document.createElement('span');
      close.className = 'dsh-pet-alert-close';
      close.textContent = '×';
      close.title = '消掉这条重启提醒（不影响那个会话）';
      // 必须 stopPropagation：整行是"跳会话"的点击区，× 是"消除"——不能两个都触发
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        dismissRestart(row.sessionId);
      });
      el.appendChild(close);
    }
    el.addEventListener('click', () => {
      try {
        openSession(row.sessionId);
      } catch {
        /* 会话可能已关闭/不存在：忽略点击 */
      }
    });
    root.appendChild(el);
  }
}

// ---------- 主引擎：两路数据源 → 渲染浮层 + 标题角标 ----------

/**
 * 启动跨会话提醒引擎（常驻，随插件 apply；signal 中止即拆除浮层并退订）。
 * 两路数据源相互独立、各自降级：
 *   - 审批/选择题：ctx 缺 uiSession.pendingInteractions / sessions.list 时只关这一路（告警一次）；
 *   - 重启提醒：只依赖 host 的 /restart-notice 端点，端点在就工作（不依赖 ctx 任何服务）。
 * 两路都不可用时才退化为"永远没有提醒行"（浮层保持隐藏，不影响宠物其余功能）。
 */
export function startApprovalAlerts(ctx: unknown, signal: AbortSignal): void {
  const uiSession = (ctx as { uiSession?: unknown } | null)?.uiSession as
    | { pendingInteractions?: { getSnapshot?: () => unknown; subscribe?: (l: () => void) => (() => void) | void } }
    | undefined;
  const sessions = (ctx as { sessions?: unknown } | null)?.sessions as
    | {
        list?: { getSnapshot?: () => unknown; subscribe?: (l: () => void) => (() => void) | void };
        open?: (sessionId: string) => void;
      }
    | undefined;
  const pendingSource = uiSession?.pendingInteractions;
  const listSource = sessions?.list;
  // 审批路可用性：两个订阅源都在才算（缺任一个该路整体关掉，但重启提醒照常）
  const approvalsAvailable = Boolean(pendingSource?.subscribe && listSource?.subscribe);
  if (!approvalsAvailable) {
    console.warn(
      '[dsh-pet] 跨会话审批提醒不可用：uiSession.pendingInteractions / sessions.list 缺失（重启提醒不受影响）',
    );
  }

  const root = createAlertsRoot();

  const openSession = (sessionId: string): void => {
    if (typeof sessions?.open === 'function') {
      sessions.open(sessionId);
      // 插件页（Team 看板/我的 PR/SSH/技能中心）要么盖住宠物卡、要么把对话区藏起来，
      // 切换后必须让它们让位，用户才能看到切过去的会话（详见 hand-back.ts）。
      handBackCenterColumn();
    }
  };

  /** 重启提醒当前快照（由轮询回调更新） */
  let restartItems: RestartNoticeItem[] = [];

  // 下面 render / dismissRestart 用**函数声明**（而非 const 箭头）：两者互相引用、
  // 且 dismissRestart 还要用后面才创建的 restartPoll——函数声明会提升，调用时才解析引用，
  // 不必为了避开「先声明后使用」把逻辑拆成两半。
  /** 点 × 消掉一条重启提醒：先乐观移除（点完立刻消失，不等下一拍），再 POST */
  function dismissRestart(sessionId: string): void {
    restartItems = restartItems.filter((i) => i.sessionId !== sessionId);
    render();
    void dismissRestartNotice(sessionId)
      .catch(() => {
        /* 网络/端点失败：不额外处理，交给下面的 resync */
      })
      // 无论成败都让下一拍无条件重同步：**成功**时把乐观移除与 host 对齐；
      // **失败**时 host 仍留着那条提醒，而签名（sessionId@ts）没变 → 不 resync 就再也回不来（静默丢提醒）
      .finally(() => restartPoll.resync());
  }

  function render(): void {
    const pending = approvalsAvailable
      ? (pendingSource?.getSnapshot?.() as ReadonlyMap<string, PendingEntry> | undefined)
      : undefined;
    const list = approvalsAvailable ? (listSource?.getSnapshot?.() as SessionListStateLike | undefined) : undefined;
    const shared = list ?? {};
    // **行序**：重启行在前、审批行在后。浮层是「底边锚在宠物头顶」的弹性列（见 placeAlerts），
    // 只有最后一行贴着宠物——审批卡必须留在最底，否则会破坏已像素级调好的贴位。
    const rows: AlertRow[] = [
      ...deriveRestartRows(restartItems, shared),
      ...deriveAlerts(pending ?? new Map(), shared),
    ];
    renderAlerts(root, rows, openSession, dismissRestart);
    syncTitleBadge(rows.length);
    // 有提醒行 → 显示浮层并贴到宠物头顶，藏掉宠物自身气泡（二选一）；无 → 隐藏还原
    root.hidden = rows.length === 0;
    setPetBubblesHidden(rows.length > 0);
    if (rows.length > 0) placeAlerts(root);
  }

  render(); // 首帧（页面加载即生效：已挂着的审批立即可见；重启提醒由下面轮询首拍补上）
  // 重启提醒轮询（1s，签名变化才回调重渲染）——host 端点缺失时静默空转，不影响审批路
  const restartPoll: RestartNoticePoll = startRestartNotices((items) => {
    restartItems = items;
    render();
  }, signal);
  // 跟随宠物移动/窗口变化：每拍重算浮层像素位置（宠物 root 出现前的空转无害）。
  // 同拍双向同步 data-dsh-pet-alerts：防订阅通知缺位导致隐藏属性卡死（气泡全哑的兜底）
  const posTimer = window.setInterval(() => {
    setPetBubblesHidden(!root.hidden);
    if (!root.hidden) placeAlerts(root);
  }, 500);
  const disposePending = pendingSource?.subscribe?.(() => render());
  const disposeList = listSource?.subscribe?.(() => render());
  signal.addEventListener(
    'abort',
    () => {
      disposePending?.();
      disposeList?.();
      restartPoll?.stop();
      window.clearInterval(posTimer);
      setPetBubblesHidden(false);
      root.remove();
    },
    { once: true },
  );
}
