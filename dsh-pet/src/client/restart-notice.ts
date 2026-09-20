// 「需要重启宿主」提醒（client 半侧，浏览器专属）：轮询 host 的 /restart-notice 端点，
// 把「某个会话在等你重启 DSH」变成宠物头顶的提醒卡（渲染在 approvals.ts 的浮层里）。
//
// 为什么是轮询而不是事件：agent 调 notify_restart_required 工具 → host 写内存表，
// 浏览器侧没有对应的推送通道（DSH 0.1.5 已删除 api.events.mux/host）——与 notify/work-status
// 同族，1s 轻量轮询、签名比对只在变化时才回调（不变化不重渲染，不刷 DOM）。
//
// 与审批提醒（approvals.ts）的关系：**共用同一套浮层与角标**，本模块只负责
// 「取数据 + 派生出提醒行」；浮层定位/渲染/让位规则全部留在 approvals.ts（那里是像素级
// 调校过的，一行不动）。行序上重启行排在审批行**之前**：浮层是「底边锚在宠物头顶」的
// 弹性列，审批卡必须保持在最底（= 贴着宠物头顶的原始位置），否则会破坏已调好的贴位。
//
// 纯函数（deriveRestartRows）无 DOM 依赖，可单独测。

/** host /restart-notice 返回的一条提醒（与 host/restart-notice.ts 的 RestartNotice 同构） */
export interface RestartNoticeItem {
  sessionId: string;
  reason: string;
  ts: number;
}

/** sessions.list 快照的窄接口（只用到展示面；与 approvals.ts 同款，避免跨模块耦合） */
interface SessionListStateLike {
  current?: unknown;
  byId?: Record<string, { displayTitle?: unknown; title?: unknown }>;
}

/** 一条重启提醒行（渲染的最小单元；kind 让浮层区分点色与关闭按钮） */
export interface RestartAlertRow {
  /** 渲染 key：会话 id（同一会话只会有一条重启提醒——host 侧同会话覆盖） */
  key: string;
  sessionId: string;
  /** 会话标题（displayTitle 已含 title → id 前 8 位的 fallback） */
  label: string;
  /** 「需要重启 DSH · 理由」 */
  text: string;
  kind: 'restart';
}

/** 理由在卡片上的显示上限：超出截断（卡片是提醒，不是日志；完整理由在会话里） */
export const REASON_MAX = 60;

/** 理由截断（纯函数，便于测试） */
export function truncateReason(reason: string): string {
  const one = reason.replace(/\s+/g, ' ').trim();
  return one.length > REASON_MAX ? one.slice(0, REASON_MAX) + '…' : one;
}

/**
 * 派生重启提醒行。
 * **不过滤当前会话**（与审批提醒相反）：审批面板本来就显示在发起会话里、点一下就处理完；
 * 而重启提醒的价值恰恰是「别忘」——你切走再切回来，它必须还在。
 * @param items - host 返回的提醒列表
 * @param list - 会话列表快照（取会话标题；缺失时退化为会话 id 前 8 位）
 */
export function deriveRestartRows(items: readonly RestartNoticeItem[], list: SessionListStateLike): RestartAlertRow[] {
  const byId = list.byId ?? {};
  const rows: RestartAlertRow[] = [];
  for (const item of items) {
    const sessionId = typeof item?.sessionId === 'string' ? item.sessionId : '';
    if (!sessionId) continue;
    const summary = byId[sessionId];
    const label =
      (summary && typeof summary.displayTitle === 'string' && summary.displayTitle) || sessionId.slice(0, 8);
    const reason = typeof item.reason === 'string' ? truncateReason(item.reason) : '';
    rows.push({
      key: sessionId,
      sessionId,
      label,
      text: '需要重启 DSH' + (reason ? ' · ' + reason : ''),
      kind: 'restart',
    });
  }
  return rows;
}

// ---------- HTTP：拉取 / 手动消除 ----------

const ENDPOINT = '/dsh-pet-7340/restart-notice';
const TIMEOUT_MS = 10000;

