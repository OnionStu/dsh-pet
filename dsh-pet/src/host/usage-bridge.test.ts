/**
 * dsh-usage overview 桥（可选增强，路线 B）的契约测试。
 *
 * 为什么不走 HANDOFF 原本的 b1（猴子补丁 `pet.announce`）/ b3（镜像上游 `/api/pet/state`）：
 *   - 当前默认 provider 是 `modlens-moark`（modlens 包装路由），而 dsh-usage 的 `adapterFor` 是
 *     **精确 id 匹配**（`PROVIDER_ADAPTERS.find(a => a.ids.includes(id))`），moark 适配器只登记了
 *     `moark` → 包装路由拿不到 snapshot，`announceCurrent` 落到 ledger 兜底，**只发用量、不发余额**。
 *     所以 b1/b3 在当前路由下根本给不出「moark ¥余额」。
 *   - `GET /api/dsh-usage/overview`（loopback-only 门禁、免 token）直接给结构化原始值：
 *     `providers[].balance.totalBalance` + `usage.today.providers[].totals`——比镜像公告字符串
 *     稳（无 80 字截断/无预格式化金额）、比读它的 JSON 文件稳（不耦合 version:1 存储格式）。
 *
 * 定位：**可选增强**。dsh-usage 是第三方插件，升级/被禁用都可能发生 → 任何失败都静默降级到
 * 本机折叠（usage-fold），绝不进关键路径。
 *
 * 夹具取自本机实测 overview（2026-09-18 13:34 快照；moark 与 modlens-moark 是两条独立记录，
 * 数字之和正好等于当日 totals，故夹具内部自洽）。
 */
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchOverview, overviewBalance, overviewTodayUsage } from './usage-bridge.ts';

/** 本机实测 overview 的精简版（结构与字段名逐字一致） */
const OVERVIEW = {
  updatedAt: <timestamp>,
  providers: [
    {
      provider: 'deepseek',
      displayName: 'deepseek',
      credential: 'env',
      supported: true,
      balanceSupported: true,
      balance: { currency: 'CNY', totalBalance: '36.04', updatedAt: <timestamp> },
    },
    {
      provider: 'moark',
      displayName: 'moark',
      credential: 'env',
      supported: true,
      balanceSupported: true,
      balance: { currency: 'CNY', totalBalance: '1255.20', updatedAt: <timestamp> },
    },
    { provider: 'modlens-moark', displayName: 'moark (modlens vision)', credential: 'none', supported: false },
  ],
  current: { provider: 'modlens-moark', model: 'deepseek-v4.1-flash', source: 'live' },
  usage: {
    today: {
      date: '2026-09-18',
      totals: {
        inputTokens: 5675505,
        outputTokens: 1136211,
        cacheReadTokens: <cacheReadTokens>,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        calls: 804,
        cost: 0,
      },
      providers: [
        {
          provider: 'moark',
          totals: {
            inputTokens: <inputTokens>,
            outputTokens: <outputTokens>,
            cacheReadTokens: <cacheReadTokens>,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            calls: 744,
            cost: 0,
          },
          models: [],
        },
        {
          provider: 'modlens-moark',
          totals: {
            inputTokens: <inputTokens>,
            outputTokens: <outputTokens>,
            cacheReadTokens: <cacheReadTokens>,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            calls: 60,
            cost: 0,
          },
          models: [],
        },
      ],
    },
    days: [],
  },
};

/** 临时替换全局 fetch；afterEach 恢复 */
function stubFetch(impl: (url: string) => Promise<Response> | Response): { urls: string[] } {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    return impl(String(input));
  }) as typeof globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });
  return { urls };
}

describe('overviewTodayUsage —— 抽某 family 的今日用量（含包装路由合并）', () => {
  test('moark + modlens-moark 两条记录相加（同一账号，切路由不跳变）', () => {
    assert.deepEqual(overviewTodayUsage(OVERVIEW, 'moark', '2026-09-18'), {
      tokens: <inputTokens> + <outputTokens> + <cacheReadTokens> + (<inputTokens> + <outputTokens> + <cacheReadTokens>),
      calls: 804,
    });
  });

  test('日期不匹配 → undefined（不把昨天的当今天）', () => {
    assert.equal(overviewTodayUsage(OVERVIEW, 'moark', '2026-09-17'), undefined);
  });

  test('没有该 family → undefined', () => {
    assert.equal(overviewTodayUsage(OVERVIEW, 'openrouter', '2026-09-18'), undefined);
  });

  test('结构不合法 → undefined（第三方结构变了就静默降级，不抛）', () => {
    assert.equal(overviewTodayUsage(null, 'moark', '2026-09-18'), undefined);
    assert.equal(overviewTodayUsage({}, 'moark', '2026-09-18'), undefined);
    assert.equal(overviewTodayUsage({ usage: {} }, 'moark', '2026-09-18'), undefined);
    assert.equal(overviewTodayUsage({ usage: { today: { date: '2026-09-18' } } }, 'moark', '2026-09-18'), undefined);
    assert.equal(
      overviewTodayUsage({ usage: { today: { date: '2026-09-18', providers: 'nope' } } }, 'moark', '2026-09-18'),
      undefined,
    );
  });
});

describe('overviewBalance —— 自探测不支持时的余额兜底', () => {
  test('moark 快照 → 金额（CNY）', () => {
    assert.deepEqual(overviewBalance(OVERVIEW, 'moark'), { currency: 'CNY', total: '1255.20' });
  });

  test('包装路由取上游账号的快照（modlens-moark → moark）——dsh-usage 自己做不到的一步', () => {
    assert.deepEqual(overviewBalance(OVERVIEW, 'modlens-moark'), { currency: 'CNY', total: '1255.20' });
  });

  test('没有该 family → undefined', () => {
    assert.equal(overviewBalance(OVERVIEW, 'openrouter'), undefined);
  });

  test('结构不合法 / 缺字段 → undefined', () => {
    assert.equal(overviewBalance(null, 'moark'), undefined);
    assert.equal(
      overviewBalance({ providers: [{ provider: 'moark', balance: { totalBalance: '' } }] }, 'moark'),
      undefined,
    );
    assert.equal(
      overviewBalance({ providers: [{ provider: 'moark', balance: { currency: 'CNY' } }] }, 'moark'),
      undefined,
    );
  });
});

describe('fetchOverview —— 可选增强，任何失败都静默降级', () => {
  test('loopback 拉取并解析 JSON', async () => {
    const { urls } = stubFetch(() => new Response(JSON.stringify(OVERVIEW), { status: 200 }));
    assert.deepEqual(await fetchOverview(3080), OVERVIEW);
    assert.deepEqual(urls, ['http://127.0.0.1:3080/api/dsh-usage/overview']);
  });

  test('HTTP 500 / 404 → undefined（dsh-usage 没挂或接口变了）', async () => {
    stubFetch(() => new Response('nope', { status: 500 }));
    assert.equal(await fetchOverview(3080), undefined);
  });

  test('网络异常 → undefined（不抛给调用方）', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    assert.equal(await fetchOverview(3080), undefined);
  });

  test('响应不是 JSON → undefined', async () => {
    stubFetch(() => new Response('<html>', { status: 200 }));
    assert.equal(await fetchOverview(3080), undefined);
  });

  test('端口非法（0/undefined）→ undefined，且不发请求', async () => {
    const { urls } = stubFetch(() => new Response('{}', { status: 200 }));
    assert.equal(await fetchOverview(0), undefined);
    assert.equal(urls.length, 0);
  });
});
