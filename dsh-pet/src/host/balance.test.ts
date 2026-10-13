/**
 * Command Code 用量的契约测试（provider id `commandcode`，控制面 `/alpha/*`）。
 *
 * 背景：Command Code 的用量在官方 CLI 使用的**未文档化控制面**路由上。插件把它的 5h / 周 / 月
 * 三个窗口映射成与 opencode 同构的三窗口用量，展示层因此共用同一套「取最紧迫窗口」逻辑。
 *
 * 本文件把三件事钉住：
 *   ① 真实 GOAT 报文的解析（含 `resetAt: 0` 这类占位值不得被当成 1970 年重置时间）；
 *   ② 失败口径：必填字段缺失/非法一律抛错（→ fetch-error），可选信息一律省略，绝不伪造 0；
 *   ③ 网络链路：四个接口的**顺序与 query**、Bearer 注入、凭证 ref、订阅接口失败不致命。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖；fetch 用手写 stub 顶替（只跑假数据，不联网）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchBalanceProvider,
  moark,
  moarkRequest,
  normalizeProviderRoute,
  parseAccountBalance,
  parseCommandCode,
  parseMoarkBalance,
  queryBalance,
  type BalanceResult,
  type WindowsUsage,
} from './balance/index.ts';

/** 真实 GOAT 套餐报文（字段名与取值照抄线上响应；`resetAt: 0` 是空闲窗口的占位值） */
const GOAT_CREDITS = {
  credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 70, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
    weekly: { used: 0, cap: 35, exceeded: false, resetAt: 0 },
  },
};
const GOAT_SUBSCRIPTION = {
  success: true,
  data: {
    status: 'active',
    currentPeriodStart: '2026-09-13T01:01:27.000Z',
    currentPeriodEnd: '2026-10-13T01:01:27.000Z',
    planId: 'individual-goat',
  },
};
const GOAT_SUMMARY = { totalCost: 0, periodBasis: 'billing-period' };

/** 取成功的 commandcode 数据；形状不对直接失败（省得每个用例都写一遍收窄） */
function dataOf(result: BalanceResult): WindowsUsage {
  if (!result.ok || result.shape !== 'windows') {
    assert.fail('期望 commandcode 的成功结果，实际：' + JSON.stringify(result));
  }
  return result.data;
}

/** 百分比是算出来的浮点数：按 1e-9 容差比 */
function assertClose(actual: number | undefined, expected: number, what: string): void {
  assert.equal(typeof actual, 'number', what + ' 应为数字');
  assert.ok(Math.abs((actual as number) - expected) < 1e-9, what + '：期望 ' + expected + '，实际 ' + actual);
}

