// 跨会话审批提醒引擎（client 半侧，浏览器专属）：把「别的会话正挂着待审批/待选择」变成
// 宠物头顶的独立浮层气泡卡 + 标签页标题角标。纯 client 路线（方案 A）：
//   - 数据源 = ctx.uiSession.pendingInteractions（会话 → 待交互条目；审批被处理即从 map 移除，天然消失）
//   - 会话标题/当前会话 = ctx.sessions.list（SessionListState：byId[].displayTitle / current）
//   - 行点击 → ctx.sessions.open(sessionId) 切到该会话
//   - 标题角标 [N 待审批]：N = 非当前会话的待审批数，清零还原
// 浮层是独立 DOM，运行时挂进主宠物的 .dsh-pet-root（纯 DOM 操作，不碰 React 宠物卡）：
// 与 work-status 气泡同款定位（头顶居中悬着、随 --dsh-pet-size 缩放、拖拽跟随），
// z-index 5 > 气泡 3 → 有审批时盖住 work-status/余额气泡，即「有审批优先审批卡」的二选一。
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

// ---------- 独立浮层：挂进主宠物的 .dsh-pet-root 内，与 work-status 气泡同款定位 ----------
// （left:50% 居中 + bottom 悬头顶向上长；继承 pet root 的 --dsh-pet-size 缩放与拖拽 transform，
//  z-index 5 > 气泡的 3 → 有审批时盖住 work-status/余额气泡，即「有审批优先审批卡」的二选一。）

/** 浮层样式：抄 bubble.ts 的白泡+软糖体系数，全部随 --dsh-pet-size（宠物尺寸，pet root 自带）缩放 */
const alertCss = [
  '.dsh-pet-alerts{position:absolute;left:50%;transform:translateX(-50%);' +
    'bottom:calc(100% - var(--dsh-pet-size)*0.108);' + // 与 .dsh-pet-bubble 完全同款：悬宠物头顶向上长
    'z-index:5;display:flex;flex-direction:column;gap:calc(var(--dsh-pet-size)*0.014);' +
    'min-width:calc(var(--dsh-pet-size)*0.26);max-width:calc(var(--dsh-pet-size)*0.5);pointer-events:none;' +
    'font-family:"ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","Comic Sans MS","PingFang SC","Microsoft YaHei",sans-serif}',
  // 行卡片：白泡 + 悬浮反馈；整行点击跳会话（pointer-events 从容器 none 里单独放行）
  '.dsh-pet-alert-row{pointer-events:auto;cursor:pointer;background:rgba(255,255,255,.92);color:#2b2b2b;' +
    'border-radius:calc(var(--dsh-pet-size)*0.035);padding:calc(var(--dsh-pet-size)*0.018) calc(var(--dsh-pet-size)*0.028);' +
    'box-shadow:0 calc(var(--dsh-pet-size)*0.009) calc(var(--dsh-pet-size)*0.035) rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08);' +
    'backdrop-filter:blur(6px);max-width:calc(var(--dsh-pet-size)*0.5);overflow:hidden;transition:background .15s ease}',
  '.dsh-pet-alert-row:hover{background:rgba(255,255,255,.99)}',
  '.dsh-pet-alert-row .dsh-pet-alert-label{font-size:calc(var(--dsh-pet-size)*0.034);color:rgba(43,43,43,.62);' +
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:calc(var(--dsh-pet-size)*0.006)}',
  '.dsh-pet-alert-row .dsh-pet-alert-text{font-size:calc(var(--dsh-pet-size)*0.042);line-height:1.45;' +
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-pet-alert-row .dsh-pet-alert-dot{color:#e53935;margin-right:calc(var(--dsh-pet-size)*0.012)}',
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

/** 主宠物容器选择器：PetMulti 渲染多个 .dsh-pet-root，只挂一份到第一个（主宠物） */
const PET_ROOT_SELECTOR = '.dsh-pet-root';

/** 确保浮层挂在主宠物容器内：容器未出现时兜底挂 body（下一拍重挂），已挂进容器则不动 */
function mountAlertsRoot(root: HTMLElement): void {
  const host = document.querySelector<HTMLElement>(PET_ROOT_SELECTOR);
  if (host) {
    if (root.parentElement !== host) {
      injectAlertCss(); // 首次真正挂载时才注入样式
      host.appendChild(root); // 含「兜底挂在 body」时重挂进容器
    }
    return;
  }
  if (!root.isConnected && document.body) {
    injectAlertCss();
    document.body.appendChild(root); // 宠物容器尚未渲染：临时兜底
  }
}

function createAlertsRoot(): HTMLElement {
  const root = document.createElement('div');
  root.className = 'dsh-pet-alerts';
  return root;
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

  const openSession = (sessionId: string): void => {
    if (typeof sessions.open === 'function') sessions.open(sessionId);
  };

  const render = (): void => {
    // 每次渲染都确保浮层挂进主宠物容器（宠物容器 React 重建后自动重挂）
    mountAlertsRoot(root);
    const pending = uiSession.pendingInteractions?.getSnapshot?.() as ReadonlyMap<string, PendingEntry> | undefined;
    const list = sessions.list?.getSnapshot?.() as SessionListStateLike | undefined;
    const rows = deriveAlerts(pending ?? new Map(), list ?? {});
    renderAlerts(root, rows, openSession);
    syncTitleBadge(rows.length);
  };

  render(); // 首帧（页面加载即生效：已挂着的审批立即可见）
  // 宠物容器渲染晚于插件 apply（React 异步挂载）：轮询重挂，直到确认挂进宠物容器即停
  const mountTimer = window.setInterval(() => {
    const host = document.querySelector<HTMLElement>(PET_ROOT_SELECTOR);
    if (host && root.parentElement === host) {
      window.clearInterval(mountTimer);
      return;
    }
    mountAlertsRoot(root);
  }, 1000);
  const disposePending = uiSession.pendingInteractions.subscribe(() => render());
  const disposeList = sessions.list.subscribe(() => render());
  signal.addEventListener(
    'abort',
    () => {
      disposePending?.();
      disposeList?.();
      window.clearInterval(mountTimer);
      root.remove();
    },
    { once: true },
  );
}
