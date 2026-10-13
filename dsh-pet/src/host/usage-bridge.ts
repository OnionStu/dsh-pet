/**
 * dsh-usage overview 桥（可选增强，HANDOFF 里没有的第四条路）。
 *
 * 为什么不走原本的 b1（猴子补丁 `pet.announce`）/ b3（镜像上游 `/api/pet/state`）：
 * - 当前默认 provider 是 `modlens-moark`（modlens 自动铸造的包装路由），而 dsh-usage 的
 *   `adapterFor` 是**精确 id 匹配**（`PROVIDER_ADAPTERS.find(a => a.ids.includes(id))`，
 *   moark 适配器只登记了 `moark`）→ 包装路由拿不到 snapshot，`announceCurrent` 落到
 *   ledger 兜底公告：**只有用量、没有余额**。所以 b1/b3 在当前路由下给不出「moark ¥余额」。
 * - `GET /api/dsh-usage/overview`（loopback-only 门禁、免 token）直接给结构化原始值：
 *   `providers[].balance.totalBalance` + `usage.today.providers[].totals`——比镜像公告字符串稳
 *   （无 80 字截断、无预格式化金额）、比读它的 JSON 文件稳（不耦合 `version:1` 存储格式）。
 *
 * 定位：**可选增强**。dsh-usage 是第三方插件，被禁用/升级/接口变化都可能发生 →
 * 这里所有函数在任何异常下都返回 undefined，静默降级到本机折叠（usage-fold），绝不进关键路径。
 */
import { normalizeProviderRoute } from './balance/index';
import { totalTokens, type TokenUsageLike, type UsageTotals } from './usage-fold';

/** loopback 拉取超时（ms）：它只是增强，卡住也不能拖慢 /balance */
const OVERVIEW_TIMEOUT_MS = 3_000;

/** dsh-usage overview 地址（loopback；路由自带 loopback 门禁，不需要 token） */
export const OVERVIEW_PATH = '/api/dsh-usage/overview';

/**
 * 拉取 dsh-usage overview。任何失败（端口非法/网络异常/非 200/非 JSON）→ undefined。
 * @param port DSH webServer 端口（ctx.webServer.port）
 * @param fetchImpl 注入用（默认全局 fetch；测试传桩）
 */
export async function fetchOverview(
  port: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = OVERVIEW_TIMEOUT_MS,
): Promise<unknown | undefined> {
  if (!Number.isInteger(port) || port <= 0) return undefined;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}${OVERVIEW_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

/** 从 overview 文档里取某 family 的今日用量（含包装路由合并；结构不合法 → undefined） */
export function overviewTodayUsage(raw: unknown, family: string, dateKey: string): UsageTotals | undefined {
  const today = (raw as { usage?: { today?: unknown } } | null)?.usage?.today;
  if (typeof today !== 'object' || today === null) return undefined;
  const doc = today as { date?: unknown; providers?: unknown };
  if (doc.date !== dateKey) return undefined; // 台账的「今天」与我们的本地日不一致时宁可不显示
  if (!Array.isArray(doc.providers)) return undefined;

  const wanted = normalizeProviderRoute(family);
  let tokens = 0;
  let calls = 0;
  let hit = false;
  for (const entry of doc.providers) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as { provider?: unknown; totals?: unknown };
    if (typeof row.provider !== 'string' || normalizeProviderRoute(row.provider) !== wanted) continue;
    if (typeof row.totals !== 'object' || row.totals === null) continue;
    // 台账的 totals 与 `assistant/message` 的 usage 同形（都是 DSH 的 token 计数），
    // 因此共用同一个 totalTokens 口径函数；这是外部不可信 JSON 的边界，取字段前逐个校验。
    const totals = row.totals as TokenUsageLike & { calls?: unknown };
    hit = true;
    tokens += totalTokens(totals);
    const n = Number(totals.calls);
    if (Number.isFinite(n) && n > 0) calls += n;
  }
  return hit ? { tokens, calls } : undefined;
}

/**
 * 从 overview 文档里取某 family 的余额快照（**仅作自探测不支持时的兜底**：
 * 自探测能拿到真数字时永远优先自探测——快照是别人格式化过的字符串，且更新节奏不由我们控制）。
 * 包装路由按上游 family 取（`modlens-moark` → `moark` 的快照），这正是 dsh-usage 自己做不到的一步。
 */
export function overviewBalance(raw: unknown, family: string): { currency: string; total: string } | undefined {
  const providers = (raw as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(providers)) return undefined;
  const wanted = normalizeProviderRoute(family);
  for (const entry of providers) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as { provider?: unknown; balance?: unknown };
    if (typeof row.provider !== 'string' || normalizeProviderRoute(row.provider) !== wanted) continue;
    const balance = row.balance as { currency?: unknown; totalBalance?: unknown } | undefined;
    if (typeof balance !== 'object' || balance === null) continue;
    if (
      typeof balance.currency === 'string' &&
      balance.currency !== '' &&
      typeof balance.totalBalance === 'string' &&
      balance.totalBalance !== ''
    ) {
      return { currency: balance.currency, total: balance.totalBalance };
    }
  }
  return undefined;
}
