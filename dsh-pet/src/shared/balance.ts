// 余额数据层与展示视图（src/shared 纯逻辑，浏览器 bundle 与桌面 shared-core 共用）：
// 拉取 /dsh-pet-7340/balance → 解析 → 档位计算 → 气泡行数据。
// 不依赖 React/DOM；host/balance.ts 的 BalanceResult 与本模块的 RawBalanceResult 同构
// （HTTP 契约两端各自声明，host 无需 import 本目录——DSH 单文件加载约束）。

/** /dsh-pet-7340/balance 响应（与 host/balance.ts 同构；两端按此结构校验） */
export interface RawBalanceResult {
  ok: boolean;
  provider?: string;
  /** 归一化后的服务商 family（host 下发，如 modlens-moark → moark）；老响应缺失时按 provider 兜底 */
  family?: string;
  /** 金额形态为 'balance'；'deepseek' 是老响应（等价于 balance + deepseek-official family） */
  kind?: 'opencode' | 'balance' | 'deepseek';
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
    currency?: unknown;
    total?: unknown;
    granted?: unknown;
    toppedUp?: unknown;
    /** 满额基准（金额型档位折算用，如 moark 的当月总额度 4000） */
    baseline?: unknown;
  };
}

/** 已解析的余额视图（展示 + 档位计算用） */
export interface BalanceView {
  provider: string;
  /** 服务商 family：决定展示差异（如只有 DeepSeek 官方计价才有峰/谷档位） */
  family?: string;
  kind: 'opencode' | 'balance';
  ok: true;
  /** opencode：三窗口用量（0-100 数字）+ 各自的重置时间 */
  rolling?: number;
  weekly?: number;
  monthly?: number;
  rollingResetsAt?: string;
  weeklyResetsAt?: string;
  monthlyResetsAt?: string;
  /** 金额形态：余额金额（字符串，与接口一致） */
  currency?: string;
  total?: string;
  granted?: string;
  toppedUp?: string;
  /** 金额形态：满额基准（缺省回落 DEEPSEEK_FULL_BALANCE_CNY，兼容老响应） */
  baseline?: string;
  /** 金额形态：今日用量（无记录则缺省；气泡据此决定要不要补一行） */
  usage?: { tokens: number; calls: number };
}

/** 无效（不支持/缺凭证/抓取失败）：显式标记，不静默 */
export interface BalanceUnavailable {
  provider: string;
  ok: false;
  reason: 'unsupported' | 'credential-missing' | 'fetch-error';
  message?: string;
}

export type BalanceState = BalanceView | BalanceUnavailable;

const TIMEOUT_MS = 20000;
const RETRIES = 2;

/** 带超时 + 重试的 GET（host 已内置重试，这里再兜底网络抖动）。
 *  浏览器传默认相对路径；桌面模式（Electron，file:// 页面）传绝对 URL。 */
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