/** 极简 Response 替身：被测代码只用到 ok / status / json() */
function res(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** 装上 fetch stub（返回记录与卸载函数）；只按 URL 路由，不做真实网络 */
function stubFetch(handler: (url: string) => Response): {
  calls: string[];
  auths: (string | null)[];
  restore: () => void;
} {
  const calls: string[] = [];
  const auths: (string | null)[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    auths.push(new Headers(init?.headers).get('authorization'));
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;
  return {
    calls,
    auths,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/** 默认路由：四个控制面接口都给真实 GOAT 报文 */
function goatRoute(url: string): Response {
  if (url.includes('/alpha/whoami')) return res({ success: true, user: { id: 'u-1' }, org: { id: 'org-1' } });
  if (url.includes('/alpha/billing/credits')) return res(GOAT_CREDITS);
  if (url.includes('/alpha/billing/subscriptions')) return res(GOAT_SUBSCRIPTION);
  if (url.includes('/alpha/usage/summary')) return res(GOAT_SUMMARY);
  return res({}, 404);
}

describe('BALANCE_PROVIDERS —— commandcode 已登记（凭证 COMMANDCODE_API_KEY）', () => {
  test('provider id 命中 commandcode，凭证 ref 是 COMMANDCODE_API_KEY，且定义自带取数', () => {
    const def = matchBalanceProvider('commandcode');
    assert.deepEqual(def?.ids, ['commandcode']);
    assert.deepEqual(def?.credential, { mode: 'ref', ref: 'COMMANDCODE_API_KEY' });
    assert.equal(typeof def?.fetch, 'function', '服务商定义必须自带取数（加服务商只写一个文件）');
  });

  test('未登记的服务商仍然不命中（→ unsupported，不静默伪造 0）', () => {
    assert.equal(matchBalanceProvider('unregistered-provider'), undefined);
    assert.equal(matchBalanceProvider('opencode'), undefined, 'Zen 按量版（opencode）与 Go 是两个 id，前者无用量接口');
  });
});

describe('parseCommandCode —— 真实 GOAT 报文', () => {
  test('空闲窗口（resetAt: 0）：占位重置时间被丢弃，月度重置取订阅周期末', () => {
    const data = dataOf(parseCommandCode(GOAT_CREDITS, GOAT_SUBSCRIPTION, GOAT_SUMMARY, 'commandcode'));
    assert.equal(data.monthly, 0);
    assert.equal(data.monthlyCapUsd, 70, '月度池 = 当期消耗 0 + 剩余 70');
    assert.equal(data.monthlyResetsAt, '2026-10-13T01:01:27.000Z');
    assert.equal(data.rolling, 0);
    assert.equal(data.rollingCapUsd, 14);
    assert.equal(data.weekly, 0);
    assert.equal(data.weeklyCapUsd, 35);
    assert.equal(data.rollingResetsAt, undefined, 'resetAt: 0 是占位值，不能变成 1970 年重置时间');
    assert.equal(data.weeklyResetsAt, undefined);
  });

  test('有消耗：5h/周按 used/cap，月度按 消耗/(消耗+剩余)，字符串重置时间原样保留', () => {
    // windowLimits 嵌在 credits 内的旧变体：同样要认（实际报文在 credits 同级）
    const credits = {
      credits: {
        monthlyCredits: 12.5,
        purchasedCredits: 3,
        freeCredits: 0.5,
        windowLimits: {
          limited: true,
          fiveHour: { used: 4, cap: 14, resetAt: '2026-09-12T18:00:00.000Z' },
          weekly: { used: 12, cap: 40, resetAt: '2026-09-16T00:00:00.000Z' },
        },
      },
    };
    const subscription = { data: { currentPeriodEnd: '2026-10-01T00:00:00.000Z' } };
    const data = dataOf(parseCommandCode(credits, subscription, { totalCost: 7 }, 'commandcode'));

    assertClose(data.rolling, (4 / 14) * 100, '5h 窗口');
    assertClose(data.weekly, (12 / 40) * 100, '周窗口');
    assertClose(data.monthly, (7 / 23) * 100, '月度：消耗 7 /（7 + 16）');
    assert.equal(data.monthlyCapUsd, 23);
    assert.equal(data.rollingResetsAt, '2026-09-12T18:00:00.000Z');
    assert.equal(data.weeklyResetsAt, '2026-09-16T00:00:00.000Z');
    assert.equal(data.monthlyResetsAt, '2026-10-01T00:00:00.000Z');
  });

  test('无窗口限制（limited: false）：只有月度窗，不拿 5h/周充数', () => {
    const credits = {
      credits: { monthlyCredits: 0, purchasedCredits: 18.25, freeCredits: 0 },
      windowLimits: { limited: false },
    };
    const data = dataOf(parseCommandCode(credits, undefined, { totalCost: 0 }, 'commandcode'));
    assert.equal(data.monthly, 0);
    assert.equal(data.monthlyCapUsd, 18.25);
    assert.equal(data.rolling, undefined);
    assert.equal(data.weekly, undefined);
    assert.equal(data.rollingCapUsd, undefined);
    assert.equal(data.weeklyCapUsd, undefined);
    assert.equal(data.monthlyResetsAt, undefined, '订阅缺失 → 没有重置倒计时，但不编一个出来');
  });

  test('cap 为 0 / used 缺失的窗口跳过，不影响其余窗口', () => {
    const credits = {
      credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        limited: true,
        fiveHour: { used: 1, cap: 0 },
        weekly: { cap: 10 },
      },
    };
    const data = dataOf(parseCommandCode(credits, undefined, { totalCost: 1 }, 'commandcode'));
    assert.equal(data.rolling, undefined, 'cap 为 0 的窗口不算（不是"已用 0%"）');
    assert.equal(data.weekly, undefined, 'used 缺失的窗口不算');
  });

  test('数字重置时间：秒级/毫秒级时间戳都转成 ISO', () => {
    const credits = {
      credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        limited: true,
        fiveHour: { used: 1, cap: 10, resetAt: 1790000000 },
        weekly: { used: 1, cap: 10, resetAt: 1790000000000 },
      },
    };
    const data = dataOf(parseCommandCode(credits, undefined, { totalCost: 0 }, 'commandcode'));
    assert.equal(data.rollingResetsAt, new Date(1790000000 * 1000).toISOString());
    assert.equal(data.weeklyResetsAt, new Date(1790000000000).toISOString());
  });

  test('负用量（无意义数据）按「未消耗」读：不产生负百分比（档位索引会越界）', () => {
    const credits = {
      credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: { limited: true, fiveHour: { used: -3, cap: 14 } },
    };
    const data = dataOf(parseCommandCode(credits, undefined, { totalCost: 0 }, 'commandcode'));
    assert.equal(data.rolling, 0);
  });
});

describe('parseCommandCode —— 必填缺失/非法一律抛错（绝不伪造 0）', () => {
  test('缺少 credits → 抛错', () => {
    assert.throws(() => parseCommandCode({}, undefined, { totalCost: 0 }, 'commandcode'), /credits/);
  });

  test('credits 里三个额度字段全缺 → 抛错（否则分母当 0 会算出「已用 100%」）', () => {
    assert.throws(() => parseCommandCode({ credits: {} }, undefined, { totalCost: 0 }, 'commandcode'), /额度字段/);
  });

  test('缺少 / 非法 totalCost → 抛错', () => {
    const credits = { credits: { monthlyCredits: 1, purchasedCredits: 0, freeCredits: 0 } };
    assert.throws(() => parseCommandCode(credits, undefined, {}, 'commandcode'), /totalCost/);
    assert.throws(() => parseCommandCode(credits, undefined, { totalCost: 'abc' }, 'commandcode'), /totalCost/);
  });

  test('订阅接口的响应非法不是致命错（可选信息：只影响月度重置倒计时）', () => {
    const credits = { credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 } };
    for (const subscription of [undefined, {}, { data: null }, { data: { currentPeriodEnd: 0 } }]) {
      const data = dataOf(parseCommandCode(credits, subscription, { totalCost: 0 }, 'commandcode'));
      assert.equal(data.monthlyResetsAt, undefined);
    }
  });
});

describe('queryBalance —— 网络链路（fetch stub）', () => {
  test('四个接口按序请求，Bearer 注入，orgId / since 正确回填', async () => {
    const stub = stubFetch(goatRoute);
    const refs: string[] = [];
    try {
      const result = await queryBalance('commandcode', async (ref) => {
        refs.push(ref);
        return 'k-123';
      });
      assert.equal(result.ok, true);
      assert.deepEqual(stub.calls, [
        'https://api.commandcode.ai/alpha/whoami?limits=1',
        'https://api.commandcode.ai/alpha/billing/credits?orgId=org-1',
        'https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org-1',
        'https://api.commandcode.ai/alpha/usage/summary?since=2026-09-13T01%3A01%3A27.000Z&orgId=org-1',
      ]);
      assert.deepEqual([...new Set(stub.auths)], ['Bearer k-123']);
      assert.deepEqual(refs, ['COMMANDCODE_API_KEY']);
    } finally {
      stub.restore();
    }
  });

  test('whoami 里没有 org → 后续请求不带 orgId（不硬塞空值）', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('/alpha/whoami')) return res({ success: true, user: { id: 'u-1' } });
      return goatRoute(url);
    });
    try {
      const result = await queryBalance('commandcode', async () => 'k');
      assert.equal(result.ok, true);
      assert.equal(stub.calls[1], 'https://api.commandcode.ai/alpha/billing/credits');
      assert.equal(stub.calls[2], 'https://api.commandcode.ai/alpha/billing/subscriptions');
      assert.equal(
        stub.calls[3],
        'https://api.commandcode.ai/alpha/usage/summary?since=2026-09-13T01%3A01%3A27.000Z',
        'orgId 没有就不带，但订阅拿到的当期起始时间照常带（since）',
      );
    } finally {
      stub.restore();
    }
  });

  test('订阅接口失败（按量付费账号可能没有订阅）→ 仍然成功，只是没有重置倒计时', async () => {
    const stub = stubFetch((url) => (url.includes('/alpha/billing/subscriptions') ? res({}, 500) : goatRoute(url)));
    try {
      const result = await queryBalance('commandcode', async () => 'k');
      const data = dataOf(result);
      assert.equal(data.monthlyResetsAt, undefined);
      assert.equal(data.rollingCapUsd, 14, '三个窗口的百分比与额度一个都不少');
      assert.equal(
        stub.calls[3],
        'https://api.commandcode.ai/alpha/usage/summary?orgId=org-1',
        '没拿到当期起始时间就不带 since（默认区间由服务端决定，插件不猜）',
      );
    } finally {
      stub.restore();
    }
  });

  test('401 → fetch-error，错误信息带接口路径与状态码（不退化成「未支持」）', async () => {
    const stub = stubFetch(() => res({ error: { code: 'UNAUTHORIZED' } }, 401));
    try {
      assert.deepEqual(await queryBalance('commandcode', async () => 'bad-key'), {
        ok: false,
        provider: 'commandcode',
        reason: 'fetch-error',
        message: 'commandcode /alpha/whoami HTTP 401',
      });
    } finally {
      stub.restore();
    }
  });

  test('缺凭证 → credential-missing，且一个请求都不发', async () => {
    const stub = stubFetch(goatRoute);
    try {
      assert.deepEqual(await queryBalance('commandcode', async () => undefined), {
        ok: false,
        provider: 'commandcode',
        reason: 'credential-missing',
        message: '缺少凭证 COMMANDCODE_API_KEY',
      });
      assert.deepEqual(stub.calls, []);
    } finally {
      stub.restore();
    }
  });

  test('未登记的服务商 → unsupported，且一个请求都不发', async () => {
    const stub = stubFetch(goatRoute);
    let asked = 0;
    try {
      assert.deepEqual(
        await queryBalance('unregistered-provider', async () => {
          asked += 1;
          return 'k';
        }),
        { ok: false, provider: 'unregistered-provider', reason: 'unsupported' },
      );
      assert.equal(asked, 0, '未登记的服务商连凭证都不该去解析');
      assert.deepEqual(stub.calls, []);
    } finally {
      stub.restore();
    }
  });
});

