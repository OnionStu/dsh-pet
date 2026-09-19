/**
 * 余额查询（host 半侧）：把「当前服务商」映射到对应的余额/用量接口并抓取。
 *
 * 设计（2026-09-18 重构为**适配器表**）：
 * - 数据源按「服务商 family」寻址：路由 id 先经 `normalizeProviderRoute` 归一化再匹配，
 *   因为 DSH 里同一个账号可能有多条路由（`moark` / `modlens-moark` 包装路由、
 *   `deepseek` / `deepseek-official` 别名）——不归一化就会出现「有余额接口却查不到」；
 * - 新增服务商 = 表里加一行（`build` 请求规格 + `parse` 解析），不再有 per-provider 分支代码；
 * - 多凭证：适配器声明自己需要哪些 credential ref（如 moark 的控制台 cookie + 资源包 key），
 *   由调用方经 DSH 官方 credentialRef 解析后注入（本模块不直接读 .credentials.yaml）；
 * - **「假 0」防线**：解析层对「全 0 且无明细」这类"不是余额"的响应返回 undefined，
 *   上层显式报 fetch-error——绝不静默伪造 0 余额（moark 资源包接口对本机账号就是这种响应）；
 * - 基准值随探测结果一起返回（`baseline`）：金额型档位折算不能再用写死的常量
 *   （DeepSeek 满额 ¥20，moark 月额度 ¥4000，用错基准档位动画就永远不降级）；
 * - 未登记的服务商 → 显式 `unsupported`，由上层决定不显示；
 * - 网络超时 + 重试（实测该环境对境外端点间歇性超时）。
 */

/** 抓取超时（ms） */
const FETCH_TIMEOUT_MS = 20_000;
/** 单次抓取失败后的重试次数（失败间隔 0.8s 线性退避） */
const RETRIES = 3;

/** DeepSeek 官方满额基准（¥）：余额 ≥ 该值视为未消耗。
 *  与 src/shared/balance.ts 的同名常量是**两份独立声明**（host 不得 import src/shared，
 *  DSH 单文件加载约束）；host 现在把基准随响应下发，shared 那份只作老响应的兜底。 */
export const DEEPSEEK_FULL_BALANCE_CNY = 20;

/** 探测用凭证：按 family 需要哪些就带哪些（缺的字段为 undefined） */
export interface BalanceCredential {
  /** API key（Bearer 认证，如 MOARK_API_KEY / DEEPSEEK_API_KEY） */
  apiKey?: string;
  /** 控制台会话 Cookie（浏览器 Cookie 头原文，如 MOARK_CONSOLE_COOKIE） */
  consoleCookie?: string;
}

/** 适配器需要的凭证 ref 名（缺省 = 该 family 不需要这类凭证） */
export interface CredentialRefs {
  apiKeyRef?: string;
  consoleCookieRef?: string;
}

/** 金额型探测结果：余额 + 满额基准（基准缺省时由上层按 family 兜底） */
export interface BalanceProbe {
  currency: string;
  total: string;
  baseline?: string;
}

/** OpenCode Go 三窗口用量（0-100 已用百分比 + 各自重置时间） */
export interface OpenCodeWindows {
  rolling: number;
  weekly: number;
  monthly: number;
  rollingResetsAt: string;
  weeklyResetsAt: string;
  monthlyResetsAt: string;
}

/** 请求规格：url + headers（凭证如何进请求由适配器自己决定） */
export interface ProbeRequest {
  url: string;
  headers: Record<string, string>;
}

/** 金额型适配器（余额查询） */
export interface MoneyAdapter {
  kind: 'balance';
  /** family 名（= 归一化后的路由 id，如 moark / deepseek-official） */
  family: string;
  /** 可命中的路由 id（归一化后的 id；别名在这里列） */
  ids: string[];
  credential: CredentialRefs;
  build(cred: BalanceCredential): ProbeRequest;
  parse(status: number, body: unknown): BalanceProbe | undefined;
}

/** 窗口型适配器（用量百分比查询） */
export interface WindowsAdapter {
  kind: 'opencode';
  family: string;
  ids: string[];
  credential: CredentialRefs;
  build(cred: BalanceCredential): ProbeRequest;
  parse(status: number, body: unknown): OpenCodeWindows | undefined;
}

export type BalanceAdapter = MoneyAdapter | WindowsAdapter;

/** 数值兜底校验：非有限数 → undefined（数据异常由上层显式报错，不静默当 0） */
function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** 非空字符串，否则 undefined */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 金额格式化（CNY 两位小数） */
function money(n: number): string {
  return n.toFixed(2);
}

/** Bearer 认证头（头名统一小写：HTTP 头名大小写不敏感，模块内保持一种写法） */
const bearer = (key?: string): Record<string, string> =>
  key === undefined ? {} : { authorization: 'Bearer ' + key, 'user-agent': 'dsh-pet-balance' };

