/**
 * 余额适配器表与 family 归一化的契约测试。
 *
 * 为什么单独有这一层（2026-09-18 实测发现的两个坑）：
 *   ① **包装路由**：当前默认 provider 是 `modlens-moark`（@liustack/modlens 自动铸造的
 *      `modlens-<upstream>` 包装路由），而余额表按 id 精确匹配 → 直接落 `unsupported`，
 *      连"有余额接口的服务商"都查不到。归一化必须在这里做一次。
 *   ② **假 0**：moark 的资源包公开接口在未购资源包时返回 `{balance:0, details:[]}`——那不是
 *      "余额为零"，是"没有资源包"。把它当余额展示就是伪造 0，违反 balance.ts 的既有契约
 *      （未登记/取不到一律显式报错，绝不静默伪造数字）。
 *
 * 夹具是**合成数据**：字段名与形状照真实响应复刻，数字全部换成合成值——断言只依赖
 * 解析规则本身，不依赖任何真实账户数字，也不依赖网络。
 */
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BALANCE_ADAPTERS,
  matchBalanceProvider,
  normalizeProviderRoute,
  queryBalance,
  type BalanceAdapter,
} from './balance.ts';

/** 合成：moark 控制台会员额度响应体（MOARK_CONSOLE_COOKIE 端点；字段名照真实响应复刻） */
const MOARK_CONSOLE_BODY = {
  limited: true,
  total_quota: 4000.0,
  remaining_quota: 1200.0,
  period_month: '2026-09',
  base_quota: 2000.0,
  temporary_quota: 2000.0,
  used_quota: 2800.0,
};

/** 合成：moark 资源包公开接口（MOARK_API_KEY）——未购资源包时全 0，不是余额 */
const MOARK_PACKAGE_EMPTY_BODY = { total_amount: 0, used_amount: 0, balance: 0, details: [] };

/** 按 family 取适配器（表里没有就是测试自己写错了，直接炸） */
function adapter(family: string): BalanceAdapter {
  const found = BALANCE_ADAPTERS.find((a) => a.family === family);
  assert.ok(found, `适配器表缺少 family=${family}`);
  return found;
}

/** 临时替换全局 fetch，返回收集到的请求；afterEach 恢复 */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): {
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return impl(String(input), init);
  }) as typeof globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });
  return { calls };
}

/** 构造一个 Response（Node 18+ 内置） */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('normalizeProviderRoute —— 包装路由归一化', () => {
  test('modlens-<upstream> 去掉包装前缀（当前默认路由 modlens-moark 就是这种）', () => {
    assert.equal(normalizeProviderRoute('modlens-moark'), 'moark');
    assert.equal(normalizeProviderRoute('modlens-opencode-go'), 'opencode-go');
  });

  test('deepseek-modlens 回落到 deepseek-official（历史 id，不是 modlens- 前缀规则能覆盖的）', () => {
    assert.equal(normalizeProviderRoute('deepseek-modlens'), 'deepseek-official');
  });

  test('普通路由原样返回', () => {
    assert.equal(normalizeProviderRoute('opencode-go'), 'opencode-go');
    assert.equal(normalizeProviderRoute('deepseek-official'), 'deepseek-official');
  });
});

describe('matchBalanceProvider —— 按 family 命中适配器', () => {
  test('modlens-moark 命中 moark 适配器（本特性存在的理由）', () => {
    assert.equal(matchBalanceProvider('modlens-moark')?.family, 'moark');
  });

  test('moark 本体同样命中', () => {
    assert.equal(matchBalanceProvider('moark')?.family, 'moark');
  });

  test('deepseek 别名与 deepseek-official 命中同一个适配器（DSH 里两条路由并存）', () => {
    assert.equal(matchBalanceProvider('deepseek')?.family, 'deepseek-official');
    assert.equal(matchBalanceProvider('deepseek-official')?.family, 'deepseek-official');
  });

  test('未登记的服务商返回 undefined（上层落 unsupported，不猜）', () => {
    assert.equal(matchBalanceProvider('openrouter'), undefined);
    assert.equal(matchBalanceProvider(''), undefined);
  });
});

