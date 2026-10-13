/**
 * `/dsh-pet-7340/balance` 装配层的路由级测试：**自探测（A）+ dsh-usage 增强（B）的合并规则**。
 *
 * 为什么单测这一层：余额响应是三件事的合成结果——本机自探测、今日用量（远端台账 / 本机折叠）、
 * 以及自探测不支持时的快照兜底。合并规则错一条就会出现「伪造 0」「双倍计数」「拿旧快照顶替报错」
 * 这类只有用户肉眼才能发现的错，所以规则必须在装配层被钉住（而不是散在路由 handler 里）。
 *
 * 夹具是**合成数据**：字段名与形状照真实响应复刻，数字全部换成合成值——断言只依赖
 * 形状与自洽性，不依赖任何真实账户数字。
 */
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildBalancePayload, type BalanceRouteInput } from './balance-route.ts';

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 合成：moark 控制台会员额度响应体（字段名照真实响应的 MOARK_CONSOLE_COOKIE 端点复刻） */
const MOARK_CONSOLE_BODY = { total_quota: 4000.0, remaining_quota: 1200.0, used_quota: 2800.0 };
/** 合成：moark 资源包公开接口——未购资源包时全 0（这不是余额，须被假 0 防线拦下） */
const MOARK_PACKAGE_EMPTY_BODY = { total_amount: 0, used_amount: 0, balance: 0, details: [] };

/** dsh-usage overview 精简夹具（moark 快照 + 今日用量） */
const OVERVIEW = {
  providers: [
    { provider: 'moark', displayName: 'moark', balance: { currency: 'CNY', totalBalance: '1200.00' } },
    { provider: 'openrouter', displayName: 'openrouter', balance: { currency: 'USD', totalBalance: '7.50' } },
  ],
  usage: {
    today: {
      date: '',
      providers: [
        { provider: 'moark', totals: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5000, calls: 7 } },
      ],
    },
  },
};

/** 按 URL 分派的 fetch 桩；未命中的 URL 一律 404 */
function stubFetch(routes: Record<string, unknown>, missingStatus = 404): { urls: string[] } {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('nope', { status: missingStatus });
  }) as typeof globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });
  return { urls };
}

/** 构造装配层入参；用例只覆盖自己关心的字段 */
function input(overrides: Partial<BalanceRouteInput> = {}): BalanceRouteInput {
  return {
    provider: 'modlens-moark',
    resolveCredential: async (ref) => (ref === 'MOARK_CONSOLE_COOKIE' ? 'cookie-abc' : undefined),
    localUsage: { tokens: 0, calls: 0 },
    port: 3080,
    now: () => new Date(2026, 8, 18, 13, 34).getTime(),
    ...overrides,
  };
}

/** overview 夹具里的「今天」必须与 now 的本地日一致（否则用量会被日期校验挡掉） */
const overviewToday = (date: string): unknown => ({
  ...OVERVIEW,
  usage: { today: { ...OVERVIEW.usage.today, date } },
});