/**
 * 路由 id → family：DSH 里同一账号可能挂多条路由，余额表按 family 匹配。
 * - `modlens-<upstream>`：@liustack/modlens 自动铸造的包装路由（当前默认 provider 就是
 *   `modlens-moark`），上游由 id 自身编码，去掉前缀即得；
 * - `deepseek-modlens`：modlens 给 deepseek-official 的历史包装 id（不满足上面的前缀规则）；
 * - 其余原样返回。
 */
export function normalizeProviderRoute(provider: string): string {
  if (provider === 'deepseek-modlens') return 'deepseek-official';
  const wrapped = /^modlens-(.+)$/.exec(provider);
  return wrapped?.[1] ?? provider;
}

/** DeepSeek 官方余额（/user/balance） */
const DEEPSEEK_OFFICIAL: MoneyAdapter = {
  kind: 'balance',
  family: 'deepseek-official',
  ids: ['deepseek-official', 'deepseek'], // DSH 里两条路由并存（dsh-usage 的适配器同样列了两个）
  credential: { apiKeyRef: 'DEEPSEEK_API_KEY' },
  build: (cred) => ({ url: 'https://api.deepseek.com/user/balance', headers: bearer(cred.apiKey) }),
  parse: (status, body) => {
    if (status !== 200) return undefined;
    const infos = (body as { balance_infos?: unknown } | null)?.balance_infos;
    if (!Array.isArray(infos) || infos.length === 0) return undefined;
    const first = infos[0] as Record<string, unknown>;
    const total = str(first.total_balance);
    const currency = str(first.currency);
    if (total === undefined || currency === undefined) return undefined;
    return { currency, total, baseline: money(DEEPSEEK_FULL_BALANCE_CNY) };
  },
};

/** OpenCode Go 用量（/zen/go/v1/usage） */
const OPENCODE_GO: WindowsAdapter = {
  kind: 'opencode',
  family: 'opencode-go',
  ids: ['opencode-go'],
  credential: { apiKeyRef: 'OPENCODE_GO_API_KEY' },
  build: (cred) => ({ url: 'https://opencode.ai/zen/go/v1/usage', headers: bearer(cred.apiKey) }),
  parse: (status, body) => {
    if (status !== 200) return undefined;
    const usage = (body as { usage?: unknown } | null)?.usage;
    if (!usage || typeof usage !== 'object') return undefined;
    const u = usage as Record<string, { percent?: unknown; resetsAt?: unknown }>;
    const rolling = u.rolling,
      weekly = u.weekly,
      monthly = u.monthly;
    if (!rolling || !weekly || !monthly) return undefined;
    const windows = {
      rolling: num(rolling.percent),
      weekly: num(weekly.percent),
      monthly: num(monthly.percent),
      rollingResetsAt: str(rolling.resetsAt),
      weeklyResetsAt: str(weekly.resetsAt),
      monthlyResetsAt: str(monthly.resetsAt),
    };
    const percents = [windows.rolling, windows.weekly, windows.monthly];
    const resets = [windows.rollingResetsAt, windows.weeklyResetsAt, windows.monthlyResetsAt];
    if (percents.some((p) => p === undefined) || resets.some((r) => r === undefined)) return undefined;
    return windows as OpenCodeWindows;
  },
};

/**
 * Moark（模力方舟 / Gitee AI）余额：
 * - **控制台会员额度**（需要 `MOARK_CONSOLE_COOKIE`）：`remaining_quota` 是当月剩余额度（CNY），
 *   `total_quota` 是当月总额度（作档位基准）；只有这个端点给的是**账户真实余额**。
 * - 资源包公开接口（`MOARK_API_KEY`，Bearer）作兜底：它返回的是**资源包**余额，
 *   未购买资源包的账号会返回全 0 → `{balance:0, details:[]}`。这不是"余额为零"，
 *   解析层显式返回 undefined（上层落 fetch-error），绝不展示 ¥0.00。
 */
const MOARK: MoneyAdapter = {
  kind: 'balance',
  family: 'moark',
  ids: ['moark'],
  credential: { apiKeyRef: 'MOARK_API_KEY', consoleCookieRef: 'MOARK_CONSOLE_COOKIE' },
  build: (cred) =>
    cred.consoleCookie !== undefined
      ? {
          url: 'https://moark.com/api/base/oschina/member/quota',
          headers: { cookie: cred.consoleCookie, accept: '*/*', 'user-agent': 'Mozilla/5.0' },
        }
      : { url: 'https://api.moark.com/v1/tokens/packages/balance', headers: bearer(cred.apiKey) },
  parse: (status, body) => {
    if (status !== 200 || typeof body !== 'object' || body === null) return undefined;
    const data = body as Record<string, unknown>;
    // 控制台额度（会员月额度）：真数字来源
    const quota = num(data.remaining_quota) ?? num(data.member_remaining_quota);
    if (quota !== undefined) {
      const base = num(data.total_quota);
      return base === undefined
        ? { currency: 'CNY', total: money(quota) }
        : { currency: 'CNY', total: money(quota), baseline: money(base) };
    }
    // 资源包余额：全 0 且无明细 = 该账号没有资源包，不是余额
    const pkg = num(data.balance);
    if (pkg === undefined) return undefined;
    const details = Array.isArray(data.details) ? data.details : [];
    if (pkg === 0 && details.length === 0) return undefined;
    return { currency: 'CNY', total: money(pkg) };
  },
};

