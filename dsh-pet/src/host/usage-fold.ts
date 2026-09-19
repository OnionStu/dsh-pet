/**
 * 今日用量折叠（host 半侧）：从 DSH 会话事件流自己算「本地日 × family」的 tokens / 调用次数。
 *
 * 为什么自己折叠而不读 dsh-usage 的台账文件（HANDOFF 的 b2）：
 * - 事实本来就在事件流里：`request/header` / `request/context` 给出会话路由，
 *   `assistant/message` 带 `data.usage`；host 已经为 work-status 订阅了同一条 `session/event`，
 *   增量成本≈0，且不耦合第三方插件的存储格式（`version:1`）与 HTTP 契约；
 * - 包装路由（modlens-moark）经同一套 `normalizeProviderRoute` 归到上游 family，
 *   与余额匹配口径一致（切路由不会让今日数字跳变）。
 * 代价：只活在内存里，宿主重启即归零——这正是「远端 dsh-usage 优先」的原因（见 mergeUsage）。
 *
 * 口径钉子：tokens = input + cacheRead + cacheWrite + output（**不含 reasoning**），
 * 与 dsh-usage 台账的 `totalTokens` 逐字一致——两个来源的数字必须能互相核对，不能各算各的。
 */
import { normalizeProviderRoute, type UsageTotals } from './balance';

/** 用量事实（本机折叠 / 远端台账同一口径）：定义在 balance.ts（HTTP 契约层），此处再导出方便用量侧引用 */
export type { UsageTotals };

/** 单次调用的 token 用量（DSH `assistant/message` 事件 `data.usage` 的子集） */
export interface TokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** 用量来源：远端 dsh-usage 台账（重启不丢）或本机事件折叠 */
export type UsageSource = 'dsh-usage' | 'local';

/** 带来源的用量（气泡文案与调试用） */
export interface UsageWithSource extends UsageTotals {
  source: UsageSource;
}

/** 零值（每次返回新对象，调用方改不脏内部状态） */
const zero = (): UsageTotals => ({ tokens: 0, calls: 0 });

/** 本地日期键（YYYY-MM-DD，本机时区）：与 dsh-usage 台账的 `localDateKey` 同语义 */
export function localDateKey(atMs: number): string {
  const d = new Date(atMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 一次调用的 token 总量（四类之和；缺字段按 0） */
export function totalTokens(usage: TokenUsageLike): number {
  const n = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return n(usage.inputTokens) + n(usage.cacheReadTokens) + n(usage.cacheWriteTokens) + n(usage.outputTokens);
}

/** 会话事件 → 路由 provider（两种事件都真实出现，取到就记住） */
function routeOf(event: unknown): string | undefined {
  const e = event as { type?: unknown; data?: unknown } | null;
  if (e === null || typeof e !== 'object') return undefined;
  if (e.type === 'request/header') {
    const config = (e.data as { header?: { config?: { provider?: unknown } } } | null)?.header?.config;
    return typeof config?.provider === 'string' && config.provider !== '' ? config.provider : undefined;
  }
  if (e.type === 'request/context') {
    const provider = (e.data as { provider?: unknown } | null)?.provider;
    return typeof provider === 'string' && provider !== '' ? provider : undefined;
  }
  return undefined;
}

/** 会话事件 → 一次调用的用量（非 assistant/message 或结构非法 → undefined） */
function usageOf(event: unknown): TokenUsageLike | undefined {
  const e = event as { type?: unknown; data?: { usage?: unknown } } | null;
  if (e === null || typeof e !== 'object' || e.type !== 'assistant/message') return undefined;
  const usage = e.data?.usage;
  return typeof usage === 'object' && usage !== null ? (usage as TokenUsageLike) : undefined;
}

/** 用量折叠器：订阅侧只调 observe，展示侧只调 today */
export interface UsageFold {
  /** 会话事件入口（与 host 的 `session/event` 监听同一签名） */
  observe(sessionId: string, event: unknown): void;
  /** 某 family 的今日用量（含包装路由；无记录 → 0/0） */
  today(family: string, atMs?: number): UsageTotals;
}

/**
 * 创建折叠器。
 * @param now 时钟注入（测试用；默认 Date.now）
 */
export function createUsageFold(now: () => number = Date.now): UsageFold {
  /** sessionId → 该会话最近一次的路由 provider（原样存，归一化在折叠时做） */
  const routes = new Map<string, string>();
  /** `${本地日}|${family}` → 用量 */
  const buckets = new Map<string, UsageTotals>();
  const bucketKey = (dateKey: string, family: string): string => dateKey + '|' + family;
  /** 只保留当天：跨天时丢掉旧桶（内存有界；历史由 dsh-usage 提供） */
  const pruneTo = (dateKey: string): void => {
    for (const k of buckets.keys()) if (!k.startsWith(dateKey + '|')) buckets.delete(k);
  };

  return {
    observe(sessionId, event) {
      const provider = routeOf(event);
      if (provider !== undefined) {
        routes.set(sessionId, provider);
        return;
      }
      const usage = usageOf(event);
      if (usage === undefined) return;
      const route = routes.get(sessionId);
      // 未记路由就来的消息：宁可少算，也不落到错的 family（多会话交错时尤其重要）
      if (route === undefined) return;
      const dateKey = localDateKey(now());
      pruneTo(dateKey);
      const k = bucketKey(dateKey, normalizeProviderRoute(route));
      const bucket = buckets.get(k) ?? zero();
      bucket.tokens += totalTokens(usage);
      bucket.calls += 1;
      buckets.set(k, bucket);
    },
    today(family, atMs = now()) {
      const bucket = buckets.get(bucketKey(localDateKey(atMs), normalizeProviderRoute(family)));
      return bucket === undefined ? zero() : { ...bucket };
    },
  };
}

/**
 * 合并两个用量来源（纯函数）：**远端优先**（dsh-usage 台账持久化，重启不丢），
 * 本机折叠兜底；两者绝不相加——同一批调用会被两边各记一次，相加就是双倍。
 * 都没有调用记录 → undefined（气泡据此不留空行）。
 */
export function mergeUsage(local?: UsageTotals, remote?: UsageTotals): UsageWithSource | undefined {
  const usable = (t?: UsageTotals): t is UsageTotals => t !== undefined && t.calls > 0;
  if (usable(remote)) return { tokens: remote.tokens, calls: remote.calls, source: 'dsh-usage' };
  if (usable(local)) return { tokens: local.tokens, calls: local.calls, source: 'local' };
  return undefined;
}