describe('deepseek-account —— DSH 账号路由（走账号服务，不是 HTTP + API Key）', () => {
  /** 真实 `AccountDetails['balance']` 形状：ready 带 value（充值）/ bonusWallets（赠送）两个钱包数组 */
  const READY = {
    status: 'ready' as const,
    value: [{ currency: 'CNY', balance: '8.79' }],
    bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
  };

  test('provider id 命中 deepseek-account，shape 与 deepseek-official 相同，凭证模式为 none（无 API Key）', () => {
    const def = matchBalanceProvider('deepseek-account');
    assert.deepEqual(def?.ids, ['deepseek-account']);
    assert.deepEqual(def?.credential, { mode: 'none' }, '账号路由没有 API Key，凭证由账号服务持有');
    assert.equal(typeof def?.fetch, 'function');
  });

  test('ready：total = 充值 + 赠送（与官方 total_balance 同构），两者分别进 toppedUp / granted', () => {
    const r = parseAccountBalance(READY, 'deepseek-account');
    assert.ok(r.ok && r.shape === 'money');
    assert.equal(r.provider, 'deepseek-account');
    assert.deepEqual(
      { ...r.data, tier: undefined }, // 峰/谷随时间变化，这里不钉它的值
      {
        currency: 'CNY',
        total: '13.79',
        granted: '5.00',
        toppedUp: '8.79',
        fullBalance: '20',
        tier: undefined,
      },
    );
    assert.ok(r.data.tier === 'peak' || r.data.tier === 'idle', '档位由服务商算好后随数据带出');
  });

  test('没有赠送钱包 → granted 为 0.00，total 等于充值（不因缺赠送而漏算或虚增）', () => {
    const r = parseAccountBalance(
      { status: 'ready', value: [{ currency: 'CNY', balance: '8.79' }] },
      'deepseek-account',
    );
    assert.ok(r.ok && r.shape === 'money');
    assert.equal(r.data.total, '8.79');
    assert.equal(r.data.granted, '0.00');
    assert.equal(r.data.toppedUp, '8.79');
  });

  test('USD 钱包：币种原样带出（展示层据此选符号），金额不做换算', () => {
    const r = parseAccountBalance(
      { status: 'ready', value: [{ currency: 'USD', balance: '12.5' }], bonusWallets: [] },
      'deepseek-account',
    );
    assert.ok(r.ok && r.shape === 'money');
    assert.equal(r.data.currency, 'USD');
    assert.equal(r.data.total, '12.50');
  });

  test('真实平台精度串（16 位小数）→ 收敛到两位，与官方路由的 ¥8.79 风格一致', () => {
    const r = parseAccountBalance(
      {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '9.9902690000000000' }],
        bonusWallets: [{ currency: 'CNY', balance: '0' }],
      },
      'deepseek-account',
    );
    assert.ok(r.ok && r.shape === 'money');
    assert.equal(r.data.total, '9.99');
    assert.equal(r.data.granted, '0.00');
  });

  test('赠送钱包币种不同 → 不硬配（granted 记 0.00，不拿另一种币种凑数）', () => {
    const r = parseAccountBalance(
      {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '8.79' }],
        bonusWallets: [{ currency: 'USD', balance: '1' }],
      },
      'deepseek-account',
    );
    assert.ok(r.ok && r.shape === 'money');
    assert.equal(r.data.granted, '0.00');
    assert.equal(r.data.total, '8.79');
  });

  test('null（未登录）/ failed（查询失败）/ 空钱包 → 一律抛错，绝不伪造 0 余额', () => {
    assert.throws(() => parseAccountBalance(null, 'deepseek-account'), /未登录/);
    assert.throws(() => parseAccountBalance(undefined, 'deepseek-account'), /未登录/);
    assert.throws(() => parseAccountBalance({ status: 'failed' }, 'deepseek-account'), /查询失败/);
    assert.throws(
      () => parseAccountBalance({ status: 'ready', value: [], bonusWallets: [] }, 'deepseek-account'),
      /没有充值钱包/,
    );
    assert.throws(
      () => parseAccountBalance({ status: 'ready', value: [{ currency: 'CNY', balance: '' }] }, 'deepseek-account'),
      /非法|balance/,
    );
    assert.throws(
      () => parseAccountBalance({ status: 'ready', value: [{ currency: 'CNY', balance: 'abc' }] }, 'deepseek-account'),
      /非法/,
    );
  });

  test('queryBalance：账号路由不去解析凭证、不发任何 HTTP，只调 resolveAccount', async () => {
    const stub = stubFetch(goatRoute);
    let asked = 0;
    try {
      const r = await queryBalance(
        'deepseek-account',
        async () => {
          asked += 1;
          return 'should-not-be-used';
        },
        async () => READY,
      );
      assert.ok(r.ok && r.shape === 'money');
      assert.equal(r.data.total, '13.79', '与 parseAccountBalance 同一口径：赠送 5.00 + 充值 8.79');
      assert.equal(asked, 0, '账号路由没有 API Key 可解析');
      assert.deepEqual(stub.calls, [], '账号路由不走 fetch');
    } finally {
      stub.restore();
    }
  });

  test('queryBalance：账号服务不在场（未注入）→ credential-missing，不退化成 unsupported', async () => {
    assert.deepEqual(await queryBalance('deepseek-account', async () => 'k'), {
      ok: false,
      provider: 'deepseek-account',
      reason: 'credential-missing',
      message: '缺少账号服务（deepseek-account）',
    });
  });

  test('queryBalance：账号查询抛错 → fetch-error，错误信息透传', async () => {
    const r = await queryBalance(
      'deepseek-account',
      async () => 'k',
      async () => {
        throw new Error('dsh-pet: 账号余额查询失败');
      },
    );
    assert.deepEqual(r, {
      ok: false,
      provider: 'deepseek-account',
      reason: 'fetch-error',
      message: 'dsh-pet: 账号余额查询失败',
    });
  });
});

