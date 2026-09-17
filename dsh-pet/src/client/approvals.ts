// 跨会话审批提醒引擎（client 半侧，浏览器专属）：把「别的会话正挂着待审批/待选择」变成
// 宠物角落的独立浮层气泡卡 + 标签页标题角标。纯 client 路线（方案 A）：
//   - 数据源 = ctx.uiSession.pendingInteractions（会话 → 待交互条目；审批被处理即从 map 移除，天然消失）
//   - 会话标题/当前会话 = ctx.sessions.list（SessionListState：byId[].displayTitle / current）
//   - 行点击 → ctx.sessions.open(sessionId) 切到该会话
//   - 标题角标 [N 待审批]：N = 非当前会话的待审批数，清零还原
// 独立浮层 DOM（position:fixed 锚宠物角落，读 /dsh-pet-7340/config 的 position/size），
// 不塞进 React 宠物卡——少碰上游代码，多宠物/合并友好。
// 与 notify.ts（系统 toast）解耦：本引擎管「页内看得见」的提醒，toast 管「页外」的推送。

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

/** 一条提醒行（渲染与点击的最小单元） */
interface AlertRow {
  /** 渲染 key：交互 key 优先，退化会话+kind（同会话可能挂多个审批） */
  key: string;
  sessionId: string;
  /** 会话标题（displayTitle 已含 title → 项目名 → id 前 8 位的 fallback） */
  label: string;
  /** 「等你审批 · 工具」/「等你选择 · 问题」 */
  text: string;
}

/** 需要用户回应的交互 kind（审批 / 选择题 / 计划评审）；其余域值忽略 */
const INTERACTIVE_KINDS = new Set(['approval', 'question', 'plan-review']);

/** 派生提醒行：非当前会话的待交互条目；当前会话过滤不提醒（已经在看就别催） */
export function deriveAlerts(pending: ReadonlyMap<string, PendingEntry>, list: SessionListStateLike): AlertRow[] {
  const current = typeof list.current === 'string' ? list.current : '';
  const byId = list.byId ?? {};
  const rows: AlertRow[] = [];
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
    });
  }
  return rows;
}

// ---------- 标签页标题角标：N>0 加 [N 待审批] 前缀，清零还原 ----------

const TITLE_BADGE = /^\s*\[\d+\s*待审批\]\s*/;

/** 干净标题基线：shell 若改标题，下次同步时以新值为准（变化时自动更新基线） */
let titleBase = typeof document !== 'undefined' ? document.title.replace(TITLE_BADGE, '') : '';

function syncTitleBadge(count: number): void {
  if (typeof document === 'undefined') return;
  const current = document.title;
  if (!TITLE_BADGE.test(current)) titleBase = current; // 无角标前缀 → 当前标题即干净基线
  document.title = count > 0 ? '[' + count + ' 待审批] ' + titleBase : titleBase;
}

// ---------- 独立浮层：position:fixed 锚宠物角落（读成品配置 position/size） ----------

