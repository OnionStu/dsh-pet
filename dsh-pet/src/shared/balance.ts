// 余额数据层与展示视图（src/shared 纯逻辑，浏览器 bundle 与桌面 shared-core 共用）：
// 解析 S 的余额叶子（host 的 BalanceResult）→ 客户端视图 → 档位计算 → 气泡行数据。
// 取数不在本模块：余额由 host 定时器刷新并写进 /state（两端共享同一份结果），本模块只做纯解析/展示。
// 不依赖 React/DOM；host/balance/ 的 BalanceResult 与本模块的 RawBalanceResult 同构（HTTP 契约两端
// 各自声明，host 无需 import 本目录——DSH 单文件加载约束）。
//
// **本模块不认识任何服务商**：只认叶子里的 `shape`（展示形态）与数据自带的业务事实
// （各窗口满额度、滚动窗时长、档位基准、峰谷档位）。服务商名字只用于日志与去重键。
// 加一个服务商只要落到 `windows` / `money` 之一，这里与两端展示层一行都不用改。

/** 余额叶子里的原始响应（与 host/balance/ 的 BalanceResult 同构；两端按此结构校验） */
export interface RawBalanceResult {
  ok: boolean;
  provider?: string;
  /** 归一化后的服务商 family（host 下发，如 modlens-moark → moark）；老响应缺失时按 provider 兜底 */
  family?: string;
  /** 金额形态为 'balance'；'deepseek' 是老响应（等价于 balance + deepseek-official family） */
  kind?: 'opencode' | 'balance' | 'deepseek';
  /** 展示形态（host 写叶子时带上）：windows = 三窗口用量，money = 账户金额 */
  shape?: 'windows' | 'money';
  reason?: string;
  message?: string;
  /** 余额来源：probe = host 自探测；dsh-usage = 第三方台账兜底（仅供展示/排查，判定逻辑不看它） */
  source?: string;
  /** 今日用量（host 合并后下发；可选） */
  usage?: { tokens?: unknown; calls?: unknown; source?: unknown };
  data?: {
    rolling?: unknown;
    weekly?: unknown;
    monthly?: unknown;
    rollingResetsAt?: unknown;
    weeklyResetsAt?: unknown;
    monthlyResetsAt?: unknown;
    rollingCapUsd?: unknown;
    weeklyCapUsd?: unknown;
    monthlyCapUsd?: unknown;
    rollingLabel?: unknown;
    currency?: unknown;
    total?: unknown;
    granted?: unknown;
    toppedUp?: unknown;
    /** 满额基准（金额型档位折算用，如 moark 的当月总额度 4000） */
    baseline?: unknown;
    fullBalance?: unknown;
    tier?: unknown;
  };
}

/** 计价档位装饰（气泡上的「峰/谷」）：由服务商算好后随数据带出，展示层原样渲染 */
export type PricingTier = 'peak' | 'idle';

