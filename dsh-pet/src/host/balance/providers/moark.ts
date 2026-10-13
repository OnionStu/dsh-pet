/**
 * Moark（模力方舟 / Gitee AI）余额路由（provider id `moark`）。
 *
 * 这是本机 fork 的默认余额来源：当前默认 provider 是 modlens 铸造的**包装路由 `modlens-moark`**，
 * 由 ./index.ts 的 normalizeProviderRoute 去掉前缀后命中本文件（`moark` 本体同样命中）。
 *
 * 两个端点，语义不同，按拿到的凭证选：
 * - **控制台会员额度**（凭证 `MOARK_CONSOLE_COOKIE`，浏览器 Cookie 头原文）：
 *   `remaining_quota` 是当月剩余额度（CNY）、`total_quota` 是当月总额度（作档位基准）。
 *   **只有这个端点给的是账户真实余额**，因此 cookie 可用时优先走它。
 * - 资源包公开接口（凭证 `MOARK_API_KEY`，Bearer）作兜底：它返回的是**资源包**余额，
 *   未购买资源包的账号会返回 `{ balance: 0, details: [] }`。那不是"余额为零"，
 *   本文件显式返回 undefined（上层落 fetch-error），**绝不展示 ¥0.00**。
 *
 * 凭证是**两条**（cookie 与 key 各自可选），所以 credential 用 `mode: 'refs'`：
 * 至少解到一个才继续，两个都解不到由 ./index.ts 统一落 credential-missing。
 */
import { fetchWithRetry, looseNum } from '../internal';
import type { BalanceProvider } from '../types';

/** 控制台会员额度端点（需要 cookie；这是真实余额的唯一来源） */
const CONSOLE_URL = 'https://moark.com/api/base/oschina/member/quota';
/** 资源包余额端点（Bearer；只反映资源包，可能是"没有资源包"而不是"没有钱"） */
const PACKAGES_URL = 'https://api.moark.com/v1/tokens/packages/balance';

/** 本路由需要的两份凭证（都缺才算缺凭证；缺哪份由调用方决定走哪个端点） */
export interface MoarkCredential {
  /** 控制台 Cookie 头原文 */
  consoleCookie?: string;
  /** 资源包接口的 API key */
  apiKey?: string;
}

/** 金额格式化（CNY 两位小数） */
const money = (n: number): string => n.toFixed(2);

/**
 * 按凭证选端点并拼出请求规格（纯函数，便于测试）。
 * 控制台端点用浏览器形态的 UA（它不是 API，认 cookie 不认 Bearer）。
 */
export function moarkRequest(cred: MoarkCredential): { url: string; headers: Record<string, string> } {
  return cred.consoleCookie !== undefined
    ? {
        url: CONSOLE_URL,
        headers: { cookie: cred.consoleCookie, accept: '*/*', 'user-agent': 'Mozilla/5.0' },
      }
    : { url: PACKAGES_URL, headers: {} };
}

/**
 * 响应解析（纯函数，便于测试）：成功 → { total, baseline? }；认不出 → undefined（上层显式报错）。
 *
 * 「假 0」防线：资源包响应全 0 且无明细 = 该账号没有资源包，**不是余额**，返回 undefined。
 */
export function parseMoarkBalance(status: number, body: unknown): { total: string; baseline?: string } | undefined {
  if (status !== 200 || typeof body !== 'object' || body === null) return undefined;
  const data = body as Record<string, unknown>;
  // 控制台额度（会员月额度）：真数字来源；legacy 字段 member_remaining_quota 兼容
  const quota = looseNum(data.remaining_quota) ?? looseNum(data.member_remaining_quota);
  if (quota !== undefined) {
    const base = looseNum(data.total_quota);
    return base === undefined ? { total: money(quota) } : { total: money(quota), baseline: money(base) };
  }
  // 资源包余额：全 0 且无明细 = 没有资源包，不是余额
  const pkg = looseNum(data.balance);
  if (pkg === undefined) return undefined;
  const details = Array.isArray(data.details) ? data.details : [];
  if (pkg === 0 && details.length === 0) return undefined;
  return { total: money(pkg) };
}

export const moark: BalanceProvider = {
  ids: ['moark'],
  credential: { mode: 'refs', refs: ['MOARK_CONSOLE_COOKIE', 'MOARK_API_KEY'] },
  async fetch({ provider, key, keys }) {
    const consoleCookie = keys?.MOARK_CONSOLE_COOKIE;
    const apiKey = keys?.MOARK_API_KEY ?? key;
    const spec = moarkRequest({ consoleCookie, apiKey });
    // 控制台端点不带 Bearer（它认 cookie）；资源包端点才走 Bearer
    const res = await fetchWithRetry(spec.url, consoleCookie !== undefined ? '' : apiKey, spec.headers);
    const body: unknown = await res.json().catch(() => undefined);
    const parsed = parseMoarkBalance(res.status, body);
    if (parsed === undefined) {
      throw new Error('dsh-pet: moark 余额响应无法解析（可能不是余额字段）');
    }
    return {
      ok: true,
      provider,
      shape: 'money',
      data: {
        currency: 'CNY',
        total: parsed.total,
        // 基准（当月总额度）随数据带出：档位折算不能写死 ¥20，否则 ¥1200 的额度永远显示「已用 0%」
        ...(parsed.baseline !== undefined ? { fullBalance: parsed.baseline } : {}),
      },
    };
  },
};