describe('moark 适配器 —— 解析（合成响应体，形状照真实响应）', () => {
  test('控制台额度：remaining_quota 是余额、total_quota 是基准（基准供档位折算用）', () => {
    assert.deepEqual(adapter('moark').parse(200, MOARK_CONSOLE_BODY), {
      currency: 'CNY',
      total: '1200.00',
      baseline: '4000.00',
    });
  });

  test('资源包响应全 0 且无明细 = 没有资源包，不是余额 → undefined（绝不展示 ¥0.00）', () => {
    assert.equal(adapter('moark').parse(200, MOARK_PACKAGE_EMPTY_BODY), undefined);
  });

  test('资源包响应有真数字（或有明细）→ 采纳', () => {
    assert.deepEqual(adapter('moark').parse(200, { balance: 12.5, details: [{ id: 1 }] }), {
      currency: 'CNY',
      total: '12.50',
    });
    assert.deepEqual(adapter('moark').parse(200, { balance: 12.5, details: [] }), {
      currency: 'CNY',
      total: '12.50',
    });
  });

  test('legacy 字段 member_remaining_quota 兼容', () => {
    assert.deepEqual(adapter('moark').parse(200, { member_remaining_quota: 30 }), {
      currency: 'CNY',
      total: '30.00',
    });
  });

  test('HTTP 非 200 / 结构非法 → undefined', () => {
    assert.equal(adapter('moark').parse(401, MOARK_CONSOLE_BODY), undefined);
    assert.equal(adapter('moark').parse(200, { unexpected: true }), undefined);
    assert.equal(adapter('moark').parse(200, null), undefined);
    assert.equal(adapter('moark').parse(200, { remaining_quota: 'abc' }), undefined);
  });

  test('控制台端点：cookie 进 header，且不打 Bearer', () => {
    const spec = adapter('moark').build({ consoleCookie: 'session=abc' });
    assert.equal(spec.url, 'https://moark.com/api/base/oschina/member/quota');
    assert.equal(spec.headers.cookie, 'session=abc');
    assert.equal(spec.headers.authorization, undefined);
  });

  test('无 cookie 时回落资源包端点：走 Bearer', () => {
    const spec = adapter('moark').build({ apiKey: 'k123' });
    assert.equal(spec.url, 'https://api.moark.com/v1/tokens/packages/balance');
    assert.equal(spec.headers.authorization, 'Bearer k123');
  });
});

describe('queryBalance —— 凭证解析与显式失败', () => {
  test('cookie 优先：两 ref 都在时走控制台端点（真数字只在那里）', async () => {
    const { calls } = stubFetch(async () => jsonResponse(MOARK_CONSOLE_BODY));
    const result = await queryBalance('modlens-moark', async (ref) =>
      ref === 'MOARK_CONSOLE_COOKIE' ? 'cookie-abc' : ref === 'MOARK_API_KEY' ? 'key-abc' : undefined,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://moark.com/api/base/oschina/member/quota');
    assert.deepEqual(result, {
      ok: true,
      provider: 'modlens-moark',
      family: 'moark',
      kind: 'balance',
      source: 'probe',
      data: { currency: 'CNY', total: '1200.00', baseline: '4000.00' },
    });
  });

  test('只有 key：回落资源包端点，全 0 时落 fetch-error（显式失败，不伪造 ¥0）', async () => {
    stubFetch(async () => jsonResponse(MOARK_PACKAGE_EMPTY_BODY));
    const result = await queryBalance('moark', async (ref) => (ref === 'MOARK_API_KEY' ? 'key-abc' : undefined));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'fetch-error');
  });

  test('两 ref 都缺 → credential-missing，且一次网络请求都不发', async () => {
    const { calls } = stubFetch(async () => jsonResponse(MOARK_CONSOLE_BODY));
    const result = await queryBalance('modlens-moark', async () => undefined);
    assert.equal(calls.length, 0);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'credential-missing');
  });

  test('未登记服务商 → unsupported，不发请求', async () => {
    const { calls } = stubFetch(async () => jsonResponse(MOARK_CONSOLE_BODY));
    const result = await queryBalance('openrouter', async () => 'k');
    assert.equal(calls.length, 0);
    assert.deepEqual(result, { ok: false, provider: 'openrouter', family: 'openrouter', reason: 'unsupported' });
  });

  test('HTTP 401 → fetch-error（带底层错误，绝不回退成 0）', async () => {
    stubFetch(async () => jsonResponse({ error: 'unauthorized' }, 401));
    const result = await queryBalance('modlens-moark', async (ref) =>
      ref === 'MOARK_CONSOLE_COOKIE' ? 'c' : undefined,
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'fetch-error');
  });
});