/** 已解析的余额视图（展示 + 档位计算用） */
export interface BalanceView {
  provider: string;
  /** 服务商 family（host 下发，如 modlens-moark → moark；缺省时解析层按 provider 兜底）：
   *  决定展示差异（如只有 DeepSeek 官方计价才有峰/谷档位） */
  family?: string;
  /**
   * 展示形态（**主判据**）：windows = 三窗口用量，money = 账户金额。
   * fork 时期的叶子/视图没有 shape、只有 kind——解析层会把两者一起补上，
   * 展示层一律经 shapeOf() 归一化，因此两种写法都认（老视图是历史兼容，不进新数据）。
   */
  shape?: 'windows' | 'money';
  /** 形态的旧写法（fork 契约，与 shape 表达同一件事；见 shapeOf） */
  kind?: 'opencode' | 'balance' | 'deepseek';
  ok: true;
  /**
   * 三窗口已用百分比（0-100 数字）+ 各自的重置时间。
   * `monthly` 必有（月度窗口是数据的底线）；`rolling` / `weekly` 可缺省 = 该服务商没有这个窗口。
   */
  rolling?: number;
  weekly?: number;
  monthly?: number;
  rollingResetsAt?: string;
  weeklyResetsAt?: string;
  monthlyResetsAt?: string;
  /**
   * 各窗口满额度（USD），由服务商随数据带出（opencode 是业务常量、commandcode 是接口回报）。
   * 用于「最紧迫窗口」的绝对口径；缺省 → 退化为百分比口径。展示层不再写死任何服务商的额度。
   */
  rollingCapUsd?: number;
  weeklyCapUsd?: number;
  monthlyCapUsd?: number;
  /** 滚动窗展示名（服务商自报，如 `5h`）；缺省回落 DEFAULT_ROLLING_LABEL */
  rollingLabel?: string;
  /** money：余额金额（字符串，与接口一致） */
  currency?: string;
  total?: string;
  granted?: string;
  toppedUp?: string;
  /** 金额形态：满额基准——`fullBalance` 的旧写法；老视图只有它，见 balancePercent 的兼容分支 */
  baseline?: string;
  /** 金额形态：今日用量（无记录则缺省；气泡据此决定要不要补一行） */
  usage?: { tokens: number; calls: number };
  /**
   * money：档位基准（同 currency 单位）。余额 ≥ 该值视为未消耗。
   * 缺省 = 该服务商不给基准 → 不折算百分比、不播档位动画（不替它猜一个基准）。
   */
  fullBalance?: string;
  /** money：计价档位装饰；缺省 = 渲染成不带峰谷的「余额 ¥x.xx」 */
  tier?: PricingTier;
}

/** 无效（不支持/缺凭证/抓取失败）：显式标记，不静默 */
export interface BalanceUnavailable {
  provider: string;
  ok: false;
  reason: 'unsupported' | 'credential-missing' | 'fetch-error';
  message?: string;
}

export type BalanceState = BalanceView | BalanceUnavailable;

/**
 * 可选数字：缺省 → undefined；出现但非法 → null（调用方据此整拍跳过——不把 NaN/字符串送进展示层）。
 */
