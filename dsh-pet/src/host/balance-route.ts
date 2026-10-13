/**
 * 余额路由的装配层：把「本机自探测（A）」「dsh-usage 增强（B）」「本机用量折叠」合成一份响应。
 *
 * 为什么单独一层：合并规则有三条硬约定，错一条都会产出用户肉眼才能发现的错数字——
 *   ① 余额只认自探测（A）：dsh-usage 的快照**仅**在自探测返回 `unsupported`（该路由根本没有
 *      探测能力）时兜底，并标 `source:'dsh-usage'`；缺凭证/抓取失败保持显式报错——
 *      那是要用户去修的配置问题，拿旧快照顶替等于把故障藏起来。
 *   ② 用量是**单一数字**：远端台账（持久化、重启不丢）优先，本机折叠兜底，**绝不相加**
 *      （同一批调用两边各记一次，相加就是双倍）。
 *   ③ 兜底与增强都不进关键路径：dsh-usage 是第三方插件，端口非法/接口变化/被禁用都只是
 *      少一行用量或少一次兜底，自探测结果照常返回。
 *
 * 自探测走 ./balance/index.ts（上游的服务商注册表：opencode-go / commandcode /
 * deepseek-official / deepseek-account / moark），本层只负责把它的结果与 fork 的两项增强
 * （今日用量行、dsh-usage 兜底）拼在一起。
 */
import { normalizeProviderRoute, queryBalance, type BalanceResult } from './balance/index';
import type { AccountBalanceSnapshot } from './balance/types';
import { fetchOverview, overviewBalance, overviewTodayUsage } from './usage-bridge';
import { localDateKey, mergeUsage, type UsageWithSource, type UsageTotals } from './usage-fold';

/** 装配层入参（全部由路由 handler 从 ctx 与折叠器取出；测试可逐项注入） */
export interface BalanceRouteInput {
  /** 当前服务商（agentDefaultModel.currentSelection().provider，可为包装路由，如 modlens-moark） */
  provider: string;
  /** 凭证解析：ref 名 → key（路由侧包装 ctx.credentials.resolve） */
  resolveCredential: (ref: string) => Promise<string | undefined>;
  /**
   * 账号余额查询（由路由侧注入 ctx.deepseekAccount.getBalance）。
   * 只有 `deepseek-account` 路由用得到它；缺省时该路由报 credential-missing（账号服务不在场）。
   */
  resolveAccount?: () => Promise<AccountBalanceSnapshot | null | undefined>;
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
 * 路由响应体 = 自探测结果 + fork 的两项附加信息。
 * 形状与 src/shared/balance.ts 的 RawBalanceResult 同构（HTTP 契约两端各自声明，host 不 import 该目录）。
 */
export type BalancePayload = BalanceResult & {
  /** 余额来源：probe = host 自探测；dsh-usage = 第三方台账兜底（自探测不支持的 family） */
  source?: 'probe' | 'dsh-usage';
  /** 今日用量（只挂在金额形态上——窗口形态的气泡讲额度百分比，不是 token 消费） */
  usage?: UsageWithSource;
};

/**
 * 组装余额响应体（写进 S 的 balance 叶子；两端从 /state 读同一份）。
 * @returns 自探测结果；金额形态可能带 `usage` 行，`unsupported` 时可能带 dsh-usage 兜底
 */
export async function buildBalancePayload(input: BalanceRouteInput): Promise<BalancePayload> {
  const now = input.now ?? Date.now;
  // 探测结果里没有 family（上游契约只给 provider 与展示形态），用量增强按路由归一化后的 family 取数：
  // 与注册表的匹配口径必须一致（modlens-moark → moark），否则 dsh-usage 的台账永远对不上。
  const family = normalizeProviderRoute(input.provider);
  const probe = await queryBalance(input.provider, input.resolveCredential, input.resolveAccount);

  // dsh-usage 增强（可选）：一次 loopback 拉取同时供「今日用量」与「不支持时的余额兜底」
  const overview = await fetchOverview(input.port, input.fetchImpl);
  const usage = mergeUsage(input.localUsage, overviewTodayUsage(overview, family, localDateKey(now())));

  if (probe.ok) {
    // 窗口形态（opencode / commandcode）不挂用量行：它的气泡讲的是额度百分比，不是 token 消费
    if (probe.shape !== 'money' || usage === undefined) return { ...probe, source: 'probe' };
    return { ...probe, source: 'probe', usage };
  }

  // 自探测不支持该 family：第三方快照是唯一可能的真数字来源
  if (probe.reason === 'unsupported') {
    const snapshot = overviewBalance(overview, family);
    if (snapshot !== undefined) {
      return {
        ok: true,
        provider: probe.provider,
        shape: 'money',
        source: 'dsh-usage',
        // 兜底快照给不出档位基准：不折算百分比、不播档位动画（不替它猜一个）
        data: { currency: snapshot.currency, total: snapshot.total },
        ...(usage !== undefined ? { usage } : {}),
      };
    }
  }
  return probe;
}
