// 跨会话审批/选择题提醒的数据源（client 半侧，浏览器专属）：轮询 host 的 /alerts 端点，
// 把「别的会话正挂着待审批/待选择」变成宠物头顶提醒卡的一部分（渲染在 approvals.ts 的浮层里）。
//
// 数据源为什么换过：0.1 里这条路走 ctx.uiSession.pendingInteractions（客户端 Map），
// 0.2 把这个读面移除了（只剩 registerPendingInteraction 写侧，没有跨会话读面）。
// host 的 pending-alerts 表本来就在（为桌面宠物做，见 src/host/pending-alerts.ts），
// 浮层直接轮询它：两端同一份数据，行数与文案天然一致，不再有各自推导的漂移。
//
// 与重启提醒（./restart-notice）同构：1s 顺序轮询 + 签名守卫（签名不变不回调、不重渲染）。
// 纯数据变换（derivePendingRows / pendingSignature）无 DOM 依赖，可单测。

/** host /alerts 响应里 pending 数组的一条（宽松取值，防御上游形状变化） */
export interface HostPendingItem {
  kind?: unknown;
  sessionId?: unknown;
  label?: unknown;
  text?: unknown;
  ts?: unknown;
}

/** sessions.list 快照的窄接口（只用到展示面；与 restart-notice.ts 同款，避免跨模块耦合） */
interface SessionListStateLike {
  byId?: Record<string, { displayTitle?: unknown; title?: unknown }>;
}

/** 浮层里的一条审批/选择提醒行（plan-review 归入「等你选择」一档，与浮层文案对齐） */
export interface PendingAlertRow {
  /** 渲染 key：kind + 会话 + 文案（同会话可挂多条，靠文案区分） */
  key: string;
  sessionId: string;
  /** 会话标签：客户端列表标题优先，退回 host 给出的标签，再退回会话 id 前 8 位 */
  label: string;
  /** 行文案（host 已按「等你审批 · 工具 / 等你选择 · 问题 / 等你评审计划」给出） */
  text: string;
  kind: 'approval' | 'question';
}

/**
 * 派生审批/选择题行：过滤当前会话（已经在看就别催，与浮层原语义一致）。
 * @param items - host /alerts 的 pending 数组
 * @param list - 会话列表快照（取客户端侧会话标题）
 * @param currentId - 当前会话 id（它的行不提醒）
 */
export function derivePendingRows(
  items: readonly HostPendingItem[],
  list: SessionListStateLike,
  currentId: string,
): PendingAlertRow[] {
  const byId = list.byId ?? {};
  const rows: PendingAlertRow[] = [];
  for (const item of items) {
    const sessionId = typeof item?.sessionId === 'string' ? item.sessionId : '';
    const text = typeof item?.text === 'string' ? item.text : '';
    if (!sessionId || !text) continue;
    if (sessionId === currentId) continue;
    const kind = item?.kind === 'approval' ? 'approval' : 'question';
    const summary = byId[sessionId];
    const label =
      (summary && typeof summary.displayTitle === 'string' && summary.displayTitle) ||
      (typeof item?.label === 'string' && item.label) ||
      sessionId.slice(0, 8);
    rows.push({ key: kind + ':' + sessionId + ':' + text, sessionId, label, text, kind });
  }
  return rows;
}

// ---------- HTTP：拉取 ----------

const ENDPOINT = '/dsh-pet-7340/alerts';
const TIMEOUT_MS = 10000;

/** 拉取当前待交互列表；网络/解析失败显式抛错（调用方决定降级，绝不伪造空列表当作"没有待交互"） */
export async function fetchPendingAlerts(): Promise<HostPendingItem[]> {
  const res = await fetch(ENDPOINT, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
  if (!res.ok) throw new Error('dsh-pet: pending-alerts HTTP ' + res.status);
  const raw = (await res.json().catch(() => null)) as { pending?: unknown } | null;
  const pending = raw?.pending;
  if (!Array.isArray(pending)) throw new Error('dsh-pet: pending-alerts 响应非法');
  return pending.filter((i): i is HostPendingItem => !!i && typeof i === 'object');
}

/** 待交互集合的签名（kind + 会话 + 文案 + 时刻）：只有它变了才回调，避免每秒无谓重渲染 */
export function pendingSignature(items: readonly HostPendingItem[]): string {
  return items
    .map((i) => String(i.kind) + ':' + String(i.sessionId) + ':' + String(i.text) + '@' + String(i.ts))
    .sort()
    .join('|');
}

/** 轮询句柄（与 restart-notice.ts 的 RestartNoticePoll 同构） */
export interface PendingAlertsPoll {
  /** 让下一拍无条件重新同步 */
  resync(): void;
  /** 停止轮询（signal 中止也会自动停） */
  stop(): void;
}

/** 等一拍，支持中途取消；摘掉 abort 监听（与 restart-notice.ts 的 sleep 同款） */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = (): void => finish();
    const finish = (): void => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = globalThis.setTimeout(finish, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 启动轮询（常驻，随插件 apply；signal 中止即停）。
 * @param onChange - 待交互集合变化时回调（含首次拉到数据；签名未变不回调）
 * @param signal - 中止信号
 * @param intervalMs - 轮询周期（测试可缩短；默认 1s，与 notify/work-status 同族）
 */
export function startPendingAlerts(
  onChange: (items: HostPendingItem[]) => void,
  signal: AbortSignal,
  intervalMs = 1000,
): PendingAlertsPoll {
  let last = '';
  let stopped = false;
  // 顺序循环（await 等一拍）而不是 setInterval：天然不会请求叠加
  const poll = async (): Promise<void> => {
    while (!stopped && !signal.aborted) {
      try {
        const items = await fetchPendingAlerts();
        if (stopped || signal.aborted) return;
        const sig = pendingSignature(items);
        if (sig !== last) {
          last = sig;
          onChange(items);
        }
      } catch {
        /* host 端点缺失 / 网络抖动：静默跳过本轮（提醒是增强能力，不该刷控制台） */
      }
      if (stopped || signal.aborted) return;
      await sleep(intervalMs, signal);
    }
  };
  void poll(); // 首帧：页面加载即生效
  const stop = (): void => {
    stopped = true;
  };
  signal.addEventListener('abort', stop, { once: true });
  return {
    resync: () => {
      last = '';
    },
    stop,
  };
}