/** 浮层样式：抄 bubble.ts 的白泡+软糖体系数，全部随 --sz（宠物尺寸）缩放 */
const alertCss = [
  '.dsh-pet-alerts{position:fixed;z-index:41;display:flex;flex-direction:column;gap:calc(var(--sz)*0.014);' +
    'min-width:calc(var(--sz)*0.26);max-width:calc(var(--sz)*0.5);pointer-events:none;' +
    'font-family:"ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","Comic Sans MS","PingFang SC","Microsoft YaHei",sans-serif}',
  // 宠物盒高 = size*9/16；气泡悬在盒子正上方：top 角落向下长、bottom 角落向上长（避免顶出视口）
  '.dsh-pet-alerts[data-corner="top-right"],.dsh-pet-alerts[data-corner="top-left"]{top:calc(var(--my) + var(--h) + var(--sz)*0.02)}',
  '.dsh-pet-alerts[data-corner="bottom-right"],.dsh-pet-alerts[data-corner="bottom-left"]{bottom:calc(100vh - var(--my) - var(--h) - var(--sz)*0.02)}',
  '.dsh-pet-alerts[data-corner="top-right"],.dsh-pet-alerts[data-corner="bottom-right"]{right:var(--mx)}',
  '.dsh-pet-alerts[data-corner="top-left"],.dsh-pet-alerts[data-corner="bottom-left"]{left:var(--mx)}',
  // 行卡片：白泡 + 悬浮反馈；整行点击跳会话
  '.dsh-pet-alert-row{pointer-events:auto;cursor:pointer;background:rgba(255,255,255,.92);color:#2b2b2b;' +
    'border-radius:calc(var(--sz)*0.035);padding:calc(var(--sz)*0.018) calc(var(--sz)*0.028);' +
    'box-shadow:0 calc(var(--sz)*0.009) calc(var(--sz)*0.035) rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08);' +
    'backdrop-filter:blur(6px);max-width:calc(var(--sz)*0.5);overflow:hidden;transition:background .15s ease}',
  '.dsh-pet-alert-row:hover{background:rgba(255,255,255,.99)}',
  '.dsh-pet-alert-row .dsh-pet-alert-label{font-size:calc(var(--sz)*0.034);color:rgba(43,43,43,.62);' +
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:calc(var(--sz)*0.006)}',
  '.dsh-pet-alert-row .dsh-pet-alert-text{font-size:calc(var(--sz)*0.042);line-height:1.45;' +
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-pet-alert-row .dsh-pet-alert-dot{color:#e53935;margin-right:calc(var(--sz)*0.012)}',
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

function createAlertsRoot(): HTMLElement {
  injectAlertCss();
  const root = document.createElement('div');
  root.className = 'dsh-pet-alerts';
  root.dataset.corner = 'top-right'; // 默认角落；config 读到后覆盖
  document.body.appendChild(root);
  return root;
}

/** 成品配置里宠物条目的窄接口 */
interface PetEntryLike {
  size?: unknown;
  workStatusEnabled?: unknown;
  position?: { corner?: unknown; marginX?: unknown; marginY?: unknown };
}

const CORNER_SET = new Set(['top-right', 'top-left', 'bottom-right', 'bottom-left']);
/** 读不到配置时的默认锚点（与 pet.ts 默认 position 一致：top-right / 24 / 100、size 462） */
const DEFAULT_ANCHOR = { corner: 'top-right', marginX: 24, marginY: 100, size: 462 };

/** 把浮层锚到宠物角落：corner 决定左右/上下，--sz/--h/--mx/--my 驱动全部缩放与偏移 */
function applyAlertAnchor(root: HTMLElement, entry: PetEntryLike | null): void {
  const pos = entry?.position && typeof entry.position === 'object' ? entry.position : {};
  const corner = CORNER_SET.has(String(pos.corner ?? '')) ? String(pos.corner) : DEFAULT_ANCHOR.corner;
  const marginX =
    typeof pos.marginX === 'number' && Number.isFinite(pos.marginX) ? pos.marginX : DEFAULT_ANCHOR.marginX;
  const marginY =
    typeof pos.marginY === 'number' && Number.isFinite(pos.marginY) ? pos.marginY : DEFAULT_ANCHOR.marginY;
  const size = typeof entry?.size === 'number' && entry.size > 0 ? entry.size : DEFAULT_ANCHOR.size;
  root.dataset.corner = corner;
  root.style.setProperty('--mx', marginX + 'px');
  root.style.setProperty('--my', marginY + 'px');
  root.style.setProperty('--sz', size + 'px');
  root.style.setProperty('--h', size * (9 / 16) + 'px');
}

/** 成品配置容器窄接口：宠物条目在 main.pets 数组（文件宠物可能以其它 key 平铺，见兜底） */
interface ConfigContainerLike {
  main?: { pets?: unknown };
}

/**
 * 读成品配置取主宠物（main.pets 里启用 workStatusEnabled 的优先，其次 pets[0]；
 * 兼容扁平旧结构：无 main.pets 时取第一个带 position 的条目）的 position/size；
 * 失败静默回落默认锚点。
 */
async function anchorToPet(root: HTMLElement): Promise<void> {
  try {
    const r = await fetch('/dsh-pet-7340/config');
    if (!r.ok) {
      applyAlertAnchor(root, null);
      return;
    }
    const d = (await r.json().catch(() => null)) as ConfigContainerLike | null;
    if (!d || typeof d !== 'object') {
      applyAlertAnchor(root, null);
      return;
    }
    const mainPets = d.main && Array.isArray(d.main.pets) ? (d.main.pets as PetEntryLike[]) : [];
    const pet =
      mainPets.find((p) => p && p.workStatusEnabled === true) ??
      mainPets[0] ??
      (Object.values(d).find((v) => v && typeof v === 'object' && 'position' in v) as PetEntryLike | null);
    applyAlertAnchor(root, pet ?? null);
  } catch {
    applyAlertAnchor(root, null);
  }
}

/** 行列表渲染：白泡卡片，整行点击 → 切会话 */
function renderAlerts(root: HTMLElement, rows: AlertRow[], openSession: (sessionId: string) => void): void {
  root.replaceChildren();
  for (const row of rows) {
    const el = document.createElement('div');
    el.className = 'dsh-pet-alert-row';
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

// ---------- 主引擎：订阅双数据源 → 渲染浮层 + 标题角标 ----------

/**
 * 启动跨会话审批提醒引擎（常驻，随插件 apply；signal 中止即拆除浮层并退订）。
 * ctx 缺 uiSession.pendingInteractions / sessions.list 时降级跳过（不影响其它功能）。
 * 不依赖 host 任何新端点：全部数据在 client 内存现成。
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
  if (!uiSession?.pendingInteractions?.subscribe || !sessions?.list?.subscribe || typeof sessions.open !== 'function') {
    console.warn('[dsh-pet] 跨会话审批提醒不可用：uiSession.pendingInteractions / sessions.list 缺失');
    return;
  }

  const root = createAlertsRoot();
  void anchorToPet(root); // 异步锚定：config 返回前先按默认角落显示，不阻塞首帧

  const openSession = (sessionId: string): void => {
    if (typeof sessions.open === 'function') sessions.open(sessionId);
  };

  const render = (): void => {
    const pending = uiSession.pendingInteractions?.getSnapshot?.() as ReadonlyMap<string, PendingEntry> | undefined;
    const list = sessions.list?.getSnapshot?.() as SessionListStateLike | undefined;
    const rows = deriveAlerts(pending ?? new Map(), list ?? {});
    renderAlerts(root, rows, openSession);
    syncTitleBadge(rows.length);
  };

  render(); // 首帧（页面加载即生效：已挂着的审批立即可见）
  const disposePending = uiSession.pendingInteractions.subscribe(() => render());
  const disposeList = sessions.list.subscribe(() => render());
  signal.addEventListener(
    'abort',
    () => {
      disposePending?.();
      disposeList?.();
      root.remove();
    },
    { once: true },
  );
}
