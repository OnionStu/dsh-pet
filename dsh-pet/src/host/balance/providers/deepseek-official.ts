/**
 * DeepSeek 官方 API Key 路由（provider id `deepseek-official`）—— 账户金额。
 *
 * 接口：`GET https://api.deepseek.com/user/balance`（Bearer）。
 * 三个金额由接口原样透传（不自己按 `granted + topped_up` 重算 `total_balance`）—— 官方路由给的
 * 数字比本插件推算的可信。档位基准与峰谷档位取自 ./deepseek-common.ts（两条 deepseek 路由同一套口径）。
 *
 * 与账号路由（./deepseek-account.ts）**同 shape、同形**：展示层共用同一套气泡，差异只在取数。
 */
import { DEEPSEEK_FULL_BALANCE, deepseekPricingTier } from '../deepseek-common';
import { fetchWithRetry, str } from '../internal';
import type { BalanceProvider } from '../types';

export const deepseekOfficial: BalanceProvider = {
  // 两个 id 都登记：DSH 里 'deepseek' 与 'deepseek-official' 两条路由并存
  //（fork 时期就是这么列的，dsh-usage 的适配器同样列了两个）
  ids: ['deepseek-official', 'deepseek'],
  credential: { mode: 'ref', ref: 'DEEPSEEK_API_KEY' },
  async fetch({ key, provider }) {
    const res = await fetchWithRetry('https://api.deepseek.com/user/balance', key);
    if (!res.ok) throw new Error('deepseek balance HTTP ' + res.status);
    const body: unknown = await res.json();
    const infos = (body as { balance_infos?: unknown })?.balance_infos;
    if (!Array.isArray(infos) || infos.length === 0)
      throw new Error('dsh-pet: deepseek balance 响应缺少 balance_infos');
    const first = infos[0] as Record<string, unknown>;
    return {
      ok: true,
      provider,
      shape: 'money',
      data: {
        currency: str(first.currency, 'currency'),
        total: str(first.total_balance, 'total_balance'),
        granted: str(first.granted_balance, 'granted_balance'),
        toppedUp: str(first.topped_up_balance, 'topped_up_balance'),
        fullBalance: DEEPSEEK_FULL_BALANCE,
        tier: deepseekPricingTier(),
      },
    };
  },
};