/** 拉取当前提醒列表；网络/解析失败显式抛错（调用方决定降级，绝不伪造空列表当作"没有提醒"） */
export async function fetchRestartNotices(): Promise<RestartNoticeItem[]> {
  const res = await fetch(ENDPOINT, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
  if (!res.ok) throw new Error('dsh-pet: restart-notice HTTP ' + res.status);
  const raw = (await res.json().catch(() => null)) as { items?: unknown } | null;
  const items = raw?.items;
  if (!Array.isArray(items)) throw new Error('dsh-pet: restart-notice 响应非法');
  return items.filter(
    (i): i is RestartNoticeItem =>
      !!i && typeof i === 'object' && typeof (i as RestartNoticeItem).sessionId === 'string',
  );
}

/** 手动消除一条提醒（卡片 × 按钮）；返回 host 是否真的删掉了一条 */
export async function dismissRestartNotice(sessionId: string): Promise<boolean> {
  const res = await fetch(ENDPOINT + '/dismiss', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('dsh-pet: restart-notice/dismiss HTTP ' + res.status);
  const raw = (await res.json().catch(() => null)) as { removed?: unknown } | null;
  return raw?.removed === true;
}

// ---------- 轮询：1s，签名变化才回调 ----------

/** 提醒集合的签名（会话 + 时刻）：只有它变了才回调，避免每秒无谓重渲染 */
export function noticesSignature(items: readonly RestartNoticeItem[]): string {
  return items
    .map((i) => i.sessionId + '@' + String(i.ts))
    .sort()
    .join('|');
}

/** 轮询句柄 */
export interface RestartNoticePoll {
  /** 让下一拍无条件重新同步（乐观移除 + POST 失败后调用，把 host 的真实状态拉回来） */
  resync(): void;
  /** 停止轮询（signal 中止也会自动停） */
  stop(): void;
}

/** 等一拍，支持中途取消（顺序循环靠它保证不请求叠加）。
 *  用 `globalThis.setTimeout` 而非 `window.setTimeout`：浏览器里等价，同时让本模块在
 *  node 单测里无需伪造 `window` 就能跑（轮询的签名守卫 + resync 语义值得单独钉住）。
 *  与 notify.ts 的同名函数还有一处刻意不同：**每次等待结束都摘掉 abort 监听**——
 *  notify 那版每拍 `addEventListener` 且只在 abort 时才移除，长跑会在同一个 signal 上
 *  堆上千个监听器（浏览器不报错，但是实打实的泄漏）。这里 removeEventListener 收尾。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // 两个 const 互相引用（finish 用 timer、onAbort 用 finish）：都在函数体内、且只在
    // 定时器/abort 真正触发时解析引用，那时二者早已初始化——没有 TDZ 风险。
    const onAbort = (): void => finish();
    const finish = (): void => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    // 不写 number：本包同时带 @types/node，`globalThis.setTimeout` 会被解析成 Node 的重载
    // （返回 Timeout 对象）→ 写死 number 过不了 tsc。浏览器里它就是 number。
    const timer = globalThis.setTimeout(finish, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 启动轮询（常驻，随插件 apply；signal 中止即停）。
 * @param onChange - 提醒集合变化时回调（含首次拉到数据；签名未变不回调）
 * @param signal - 中止信号
 * @param intervalMs - 轮询周期（测试可缩短；默认 1s，与 notify/work-status 同族）
 */
export function startRestartNotices(
  onChange: (items: RestartNoticeItem[]) => void,
  signal: AbortSignal,
  intervalMs = 1000,
): RestartNoticePoll {
  let last = '';
  let stopped = false;
  // 顺序循环（await 等一拍）而不是 setInterval：**天然不会请求叠加**——host 慢/卡时
  // setInterval 会让每拍各起一个请求越堆越多。与 notify.ts 的轮询同款。
  const poll = async (): Promise<void> => {
    while (!stopped && !signal.aborted) {
      try {
        const items = await fetchRestartNotices();
        if (stopped || signal.aborted) return;
        const sig = noticesSignature(items);
        if (sig !== last) {
          // 无变化不回调、不重渲染
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
  void poll(); // 首帧：页面加载即生效（已挂着的提醒立即可见）
  const stop = (): void => {
    stopped = true;
  };
  signal.addEventListener('abort', stop, { once: true });
  return {
    // 让下一拍**无条件**重新同步：清掉签名基线，使下一次拉到什么就回调什么。
    // 用途：卡片 × 走的是「乐观移除 + POST」，POST 失败时 host 仍留着那条提醒，
    // 而签名（sessionId@ts）没变 → 不 invalidate 的话卡片再也回不来（静默丢提醒）。
    resync: () => {
      last = '';
    },
    stop,
  };
}