// ---------- moark —— fork 的默认余额来源（包装路由 modlens-moark） ----------
// 为什么单独有这一段：本机默认 provider 是 @liustack/modlens 铸造的包装路由 `modlens-moark`，
// 而余额表按 provider id 匹配——不做归一化整条路由会落 unsupported，连"有余额接口"都查不到。
// 另有一个「假 0」坑：moark 的资源包公开接口在未购资源包时返回 `{balance:0, details:[]}`，
// 那不是"余额为零"而是"没有资源包"，按余额展示就是伪造 0。

/** 合成：moark 控制台会员额度响应体（字段名照真实响应复刻；数字全部换成合成值） */
const MOARK_CONSOLE_BODY = {
  limited: true,
  total_quota: 4000.0,
  remaining_quota: 1200.0,
  period_month: '2026-09',
  base_quota: 2000.0,
  temporary_quota: 2000.0,
  used_quota: 2800.0,
};

/** 合成：moark 资源包公开接口——未购资源包时全 0，不是余额 */
const MOARK_PACKAGE_EMPTY_BODY = { total_amount: 0, used_amount: 0, balance: 0, details: [] };

describe('normalizeProviderRoute —— 包装路由归一化', () => {
  test('modlens-<upstream> 去掉包装前缀（当前默认路由 modlens-moark 就是这种）', () => {
    assert.equal(normalizeProviderRoute('modlens-moark'), 'moark');
    assert.equal(normalizeProviderRoute('modlens-opencode-go'), 'opencode-go');
  });

  test('deepseek-modlens 回落到 deepseek-official（历史 id，前缀规则覆盖不到）', () => {
    assert.equal(normalizeProviderRoute('deepseek-modlens'), 'deepseek-official');
  });

  test('普通路由原样返回', () => {
    assert.equal(normalizeProviderRoute('opencode-go'), 'opencode-go');
    assert.equal(normalizeProviderRoute('deepseek-official'), 'deepseek-official');
  });
});

