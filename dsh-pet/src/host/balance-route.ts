/**
 * 余额路由的装配层：把「本机自探测（A）」「dsh-usage 增强（B）」「本机用量折叠」合成一份响应。
 *
 * 为什么单独一层：合并规则有三条硬约定，错一条都会产出用户肉眼才能发现的错数字——
 *   ① 余额只认自探测（A）：dsh-usage 的快照**仅**在自探测返回 `unsupported`（该 family 根本没有
 *      探测能力）时兜底，并标 `source:'dsh-usage'`；缺凭证/抓取失败保持显式报错——
 *      那是要用户去修的配置问题，拿旧快照顶替等于把故障藏起来。
 *   ② 用量是**单一数字**：远端台账（持久化、重启不丢）优先，本机折叠兜底，**绝不相加**
 *      （同一批调用两边各记一次，相加就是双倍）。
 *   ③ 兜底与增强都不进关键路径：dsh-usage 是第三方插件，端口非法/接口变化/被禁用都只是
 *      少一行用量或少一次兜底，自探测结果照常返回。
 */
import { queryBalance, type BalanceResult } from './balance';
import { fetchOverview, overviewBalance, overviewTodayUsage } from './usage-bridge';
import { localDateKey, mergeUsage, type UsageTotals } from './usage-fold';

/** 装配层入参（全部由路由 handler 从 ctx 与折叠器取出；测试可逐项注入） */
export interface BalanceRouteInput {
  /** 当前服务商（agentDefaultModel.currentSelection().provider，可为包装路由） */
  provider: string;
  /** 凭证解析：ref 名 → key（路由侧包装 ctx.credentials.resolve） */
  resolveCredential: (ref: string) => Promise<string | undefined>;
  /** 本机折叠的今日用量（无记录传 0/0） */
  localUsage: UsageTotals;
  /** DSH webServer 端口（0/非法 → 不接 dsh-usage 增强） */
  port: number;
  /** fetch 注入（测试用；默认全局 fetch） */
  fetchImpl?: typeof fetch;
  /** 时钟注入（测试用；默认 Date.now） */
  now?: () => number;
}

/**
 * 组装 `/dsh-pet-7340/balance` 的响应体。
 * @returns 与 host/balance.ts 的 BalanceResult 同构；金额形态可能带 `usage` 行
 */
export async function buildBalancePayload(input: BalanceRouteInput): Promise<BalanceResult> {
  const now = input.now ?? Date.now;
  const probe = await queryBalance(input.provider, input.resolveCredential);

  // dsh-usage 增强（可选）：一次 loopback 拉取同时供「今日用量」与「不支持时的余额兜底」
  const overview = await fetchOverview(input.port, input.fetchImpl);
  const usage = mergeUsage(input.localUsage, overviewTodayUsage(overview, probe.family, localDateKey(now())));

  if (probe.ok) {
    // 窗口形态（opencode）不挂用量行：它的气泡讲的是额度百分比，不是 token 消费
    if (probe.kind !== 'balance' || usage === undefined) return probe;
    return { ...probe, usage };
  }

  // 自探测不支持该 family：第三方快照是唯一可能的真数字来源
  if (probe.reason === 'unsupported') {
    const snapshot = overviewBalance(overview, probe.family);
    if (snapshot !== undefined) {
      return {
        ok: true,
        provider: probe.provider,
        family: probe.family,
        kind: 'balance',
        source: 'dsh-usage',
        data: { currency: snapshot.currency, total: snapshot.total },
        ...(usage !== undefined ? { usage } : {}),
      };
    }
  }
  return probe;
}