/** 已知可查询余额/用量的服务商（只登记有公开接口的；新增服务商 = 这里加一行） */
export const BALANCE_ADAPTERS: BalanceAdapter[] = [DEEPSEEK_OFFICIAL, OPENCODE_GO, MOARK];

/** 路由 id（含包装路由）→ 适配器；未匹配返回 undefined（= 不支持查询） */
export function matchBalanceProvider(provider: string): BalanceAdapter | undefined {
  const family = normalizeProviderRoute(provider);
  return BALANCE_ADAPTERS.find((a) => a.ids.includes(family));
}

/** 用量事实（本机折叠或 dsh-usage 台账，两处口径一致） */
export interface UsageTotals {
  tokens: number;
  calls: number;
}

/** 一次探测的结果（client 端与 host 端同构使用；HTTP 契约两端各自声明） */
export type BalanceResult =
  | {
      ok: true;
      provider: string;
      family: string;
      kind: 'opencode';
      source: 'probe';
      data: OpenCodeWindows;
    }
  | {
      ok: true;
      provider: string;
      family: string;
      kind: 'balance';
      /** probe = 本机自探测；dsh-usage = 自探测不支持时由 dsh-usage 快照兜底 */
      source: 'probe' | 'dsh-usage';
      data: BalanceProbe;
      /** 今日用量（可选；由路由层合并后附加） */
      usage?: { tokens: number; calls: number; source: 'dsh-usage' | 'local' };
    }
  | {
      ok: false;
      provider: string;
      family: string;
      reason: 'unsupported' | 'credential-missing' | 'fetch-error';
      message?: string;
    };

/** fetch 一次，带超时；失败抛错（调用方决定是否重试） */
async function fetchOnce(url: string, headers: Record<string, string>): Promise<Response> {
  return fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/** fetch + 重试；全败抛最后错误 */
async function fetchWithRetry(url: string, headers: Record<string, string>): Promise<Response> {
  let last: unknown;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      return await fetchOnce(url, headers);
    } catch (e) {
      last = e;
      if (i < RETRIES) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * 按当前服务商查询余额。
 * @param provider agentDefaultModel.currentSelection().provider（可为包装路由，如 modlens-moark）
 * @param resolveKey 凭证解析：ref 名 → key（由调用方注入 ctx.credentials.resolve）
 * @returns 结构化结果：成功 / 不支持 / 缺凭证 / 抓取失败（失败带 message，绝不返回伪造数字）
 */
export async function queryBalance(
  provider: string,
  resolveKey: (ref: string) => Promise<string | undefined>,
): Promise<BalanceResult> {
  const family = normalizeProviderRoute(provider);
  const match = matchBalanceProvider(provider);
  if (!match) return { ok: false, provider, family, reason: 'unsupported' };

  const apiKey = match.credential.apiKeyRef ? await resolveKey(match.credential.apiKeyRef) : undefined;
  const consoleCookie = match.credential.consoleCookieRef
    ? await resolveKey(match.credential.consoleCookieRef)
    : undefined;
  if (apiKey === undefined && consoleCookie === undefined) {
    const refs = [match.credential.consoleCookieRef, match.credential.apiKeyRef].filter((r) => r !== undefined);
    return { ok: false, provider, family, reason: 'credential-missing', message: '缺少凭证 ' + refs.join(' / ') };
  }

  try {
    const spec = match.build({ apiKey, consoleCookie });
    const res = await fetchWithRetry(spec.url, spec.headers);
    if (!res.ok) throw new Error(family + ' HTTP ' + res.status);
    const body: unknown = await res.json().catch(() => undefined);
    if (match.kind === 'opencode') {
      const data = match.parse(res.status, body);
      if (data === undefined) throw new Error('dsh-pet: ' + family + ' 用量响应无法解析');
      return { ok: true, provider, family, kind: 'opencode', source: 'probe', data };
    }
    const data = match.parse(res.status, body);
    // parse 返回 undefined 有两种可能：响应结构非法，或响应**不是余额**（如 moark 资源包全 0）。
    // 两者都显式报错——绝不回退成 ¥0。
    if (data === undefined) throw new Error('dsh-pet: ' + family + ' 余额响应无法解析（可能不是余额字段）');
    return { ok: true, provider, family, kind: 'balance', source: 'probe', data };
  } catch (e) {
    return { ok: false, provider, family, reason: 'fetch-error', message: e instanceof Error ? e.message : String(e) };
  }
}