describe('matchBalanceProvider —— 包装路由与别名命中', () => {
  test('modlens-moark 与 moark 本体命中同一个 moark 路由（本特性存在的理由）', () => {
    assert.equal(matchBalanceProvider('modlens-moark'), moark);
    assert.equal(matchBalanceProvider('moark'), moark);
  });

  test('deepseek 别名与 deepseek-official 命中同一个路由（DSH 里两条路由并存）', () => {
    assert.equal(matchBalanceProvider('deepseek'), matchBalanceProvider('deepseek-official'));
  });

  test('未登记的服务商返回 undefined（上层落 unsupported，不猜）', () => {
    assert.equal(matchBalanceProvider('openrouter'), undefined);
    assert.equal(matchBalanceProvider(''), undefined);
  });
});

describe('parseMoarkBalance —— 控制台额度与资源包（合成响应体）', () => {
  test('控制台额度：remaining_quota 是余额、total_quota 是基准（基准供档位折算用）', () => {
    assert.deepEqual(parseMoarkBalance(200, MOARK_CONSOLE_BODY), { total: '1200.00', baseline: '4000.00' });
  });

  test('资源包响应全 0 且无明细 = 没有资源包，不是余额 → undefined（绝不展示 ¥0.00）', () => {
    assert.equal(parseMoarkBalance(200, MOARK_PACKAGE_EMPTY_BODY), undefined);
  });

  test('资源包响应有真数字（或有明细）→ 采纳', () => {
    assert.deepEqual(parseMoarkBalance(200, { balance: 12.5, details: [{ id: 1 }] }), { total: '12.50' });
    assert.deepEqual(parseMoarkBalance(200, { balance: 12.5, details: [] }), { total: '12.50' });
  });

  test('legacy 字段 member_remaining_quota 兼容', () => {
    assert.deepEqual(parseMoarkBalance(200, { member_remaining_quota: 30 }), { total: '30.00' });
  });

  test('HTTP 非 200 / 结构非法 → undefined', () => {
    assert.equal(parseMoarkBalance(401, MOARK_CONSOLE_BODY), undefined);
    assert.equal(parseMoarkBalance(200, { unexpected: true }), undefined);
    assert.equal(parseMoarkBalance(200, null), undefined);
    assert.equal(parseMoarkBalance(200, { remaining_quota: 'abc' }), undefined);
  });
});