function optNum(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 展示形态归一化：`shape` 为主判据；没有 shape 时按 fork 时期的 `kind` 推断
 * （'opencode' = 窗口用量，'balance' / 'deepseek' = 金额）。
 *
 * 为什么留这条兼容：fork 的叶子与测试构造的视图只有 kind，上游改为 shape 后两者并存——
 * 展示层若各判一种就会出现"同一份数据两端渲染不同分支"。归一化放在这一处，
 * 两端与全部展示函数都只认它的返回值。
 */
export function shapeOf(v: {
  shape?: 'windows' | 'money';
  kind?: 'opencode' | 'balance' | 'deepseek';
}): 'windows' | 'money' {
  if (v.shape === 'windows' || v.shape === 'money') return v.shape;
  return v.kind === 'opencode' ? 'windows' : 'money';
}

/**
 * host 的余额原始响应（`BalanceResult`，经 `/state` 的 `sections.balance` 叶子送达）→ 客户端视图。
 *
 * 形状非法 / shape 不认识 → **null**（消费端跳过这一拍）——注意这里**不抛**：它跑在 1s 轮询里，
 * 抛异常会把整拍打断（其余叶子也跟着不渲染）。取数失败（HTTP/网络）不在这里发生：取数在 host，
 * 失败会以 `ok:false` 写进 S，由这里正常映射成"不可用"状态。
 */
export function toBalanceState(raw: unknown): BalanceState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawBalanceResult;
  const provider = String(r.provider ?? 'unknown');
  if (r.ok !== true) {
    const reason =
      r.reason === 'unsupported' || r.reason === 'credential-missing' || r.reason === 'fetch-error'
        ? r.reason
        : 'fetch-error';
    return { provider, ok: false, reason, message: typeof r.message === 'string' ? r.message : undefined };
  }

  const d = r.data;
  if (!d || typeof d !== 'object') return null;

  // 形态：新契约看 shape；fork 时期的老叶子只有 kind（'opencode' / 'balance' / 'deepseek'）
  const legacy = r.shape === undefined;
  const shape = r.shape ?? (r.kind === 'opencode' ? 'windows' : r.kind === undefined ? undefined : 'money');
  if (shape === undefined) return null;

  if (shape === 'windows') {
    const monthly = optNum(d.monthly);
    const rolling = optNum(d.rolling);
    const weekly = optNum(d.weekly);
    const rollingCapUsd = optNum(d.rollingCapUsd);
    const weeklyCapUsd = optNum(d.weeklyCapUsd);
    const monthlyCapUsd = optNum(d.monthlyCapUsd);
    // 月度窗口是这份数据的底线：缺了/非法 = 认不出响应（滚动窗与周窗口、各窗口额度都是可选）
    if (monthly === undefined || monthly === null) return null;
    // 出现但非法（optNum 返回 null）→ 整拍跳过，不把坏数字送进展示层
    if (
      rolling === null ||
      weekly === null ||
      rollingCapUsd === null ||
      weeklyCapUsd === null ||
      monthlyCapUsd === null
    ) {
      return null;
    }
    return {
      provider,
      family: familyOf(r, provider),
      shape: 'windows',
      ok: true,
      ...(legacy ? { kind: 'opencode' } : {}),
      rolling,
      weekly,
      monthly,
      rollingCapUsd,
      weeklyCapUsd,
      monthlyCapUsd,
      rollingLabel: typeof d.rollingLabel === 'string' && d.rollingLabel.length > 0 ? d.rollingLabel : undefined,
      rollingResetsAt: typeof d.rollingResetsAt === 'string' ? d.rollingResetsAt : undefined,
      weeklyResetsAt: typeof d.weeklyResetsAt === 'string' ? d.weeklyResetsAt : undefined,
      monthlyResetsAt: typeof d.monthlyResetsAt === 'string' ? d.monthlyResetsAt : undefined,
    };
  }
  if (shape === 'money') {
    // 可选字段只在有值时出现在视图里：不把 undefined 塞进去（"有键无值"会误导消费方，
    // 也让严格深比对没法钉住叶子形状）。
    const granted = typeof d.granted === 'string' ? d.granted : undefined;
    const toppedUp = typeof d.toppedUp === 'string' ? d.toppedUp : undefined;
    // 满额基准：新契约叫 fullBalance（服务商随数据带出），fork 时期叫 baseline——两个名字都认；
    // 视图里两个键都给，老消费端只读 baseline 也照常工作。
    const fullBalance =
      typeof d.fullBalance === 'string' && d.fullBalance !== ''
        ? d.fullBalance
        : typeof d.baseline === 'string' && d.baseline !== ''
          ? d.baseline
          : undefined;
    const usage = parseUsage(r.usage);
    const tier = d.tier === 'peak' || d.tier === 'idle' ? d.tier : undefined;
    return {
      provider,
      family: familyOf(r, provider),
      shape: 'money',
      ok: true,
      currency: typeof d.currency === 'string' ? d.currency : undefined,
      total: typeof d.total === 'string' ? d.total : undefined,
      ...(granted !== undefined ? { granted } : {}),
      ...(toppedUp !== undefined ? { toppedUp } : {}),
      ...(fullBalance !== undefined ? { fullBalance } : {}),
      // kind / baseline 是 fork 时期的字段名：**只在老叶子（没有 shape）时补**——那时它们是唯一信号，
      // 老消费端（含那时的测试）仍读得到；新叶子只带 shape，视图里就不重复放两个同义字段。
      ...(legacy ? { kind: 'balance' } : {}),
      ...(legacy && fullBalance !== undefined ? { baseline: fullBalance } : {}),
      ...(tier !== undefined ? { tier } : {}),
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  return null;
}

/** 取数超时（ms）与重试次数：host 已内置重试，这里再兜一层网络抖动 */
const TIMEOUT_MS = 10000;
const RETRIES = 2;

/** 带超时 + 重试的 GET（浏览器传默认相对路径；桌面模式是 file:// 页面，必须传绝对 URL） */
async function getWithRetry(url: string): Promise<Response> {
  let last: unknown;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return res;
      last = new Error('HTTP ' + res.status);
    } catch (e) {
      last = e;
    }
    if (i < RETRIES) await new Promise((r) => setTimeout(r, 600));
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * 拉取一次余额快照（GET /balance：读 host 当前那一份叶子，无副作用），解析成客户端视图。
 *
 * 为什么留着它：两端（浏览器 overlay / 桌面外壳）的**渲染路径**已统一改为轮询 /state
 * （见的 toBalanceState），这条 GET 是 fork 时期的取数入口，保留给"只想取一次、不挂轮询"
 * 的调用方与既有测试；端点由 host 从 S 的 balance 叶子读出，与轮询看到的是同一份数据。
 * 网络/解析失败显式抛错（上层决定报错方式，绝不静默 0）。
 */
export async function fetchBalanceState(baseUrl: string = '/dsh-pet-7340/balance'): Promise<BalanceState> {
  const res = await getWithRetry(baseUrl);
  const raw: unknown = await res.json().catch(() => null);
  const state = toBalanceState(raw);
  if (state === null) throw new Error('dsh-pet: 余额响应非法');
  return state;
}

/** family 兜底：host 未下发时按 provider 推断（老 deepseek 响应 → deepseek-official，因为它就是官方计价） */
function familyOf(raw: RawBalanceResult, provider: string): string {
  if (typeof raw.family === 'string' && raw.family !== '') return raw.family;
  return raw.kind === 'deepseek' ? 'deepseek-official' : provider;
}

/** 今日用量：结构不合法/没有调用 → undefined（宁可少一行，也不显示半截数字） */
function parseUsage(raw: RawBalanceResult['usage']): { tokens: number; calls: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const tokens = Number(raw.tokens);
  const calls = Number(raw.calls);
  if (!Number.isFinite(tokens) || !Number.isFinite(calls) || tokens < 0 || calls <= 0) return undefined;
  return { tokens, calls };
}

/** DeepSeek 满额基准（¥）：余额 ≥ 该值视为 100%（未消耗），余额按比例折算为已用百分比。
 *  host 现在把每个 family 自己的基准随探测结果下发（moark 是当月总额度）；本常量只作
 *  **老响应/缺基准时**的兜底（历史语义就来自 DeepSeek 官方计价的 ¥20）。 */
export const DEEPSEEK_FULL_BALANCE_CNY = 20;

/**
 * 当前时刻的 DeepSeek 计价档位（按北京时间 Asia/Shanghai，UTC+8 无夏令时）。
 *
 * 现在的正源是服务商随数据带出的 `tier`（见 host/balance/providers/deepseek-official）；
 * 本函数是**老视图/数据没带 tier 时**的兜底，保持 fork 时期"由 family 决定峰谷"的展示语义。
 */
export function deepseekPricingTier(now: Date = new Date()): PricingTier {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23', // h23 避免午夜被格式化为 "24:00"
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes): string | undefined => parts.find((p) => p.type === type)?.value;
  const weekday = pick('weekday');
  const hour = Number(pick('hour'));
  if (weekday === 'Sat' || weekday === 'Sun') return 'idle'; // 周末全天低谷
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? 'peak' : 'idle';
}

/** token 数紧凑显示（万/亿）：与 dsh-usage 气泡 note 同口径，两个来源的数字才可比 */
export function formatTokens(count: number): string {
  const compact = (value: number): string => {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  };
  if (count >= 1e8) return compact(count / 1e8) + '亿';
  if (count >= 1e4) return compact(count / 1e4) + '万';
  return String(count);
}

/**
 * 事件档位百分比（已用百分比语义：0 = 未消耗，100 = 耗尽）：
 * - windows：取三窗口最大（风险最高者为准）；
 * - money：余额按**数据自带的基准**折算（基准 20 → 余额 20 元 → 0%，10 元 → 50%，0 元 → 100%）。
 *   基准缺省时按契约分流，不替服务商猜：
 *     · 新视图（带 shape）→ undefined：不折算、不播档位动画；
 *     · fork 时期的老视图（只有 kind、没有 shape，历史叶子）→ 回落 DeepSeek 官方的 ¥20
 *       （那是它当时的语义，见 DEEPSEEK_FULL_BALANCE_CNY）。
 */
export function balancePercent(v: BalanceView): number | undefined {
  if (shapeOf(v) === 'money') {
    const total = Number(v.total);
    if (!Number.isFinite(total)) return undefined; // 金额非法（非数字）：不触发（上层校验已兜底，此处双保险）
    const legacy = v.shape === undefined; // 老视图：只有 kind，没有 shape
    const full = legacy ? Number(v.baseline ?? DEEPSEEK_FULL_BALANCE_CNY) : Number(v.fullBalance ?? v.baseline);
    if (!Number.isFinite(full) || full <= 0) return undefined; // 无基准：该服务商不给档位语义
    // 负数 = 透支，与 0 等价按「已用完」折算：-0.02 → 剩余 0 → 已用 100%（播「分文不剩」档）
    const remaining = (Math.max(0, total) / full) * 100; // 剩余百分比 0~100+
    return Math.max(0, Math.min(100, 100 - remaining)); // 折算为已用百分比
  }
  // windows：三窗口取最大（只有月窗口时就是它自己）
  return Math.max(v.rolling ?? 0, v.weekly ?? 0, v.monthly ?? 0);
}

/**
 * 余额事件档位索引（与 assets/config.jsonc 注释一致）：
 * index = p === 100 ? 5 : Math.floor(p / 20)
 */
export function balanceEventIndex(p: number): number {
  if (p === 100) return 5;
  const i = Math.floor(p / 20);
  return i < 5 ? i : 4;
}

/** 窗口键（三种窗口类别，与服务商无关） */
export type WindowKey = 'rolling' | 'weekly' | 'monthly';

/**
 * 窗口展示名（联想框文案用）：周、月。
 * 滚动窗的时长是**服务商自己的业务事实**（如 5 小时），不走这张表，见 DEFAULT_ROLLING_LABEL。
 */
export const WINDOW_LABELS = {
  weekly: '周',
  monthly: '月',
} as const;

/**
 * 滚动窗展示名的兜底：服务商应随数据带 `rollingLabel`，缺省时才用它。
 * 之所以要有兜底：缺一个标签会让气泡出现空档，而 5h 是当前两个滚动窗口服务商的共同取值。
 */
export const DEFAULT_ROLLING_LABEL = '5h';

/** 一个窗口的额度概况（用于联想框一句话判定） */
export interface WindowUsage {
  label: string;
  percent: number;
  /** 满额度（USD），由服务商随数据带出；算不出时缺省 */
  quotaUsd?: number;
  /** 剩余额度（USD）= 满额度 × (100 − percent) / 100；满额度未知时缺省 */
  remainingUsd?: number;
  resetsAt?: string;
}

/** 窗口展示名：滚动窗取服务商自报值（缺省 5h），周/月走固定表 */
function windowLabel(v: BalanceView, w: WindowKey): string {
  if (w === 'rolling') return v.rollingLabel ?? DEFAULT_ROLLING_LABEL;
  return WINDOW_LABELS[w];
}

/** 各窗口的满额度（USD）：全部来自数据（展示层不写死任何服务商的额度） */
function windowQuotas(v: BalanceView): Record<WindowKey, number | undefined> {
  return { rolling: v.rollingCapUsd, weekly: v.weeklyCapUsd, monthly: v.monthlyCapUsd };
}

/**
 * 取最先告急的一个窗口（所有 windows 形态的服务商共用同一套，无服务商判断）：
 * - 满额度齐全 → 绝对口径：剩余额度（USD）最少者；
 * - 有窗口给不出满额度 → 退化为相对口径：已用百分比最大者
 *   （两窗额度量级不同，缺一个还硬比绝对剩余会反直觉）。
 * 不存在的窗口直接跳过，不补 0。
 *
 * 绝对口径的副作用（刻意保留）：滚动窗额度最小，通常先报它；两端一致，完整读数见 tools/api-tester.html。
 */
export function urgentWindow(v: BalanceView): WindowUsage | undefined {
  if (shapeOf(v) === 'money') return undefined;
  const quotas = windowQuotas(v);
  const resets: Record<WindowKey, string | undefined> = {
    rolling: v.rollingResetsAt,
    weekly: v.weeklyResetsAt,
    monthly: v.monthlyResetsAt,
  };
  const present = (['rolling', 'weekly', 'monthly'] as WindowKey[]).filter((w) => v[w] !== undefined);
  if (present.length === 0) return undefined;
  const allQuotas = present.every((w) => {
    const quota = quotas[w];
    return quota !== undefined && quota > 0;
  });

  let best: WindowUsage | undefined;
  for (const w of present) {
    const percent = v[w] ?? 0;
    const quota = quotas[w];
    const cand: WindowUsage = {
      label: windowLabel(v, w),
      percent,
      quotaUsd: quota,
      remainingUsd: allQuotas && quota !== undefined ? (quota * (100 - percent)) / 100 : undefined,
      resetsAt: resets[w],
    };
    if (best === undefined) {
      best = cand;
      continue;
    }
    const moreUrgent = allQuotas ? (cand.remainingUsd ?? 0) < (best.remainingUsd ?? 0) : cand.percent > best.percent;
    if (moreUrgent) best = cand;
  }
  return best;
}

/**
 * 重置时间 → 相对文案（保留 1 位小数）：
 * - 距重置 ≥ 4 天 → 「N.x 天」
 * - 距重置 < 4 天 → 「N.x 小时」
 * - 已过重置点 → 「已重置」；未知时间 → 空串
 */
export function resetInText(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const delta = t - Date.now();
  if (delta <= 0) return '已重置';
  const hoursF = delta / 3_600_000;
  if (hoursF >= 96) return (Math.round((hoursF / 24) * 10) / 10).toFixed(1) + ' 天';
  return Math.max(0.1, Math.round(hoursF * 10) / 10).toFixed(1) + ' 小时';
}

// ---------- 富余额气泡展示视图（浏览器与桌面共用同一份内容/文案/数学） ----------

/** 气泡行数据：role 决定两端的样式类（浏览器 React span；桌面 DOM div）；tier 用于峰谷着色 */
export type BalanceBubbleRow =
  | { role: 'label'; text: string }
  | { role: 'sub'; text: string }
  | { role: 'error'; text: string }
  | { role: 'tier'; tier: PricingTier; text: string };

/** 不可用状态的气泡行（显式说明原因，绝不伪造数字）：
 *  - unsupported：服务商未登记查询接口（配置事实，不是故障）→ 报出 provider id，便于自查"当前到底是谁"
 *  - credential-missing：缺凭证 → 次要行放 host 报的凭证名（不含 message 时不留空行）
 *  - fetch-error：抓取失败 → 次要行放底层错误
 * 次要行为空的会被剔除：空 div 在气泡里会白占一行高度。 */
function unavailableRows(state: BalanceUnavailable): BalanceBubbleRow[] {
  const rows: BalanceBubbleRow[] =
    state.reason === 'unsupported'
      ? [
          { role: 'error', text: '当前服务商暂不支持余额查询' },
          { role: 'sub', text: '当前服务商：' + state.provider },
        ]
      : state.reason === 'credential-missing'
        ? [
            // host 的 message 本身已带「缺少凭证 X」前缀：这里只作次要行原样展示，不再加前缀
            // （曾经的「缺少凭证：缺少凭证 X」双重前缀）
            { role: 'error', text: '缺少余额查询凭证' },
            { role: 'sub', text: state.message ?? '' },
          ]
        : [
            { role: 'error', text: '余额查询失败' },
            { role: 'sub', text: state.message ?? '' },
          ];
  return rows.filter((r) => r.text !== '');
}

/**
 * 把 BalanceState 渲染成气泡行数据（纯函数，不碰 DOM/React）：
 * - windows：两行 —— 「X额度已用 N%」+ 重置倒计时
 * - money：一行 —— 「余额（峰/谷）¥x.xx」（峰红/谷绿由 role:'tier' 表达）；
 *   服务商没给档位装饰时退化成「余额 ¥x.xx」，不替它编一个峰谷
 * - 无效：显式展示不可用原因（见 unavailableRows），绝不伪造数字
 */
export function balanceBubbleView(state: BalanceState): BalanceBubbleRow[] {
  if (state.ok) {
    if (shapeOf(state) !== 'money') {
      // windows：三窗口中先告急的一个
      const w = urgentWindow(state);
      if (w) {
        const reset = resetInText(w.resetsAt);
        const rows: BalanceBubbleRow[] = [
          { role: 'label', text: w.label + '额度已用 ' + Math.round(w.percent) + '%' },
          { role: 'sub', text: reset ? reset + '重置' : '已重置' },
        ];
        return rows;
      }
      return [{ role: 'label', text: '额度数据不可用' }];
    }
    // money：币种符号由数据带出（CNY → ¥，USD → $）
    const symbol = state.currency === 'USD' ? '$' : '¥';
    const amount = symbol + (state.total ?? '-');
    // 档位装饰（峰/谷）：正源是服务商随数据带出的 `tier`；没带时按 family 兜底——只有 DeepSeek
    // 官方计价有峰谷规则（见 deepseekPricingTier），其余 family（如 moark）只有金额一行，
    // 以免摆一个对方根本不存在的计价档位。
    const tier = state.tier ?? (state.family === 'deepseek-official' ? deepseekPricingTier() : undefined);
    const rows: BalanceBubbleRow[] = tier
      ? [
          { role: 'label', text: '余额（' },
          { role: 'tier', tier, text: tier === 'peak' ? '峰' : '谷' },
          { role: 'label', text: '）' + amount },
        ]
      : [{ role: 'label', text: '余额 ' + amount }];
    // 今日用量：与另一只宠物（dsh-usage 公告）同口径的副行；无记录就不补行（不留空行）
    if (state.usage) {
      rows.push({
        role: 'sub',
        text: '今日 ' + formatTokens(state.usage.tokens) + ' tokens · ' + state.usage.calls + ' 次调用',
      });
    }
    return rows;
  }
  return unavailableRows(state);
}

/**
 * 余额气泡是否需要**换行变体**（浏览器与桌面外壳共用同一份判定）：
 * - 不可用状态是多行文字说明（默认 nowrap 会顶出宠物宽度）；
 * - 金额形态带今日用量时也是两行（金额 + 用量），同样需要换行；
 * - opencode 的两行（档位 + 重置倒计时）本来就窄，保持默认 nowrap，别动它的观感。
 */
export function balanceBubbleNeedsWrap(state: BalanceState): boolean {
  if (!state.ok) return true;
  return shapeOf(state) === 'money' && balanceBubbleView(state).length > 1;
}

/** 非 ok 状态「弹不弹文字说明气泡」的判定结果 */
export interface BalanceNoticeDecision {
  /** true = 本次应弹气泡（文字说明）；false = 静默（同一原因已提示过，且非显式请求） */
  show: boolean;
  /** 本次提示的原因标识（形如 `unsupported:unregistered-provider`；ok 状态为 null）：调用方存下，供下次比较 */
  key: string | null;
}

/**
 * 余额不可用时是否弹气泡（浏览器 overlay 与桌面外壳共用同一份判定——两端各写一份必然漂移）：
 * - 显式请求（`/balance` 命令、桌面「查看余额」菜单）：一律弹——用户问了就该有答复，包括"不支持"这件事；
 * - 自动轮询：只在原因（含服务商）**变化**时弹一次（首次检测到也算变化），避免每 30 分钟反复刷同一句话。
 * 判定纯粹基于传入的 lastKey，不持有状态；调用方负责保存返回值里的 key。
 */
export function decideBalanceNotice(
  state: BalanceState,
  lastKey: string | null,
  explicit: boolean,
): BalanceNoticeDecision {
  if (state.ok) return { show: false, key: null };
  const key = state.reason + ':' + state.provider;
  return { show: explicit || key !== lastKey, key };
}