describe('buildBalancePayload —— 自探测成功（当前默认路由 modlens-moark）', () => {
  test('控制台额度真值 + 今日用量（远端优先，标注来源）', async () => {
    stubFetch({
      'https://moark.com/api/base/oschina/member/quota': MOARK_CONSOLE_BODY,
      'http://127.0.0.1:3080/api/dsh-usage/overview': overviewToday('2026-09-18'),
    });
    const result = await buildBalancePayload(input());
    assert.deepEqual(result, {
      ok: true,
      provider: 'modlens-moark',
      shape: 'money',
      source: 'probe',
      data: { currency: 'CNY', total: '1200.00', fullBalance: '4000.00' },
      usage: { tokens: 5120, calls: 7, source: 'dsh-usage' },
    });
  });

  test('dsh-usage 不可用（404）→ 本机折叠兜底，source=local，其余不变', async () => {
    stubFetch({ 'https://moark.com/api/base/oschina/member/quota': MOARK_CONSOLE_BODY });
    const result = await buildBalancePayload(input({ localUsage: { tokens: 6200, calls: 1 } }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.shape === 'money' ? result.usage : undefined, {
      tokens: 6200,
      calls: 1,
      source: 'local',
    });
  });

  test('本机折叠没有调用记录 → 不出现 usage 行（不留空行）', async () => {
    stubFetch({ 'https://moark.com/api/base/oschina/member/quota': MOARK_CONSOLE_BODY });
    const result = await buildBalancePayload(input());
    assert.equal(result.ok, true);
    assert.equal(result.ok && 'usage' in result, false);
  });

  test('opencode 形态不带 usage（窗口百分比气泡不需要 token 行）', async () => {
    stubFetch({
      'https://opencode.ai/zen/go/v1/usage': {
        usage: {
          rolling: { percent: 10, resetsAt: '2026-09-18T20:00:00Z' },
          weekly: { percent: 75, resetsAt: '2026-09-20T00:00:00Z' },
          monthly: { percent: 20, resetsAt: '2026-09-30T00:00:00Z' },
        },
      },
    });
    const result = await buildBalancePayload(
      input({
        provider: 'opencode-go',
        resolveCredential: async (ref) => (ref === 'OPENCODE_GO_API_KEY' ? 'k' : undefined),
        localUsage: { tokens: 6200, calls: 1 },
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.shape, 'windows');
    assert.equal(result.ok && 'usage' in result, false);
  });
});

describe('buildBalancePayload —— 余额兜底与显式失败', () => {
  test('自探测 unsupported + overview 有该 family 快照 → 用快照并标 dsh-usage', async () => {
    stubFetch({
      'http://127.0.0.1:3080/api/dsh-usage/overview': overviewToday('2026-09-18'),
      // 没有别的端点：openrouter 本来就无自探测
    });
    const result = await buildBalancePayload(input({ provider: 'openrouter' }));
    assert.deepEqual(result, {
      ok: true,
      provider: 'openrouter',
      shape: 'money',
      source: 'dsh-usage',
      data: { currency: 'USD', total: '7.50' },
    });
  });

  test('自探测 unsupported + overview 也没有该 family → 保持 unsupported（不编数字）', async () => {
    stubFetch({ 'http://127.0.0.1:3080/api/dsh-usage/overview': overviewToday('2026-09-18') });
    const result = await buildBalancePayload(input({ provider: 'not-a-real-route' }));
    assert.deepEqual(result, { ok: false, provider: 'not-a-real-route', reason: 'unsupported' });
  });

  test('缺凭证 → credential-missing（不拿快照顶替：那是显式配置问题，要报出来）', async () => {
    stubFetch({ 'http://127.0.0.1:3080/api/dsh-usage/overview': overviewToday('2026-09-18') });
    const result = await buildBalancePayload(input({ resolveCredential: async () => undefined }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'credential-missing');
  });

  test('资源包「假 0」→ fetch-error（绝不显示 ¥0.00）', async () => {
    stubFetch({ 'https://api.moark.com/v1/tokens/packages/balance': MOARK_PACKAGE_EMPTY_BODY });
    const result = await buildBalancePayload(
      input({ resolveCredential: async (ref) => (ref === 'MOARK_API_KEY' ? 'key-abc' : undefined) }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'fetch-error');
  });

  test('端口非法（0）→ 跳过 dsh-usage 增强，自探测照常', async () => {
    const { urls } = stubFetch({ 'https://moark.com/api/base/oschina/member/quota': MOARK_CONSOLE_BODY });
    const result = await buildBalancePayload(input({ port: 0 }));
    assert.equal(result.ok, true);
    assert.equal(
      urls.some((u) => u.includes('dsh-usage')),
      false,
    );
  });
});

describe('源码守卫 —— index.ts 必须真的接线（否则本特性不生效）', () => {
  const hostSource = (): string => readSource('./index.ts');

  test('会话事件流上挂了用量折叠（与 work-status 同一条 session/event）', () => {
    assert.ok(/createUsageFold\(/.test(hostSource()), 'host 必须创建用量折叠器');
    assert.ok(
      /usageFold\.observe\(\s*sessionId/.test(hostSource()),
      'session/event 监听里必须调用 usageFold.observe(sessionId, event)——否则今日用量恒为 0',
    );
  });

  test('余额路由走装配层（自探测 + 用量合并 + 兜底只在一处）', () => {
    assert.ok(/buildBalancePayload\(/.test(hostSource()), '余额路由必须调用 buildBalancePayload（规则不得散落重写）');
    assert.ok(/usageFold\.today\(/.test(hostSource()), '本机折叠的今日用量必须传进装配层');
  });
});