describe('moarkRequest —— 按凭证选端点', () => {
  test('有 cookie 走控制台端点：cookie 进 header，且不带 Authorization', () => {
    const spec = moarkRequest({ consoleCookie: 'session=abc' });
    assert.equal(spec.url, 'https://moark.com/api/base/oschina/member/quota');
    assert.equal(spec.headers.cookie, 'session=abc');
    assert.equal(new Headers(spec.headers).get('authorization'), null, 'Bearer 由 fetchWithRetry 统一注入，这里不该有');
  });

  test('无 cookie 回落资源包端点', () => {
    const spec = moarkRequest({ apiKey: 'k123' });
    assert.equal(spec.url, 'https://api.moark.com/v1/tokens/packages/balance');
    assert.equal(new Headers(spec.headers).get('authorization'), null);
  });
});

describe('queryBalance —— moark 凭证解析与显式失败', () => {
  test('cookie 优先：两 ref 都在时走控制台端点（真数字只在那里）', async () => {
    const stub = stubFetch(() => res(MOARK_CONSOLE_BODY));
    try {
      const result = await queryBalance('modlens-moark', async (ref) =>
        ref === 'MOARK_CONSOLE_COOKIE' ? 'cookie-abc' : ref === 'MOARK_API_KEY' ? 'key-abc' : undefined,
      );
      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0], 'https://moark.com/api/base/oschina/member/quota');
      assert.deepEqual(result, {
        ok: true,
        provider: 'modlens-moark',
        shape: 'money',
        data: { currency: 'CNY', total: '1200.00', fullBalance: '4000.00' },
      });
    } finally {
      stub.restore();
    }
  });

  test('只有 key：回落资源包端点，全 0 时落 fetch-error（显式失败，不伪造 ¥0）', async () => {
    const stub = stubFetch(() => res(MOARK_PACKAGE_EMPTY_BODY));
    try {
      const result = await queryBalance('moark', async (ref) => (ref === 'MOARK_API_KEY' ? 'key-abc' : undefined));
      assert.equal(result.ok, false);
      assert.equal(result.ok === false ? result.reason : '', 'fetch-error');
    } finally {
      stub.restore();
    }
  });

  test('两份凭证都缺 → credential-missing，且一次网络请求都不发', async () => {
    const stub = stubFetch(() => res(MOARK_CONSOLE_BODY));
    try {
      const result = await queryBalance('modlens-moark', async () => undefined);
      assert.equal(stub.calls.length, 0);
      assert.equal(result.ok === false ? result.reason : '', 'credential-missing');
    } finally {
      stub.restore();
    }
  });

  test('未登记服务商 → unsupported，不发请求', async () => {
    const stub = stubFetch(() => res(MOARK_CONSOLE_BODY));
    try {
      const result = await queryBalance('openrouter', async () => 'k');
      assert.equal(stub.calls.length, 0);
      assert.deepEqual(result, { ok: false, provider: 'openrouter', reason: 'unsupported' });
    } finally {
      stub.restore();
    }
  });

  test('HTTP 401 → fetch-error（带底层错误，绝不回退成 0）', async () => {
    const stub = stubFetch(() => res({ error: 'unauthorized' }, 401));
    try {
      const result = await queryBalance('modlens-moark', async (ref) =>
        ref === 'MOARK_CONSOLE_COOKIE' ? 'c' : undefined,
      );
      assert.equal(result.ok === false ? result.reason : '', 'fetch-error');
    } finally {
      stub.restore();
    }
  });
});