/** 拉取当前状态的余额；网络/解析失败显式抛错（上层决定报错方式，绝不静默 0） */
export async function fetchBalanceState(baseUrl: string = '/dsh-pet-7340/balance'): Promise<BalanceState> {
  const res = await getWithRetry(baseUrl);
  const raw: RawBalanceResult = await res.json().catch(() => null);
  if (!raw || typeof raw !== 'object') throw new Error('dsh-pet: 余额响应非法');

  const provider = String(raw.provider ?? 'unknown');
  if (raw.ok !== true) {
    const reason =
      raw.reason === 'unsupported' || raw.reason === 'credential-missing' || raw.reason === 'fetch-error'
        ? raw.reason
        : 'fetch-error';
    return { provider, ok: false, reason, message: typeof raw.message === 'string' ? raw.message : undefined };
  }

  if (raw.kind === 'opencode') {
    const d = raw.data;
    if (!d || typeof d !== 'object') throw new Error('dsh-pet: opencode 数据非法');
    const rolling = Number(d.rolling);
    const weekly = Number(d.weekly);
    const monthly = Number(d.monthly);
    if (![rolling, weekly, monthly].every(Number.isFinite)) throw new Error('dsh-pet: opencode 百分比非数字');
    return {
      provider,
      family: familyOf(raw, provider),
      kind: 'opencode',
      ok: true,
      rolling,
      weekly,
      monthly,
      rollingResetsAt: typeof d.rollingResetsAt === 'string' ? d.rollingResetsAt : undefined,
      weeklyResetsAt: typeof d.weeklyResetsAt === 'string' ? d.weeklyResetsAt : undefined,
      monthlyResetsAt: typeof d.monthlyResetsAt === 'string' ? d.monthlyResetsAt : undefined,
    };
  }
  // 金额形态：'balance' 为现契约，'deepseek' 是老响应（等价于 balance + deepseek-official family）
  if (raw.kind === 'balance' || raw.kind === 'deepseek') {
    const d = raw.data;
    if (!d || typeof d !== 'object') throw new Error('dsh-pet: 余额数据非法');
    const granted = typeof d.granted === 'string' ? d.granted : undefined;
    const toppedUp = typeof d.toppedUp === 'string' ? d.toppedUp : undefined;
    const baseline = typeof d.baseline === 'string' && d.baseline !== '' ? d.baseline : undefined;
    const usage = parseUsage(raw.usage);
    return {
      provider,
      family: familyOf(raw, provider),
      kind: 'balance',
      ok: true,
      currency: typeof d.currency === 'string' ? d.currency : undefined,
      total: typeof d.total === 'string' ? d.total : undefined,
      // 可选字段只在有值时出现：不把 undefined 塞进视图（避免「有键无值」误导消费方）
      ...(granted !== undefined ? { granted } : {}),
      ...(toppedUp !== undefined ? { toppedUp } : {}),
      ...(baseline !== undefined ? { baseline } : {}),
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  throw new Error('dsh-pet: 余额 kind 非法');
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

/** 手动触发计数（/balance 命令 +1；两个平台同样的 1s 轻量轮询语义）。 */
export async function fetchTriggerCount(baseUrl: string = '/dsh-pet-7340/balance/trigger'): Promise<number> {
  const res = await fetch(baseUrl, { cache: 'no-store' });
  if (!res.ok) return -1;
  const data = await res.json().catch(() => null);
  return data && typeof data.count === 'number' ? data.count : -1;
}

/** DeepSeek 满额基准（¥）：余额 ≥ 该值视为 100%（未消耗），余额按比例折算为已用百分比。
 *  host 现在把每个 family 自己的基准随探测结果下发（moark 是当月总额度）；本常量只作
 *  **老响应/缺基准时**的兜底（历史语义就来自 DeepSeek 官方计价的 ¥20）。 */
export const DEEPSEEK_FULL_BALANCE_CNY = 20;

/**
 * 事件档位百分比（已用百分比语义：0 = 未消耗，100 = 耗尽）：
 * - opencode：取三窗口最大（风险最高者为准）
 * - 金额形态：余额按**该 family 的基准**折算为已用百分比
 *   （DeepSeek ¥20 = 100%；moark 用探测下发的当月总额度，如 ¥4000）
 *   余额 ≥ 基准 → 0%（充值后不出现负值）；余额 ≤ 0 → 100%
 */
export function balancePercent(v: BalanceView): number | undefined {
  if (v.kind === 'opencode') return Math.max(v.rolling ?? 0, v.weekly ?? 0, v.monthly ?? 0);
  const total = Number(v.total);
  if (!Number.isFinite(total)) return undefined; // 金额非法（非数字）：不触发（上层校验已兜底，此处双保险）
  const baseline = Number(v.baseline ?? DEEPSEEK_FULL_BALANCE_CNY);
  if (!Number.isFinite(baseline) || baseline <= 0) return undefined; // 基准非法：宁可不触发，也不算错
  // 负数 = 透支，与 0 等价按「已用完」折算：-0.02 → 剩余 0 → 已用 100%（播「分文不剩」档）
  const remaining = (Math.max(0, total) / baseline) * 100; // 剩余百分比 0~100+
  return Math.max(0, Math.min(100, 100 - remaining)); // 折算为已用百分比
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
 * 余额事件档位索引（与 assets/config.jsonc 注释一致）：
 * index = p === 100 ? 5 : Math.floor(p / 20)
 */
export function balanceEventIndex(p: number): number {
  if (p === 100) return 5;
  const i = Math.floor(p / 20);
  return i < 5 ? i : 4;
}

/** OpenCode 各窗口满额度金额（USD）。业务常量：12 = 5h（5 小时滚动窗口）、30 = 周、60 = 月 */
export const OPENCODE_QUOTA_USD = {
  rolling: 12,
  weekly: 30,
  monthly: 60,
} as const;

/** 窗口展示名（联想框文案用）：5h = 5 小时额度窗口、周、月 */
export const WINDOW_LABELS = {
  rolling: '5h',
  weekly: '周',
  monthly: '月',
} as const;

export type OpenCodeWindow = keyof typeof OPENCODE_QUOTA_USD;

/** 一个窗口的额度概况（用于联想框一句话判定） */
export interface WindowUsage {
  label: string;
  percent: number;
  quotaUsd: number;
  /** 剩余额度（USD）= 满额度 × (100 − percent) / 100 */
  remainingUsd: number;
  resetsAt?: string;
}

/** 取三窗口剩余额度最少的那个（最先到达满额度/最先用完） */
export function urgentWindow(v: BalanceView): WindowUsage | undefined {
  if (v.kind !== 'opencode') return undefined;
  const windows: OpenCodeWindow[] = ['rolling', 'weekly', 'monthly'];
  const resets: Record<OpenCodeWindow, string | undefined> = {
    rolling: v.rollingResetsAt,
    weekly: v.weeklyResetsAt,
    monthly: v.monthlyResetsAt,
  };
  let best: WindowUsage | undefined;
  for (const w of windows) {
    const percent = v[w] ?? 0;
    const quota = OPENCODE_QUOTA_USD[w];
    const remaining = (quota * (100 - percent)) / 100;
    const cand: WindowUsage = {
      label: WINDOW_LABELS[w],
      percent,
      quotaUsd: quota,
      remainingUsd: remaining,
      resetsAt: resets[w],
    };
    if (best === undefined || remaining < best.remainingUsd) best = cand;
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

/**
 * DeepSeek 峰谷计价档位（北京时间）：
 * - 高峰：工作日 9:00–12:00、14:00–18:00；其余为空闲（低谷）
 * - 周六/周日全天按低谷价计费（自 2026-08-23 起，周末不再区分峰谷）
 */
export type PricingTier = 'peak' | 'idle';

/** 当前时刻的 DeepSeek 计价档位（按北京时间 Asia/Shanghai，UTC+8 无夏令时） */
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
 * - opencode：两行 —— 「5h/周/月」额度已用 N% + 重置倒计时
 * - deepseek：一行 —— 余额（峰/谷）¥x.xx（峰红/谷绿由 role:'tier' 表达）
 * - 无效：显式展示不可用原因（见 unavailableRows），绝不伪造数字
 */
export function balanceBubbleView(state: BalanceState): BalanceBubbleRow[] {
  if (state.ok) {
    if (state.kind === 'opencode') {
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
    // 金额形态：DeepSeek 官方计价才有峰/谷档位（family 说了算，不按 kind 猜）；
    // 其余 family（如 moark）只有金额一行，避免摆一个不存在的计价档位。
    const rows: BalanceBubbleRow[] = [];
    if (state.family === 'deepseek-official') {
      const tier = deepseekPricingTier();
      rows.push(
        { role: 'label', text: '余额（' },
        { role: 'tier', tier, text: tier === 'peak' ? '峰' : '谷' },
        { role: 'label', text: '）¥' + (state.total ?? '-') },
      );
    } else {
      rows.push({ role: 'label', text: '余额 ¥' + (state.total ?? '-') });
    }
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
  return state.kind === 'balance' && balanceBubbleView(state).length > 1;
}

/** 非 ok 状态「弹不弹文字说明气泡」的判定结果 */
export interface BalanceNoticeDecision {
  /** true = 本次应弹气泡（文字说明）；false = 静默（同一原因已提示过，且非显式请求） */
  show: boolean;
  /** 本次提示的原因标识（形如 `unsupported:commandcode`；ok 状态为 null）：调用方存下，供下次比较 */
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
