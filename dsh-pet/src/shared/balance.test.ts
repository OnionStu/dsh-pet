/**
 * 余额「不可用」路径的契约测试：**必须有可见反馈**，且两端（浏览器 overlay / 桌面外壳）只走一份判定。
 *
 * 背景：`/dsh-pet-7340/balance` 对未登记的服务商返回 `{ ok:false, reason:'unsupported' }`（HTTP 200），
 * 客户端原本在渲染处硬性要求 `balance.ok`，且气泡只由「拉取成功」的 tick 驱动——于是未登记的服务商
 * （如 commandcode）**页面上完全没有任何反应**：不播动画、不弹气泡、连 console 都特意不打。
 * 现在改为：不可用时弹「文字说明」气泡；弹不弹由 src/shared 的 decideBalanceNotice 统一判定
 * （显式请求必弹；自动轮询仅在原因变化时弹一次），两端各自只负责把行数据画出来。
 *
 * 本文件把三件事钉住：
 *   ① 不可用状态的文案（含 provider/凭证名，且不留空行、不出现双重「缺少凭证」前缀）；
 *   ② 弹窗判定（显式 vs 自动、原因变化、ok 状态清零）；
 *   ③ 源码级守卫——客户端渲染不得再要求 balance.ok（有 React/DOM 依赖，只能读源码断言）。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  balanceBubbleNeedsWrap,
  balanceBubbleView,
  balancePercent,
  decideBalanceNotice,
  fetchBalanceState,
  formatTokens,
  type BalanceState,
} from './balance.ts';

/** 包内文件源码（守卫用；相对 src/shared/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 一次「自动轮询」后存档的提示 key（等价于调用方存下的 lastKey） */
const rememberedKey = (state: BalanceState): string | null => decideBalanceNotice(state, null, false).key;

const unsupported: BalanceState = { provider: 'commandcode', ok: false, reason: 'unsupported' };

describe('balanceBubbleView —— 不可用状态必须给出可读的文字说明', () => {
  test('unsupported：报出「不支持」+ 当前服务商 id（便于自查到底是谁）', () => {
    assert.deepEqual(balanceBubbleView(unsupported), [
      { role: 'error', text: '当前服务商暂不支持余额查询' },
      { role: 'sub', text: '当前服务商：commandcode' },
    ]);
  });

  test('credential-missing：host 的 message 已带前缀，不再叠加（无双重「缺少凭证」）', () => {
    const rows = balanceBubbleView({
      provider: 'deepseek-official',
      ok: false,
      reason: 'credential-missing',
      message: '缺少凭证 DEEPSEEK_API_KEY',
    });
    assert.deepEqual(rows, [
      { role: 'error', text: '缺少余额查询凭证' },
      { role: 'sub', text: '缺少凭证 DEEPSEEK_API_KEY' },
    ]);
    assert.equal(
      rows.filter((r) => r.text.includes('缺少凭证')).length,
      1,
      '「缺少凭证」只应出现一次（曾经是「缺少凭证：缺少凭证 X」）',
    );
  });

  test('fetch-error：主行固定文案 + 次要行为底层错误；message 缺失时不留空行', () => {
    assert.deepEqual(
      balanceBubbleView({ provider: 'deepseek-official', ok: false, reason: 'fetch-error', message: 'HTTP 401' }),
      [
        { role: 'error', text: '余额查询失败' },
        { role: 'sub', text: 'HTTP 401' },
      ],
    );
    assert.deepEqual(balanceBubbleView({ provider: 'deepseek-official', ok: false, reason: 'fetch-error' }), [
      { role: 'error', text: '余额查询失败' },
    ]);
  });

  test('成功路径不受影响（opencode 两行 / deepseek 单行含峰谷档位）', () => {
    // 取三窗口里最紧迫（剩余最少）的那个：weekly 75% 剩余 7.5 USD 最少 → 「周额度已用 75%」
    const rows = balanceBubbleView({
      provider: 'opencode-go',
      ok: true,
      kind: 'opencode',
      rolling: 10,
      weekly: 75,
      monthly: 20,
    });
    assert.equal(rows[0]?.text, '周额度已用 75%');
    assert.equal(rows[1]?.role, 'sub');

    // 峰谷档位只对 DeepSeek 官方计价成立 → 由 family 决定（不是按 kind 猜）
    const ds = balanceBubbleView({
      provider: 'deepseek-official',
      family: 'deepseek-official',
      ok: true,
      kind: 'balance',
      total: '8.79',
    });
    assert.equal(ds[0]?.text, '余额（');
    assert.equal(ds[1]?.role, 'tier'); // 峰/谷随时间变化，这里只钉结构与金额
    assert.equal(ds[2]?.text, '）¥8.79');
  });
});

describe('decideBalanceNotice —— 弹不弹文字说明（两端共用同一份判定）', () => {
  test('ok 状态：不弹，并把 key 清零（下次不可用视为新原因）', () => {
    assert.deepEqual(
      decideBalanceNotice(
        { provider: 'opencode-go', ok: true, kind: 'opencode', rolling: 1, weekly: 2, monthly: 3 },
        'unsupported:commandcode',
        false,
      ),
      { show: false, key: null },
    );
  });

  test('自动轮询：首次不可用要弹（lastKey=null），同一原因再来一次不弹', () => {
    const first = decideBalanceNotice(unsupported, null, false);
    assert.deepEqual(first, { show: true, key: 'unsupported:commandcode' });
    assert.equal(decideBalanceNotice(unsupported, first.key, false).show, false, '同一原因不重复打扰');
  });

  test('自动轮询：原因变化再弹一次；换了另一个未登记的服务商也算变化', () => {
    assert.equal(decideBalanceNotice(unsupported, 'credential-missing:deepseek-official', false).show, true);
    assert.equal(
      decideBalanceNotice(
        { provider: 'openrouter', ok: false, reason: 'unsupported' },
        rememberedKey(unsupported),
        false,
      ).show,
      true,
    );
  });

  test('显式请求（/balance、桌面「查看余额」）：一律弹，不受去重影响', () => {
    assert.equal(decideBalanceNotice(unsupported, rememberedKey(unsupported), true).show, true);
  });
});

describe('源码守卫 —— 不可用状态不得再被静默丢掉', () => {
  test('浏览器 overlay：渲染处不许再要求 balance.ok，且由 noticeTick 驱动气泡、判定来自 shared', () => {
    const clientPet = readSource('../client/pet.ts');
    assert.ok(
      !/balance\.ok\s*&&\s*cfg\.balanceEnabled/.test(clientPet),
      '余额气泡不得再要求 balance.ok：那是「未登记服务商完全没反应」的根因，文字说明走同一个气泡',
    );
    assert.ok(/balanceNoticeTick/.test(clientPet), '容器必须把「该提示不可用原因」传给各宠物');
    assert.ok(/decideBalanceNotice/.test(clientPet), '弹窗判定必须来自 src/shared（两端同一份），不得各写一份');
  });

  test('桌面外壳：同一条判定 + 不可用也走气泡渲染（不再只写 console）', () => {
    const events = readSource('../../runtime/electron-helper/events.js');
    const sprite = readSource('../../runtime/electron-helper/sprite.js');
    assert.ok(
      /S\.decideBalanceNotice/.test(events),
      '桌面轮询必须调用同一份判定（shared-core 的 S.decideBalanceNotice）',
    );
    assert.ok(
      /showBalanceNotice/.test(events) && /showBalanceNotice/.test(sprite),
      '桌面必须有不可用的气泡渲染路径（showBalanceNotice），不能只 console.error',
    );
  });
});

// ---------- 换行变体判定（两端同一份）----------
// 背景：金额气泡新增「今日用量」副行后是**两行**，而余额气泡默认 white-space:nowrap
// （多行会顶出宠物宽度）。原来两端各自硬编码「不可用才换行」，这次统一成一份判定。

describe('balanceBubbleNeedsWrap —— 换行变体判定', () => {
  test('不可用状态 → true（多行文字说明）', () => {
    assert.equal(balanceBubbleNeedsWrap({ provider: 'commandcode', ok: false, reason: 'unsupported' }), true);
  });

  test('金额 + 今日用量（两行）→ true', () => {
    assert.equal(
      balanceBubbleNeedsWrap({
        provider: 'modlens-moark',
        family: 'moark',
        ok: true,
        kind: 'balance',
        total: '1255.20',
        usage: { tokens: <tokens>, calls: 804 },
      }),
      true,
    );
  });

  test('金额单行（无用量）→ false（保持 nowrap 观感）', () => {
    assert.equal(
      balanceBubbleNeedsWrap({
        provider: 'modlens-moark',
        family: 'moark',
        ok: true,
        kind: 'balance',
        total: '1255.20',
      }),
      false,
    );
  });

  test('opencode 的两行（档位 + 重置）→ false（本来就窄，别改观感）', () => {
    assert.equal(
      balanceBubbleNeedsWrap({
        provider: 'opencode-go',
        ok: true,
        kind: 'opencode',
        rolling: 10,
        weekly: 75,
        monthly: 20,
        weeklyResetsAt: '2026-09-20T00:00:00Z',
      }),
      false,
    );
  });
});

describe('源码守卫 —— 换行变体判定不得两端各写一份', () => {
  test('浏览器 overlay：bubble.ts 用 shared 判定，不再写 state.ok 三元', () => {
    const bubble = readSource('../client/bubble.ts');
    assert.ok(/balanceBubbleNeedsWrap\(/.test(bubble), '换行变体必须来自 src/shared（两端同一份）');
    assert.ok(!/state\.ok\s*\?\s*''\s*:/.test(bubble), '金额气泡带用量副行时也是两行：不得再按 state.ok 硬编码换行');
  });

  test('桌面外壳：成功路径与不可用路径都用 S.balanceBubbleNeedsWrap，不得写死 balanceWrap', () => {
    const events = readSource('../../runtime/electron-helper/events.js');
    const hits = events.match(/S\.balanceBubbleNeedsWrap\(/g) ?? [];
    assert.ok(hits.length >= 2, '两条余额气泡路径都要用同一份判定（当前 ' + hits.length + ' 处）');
    assert.ok(!/this\.balanceWrap = (true|false);/.test(events), '不得再写死 balanceWrap');
  });
});
// 背景（2026-09-18）：余额数据源新增 moark family（当前默认 provider 是 modlens-moark 包装路由）。
// 金额型视图因此要能表达两件新事实：
//   ① 基准（baseline）——档位折算的满额值随探测结果下发，写死 ¥20 会让 ¥1255 的 moark 永远显示「已用 0%」；
//   ② 今日用量（usage）——气泡在金额下补一行「今日 N tokens · M 次调用」（与另一只宠物同口径）。

/** 临时替换全局 fetch；用完整 Response（shared 侧走真实 fetch 语义） */
function stubFetchOnce(body: unknown, status = 200): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe('formatTokens —— zh 紧凑计数（与 dsh-usage 的 note 同口径）', () => {
  test('万以下原样', () => {
    assert.equal(formatTokens(9805), '9805');
    assert.equal(formatTokens(0), '0');
  });

  test('万位/亿位紧凑成一位小数，整数不带 .0', () => {
    assert.equal(formatTokens(45123), '4.5万');
    assert.equal(formatTokens(20000), '2万');
    assert.equal(formatTokens(<tokens>), '1.1亿');
  });
});

describe('余额气泡 —— 金额形态带今日用量行', () => {
  test('非 DeepSeek 家族：金额单行 + 用量次行（没有峰谷计价，不摆峰/谷）', () => {
    assert.deepEqual(
      balanceBubbleView({
        provider: 'modlens-moark',
        family: 'moark',
        ok: true,
        kind: 'balance',
        total: '1255.20',
        baseline: '4000.00',
        usage: { tokens: <tokens>, calls: 804 },
      }),
      [
        { role: 'label', text: '余额 ¥<金额>' },
        { role: 'sub', text: '今日 1.1亿 tokens · 804 次调用' },
      ],
    );
  });

  test('DeepSeek 家族：保留峰谷档位（同一条内联）+ 用量次行', () => {
    const rows = balanceBubbleView({
      provider: 'deepseek-official',
      family: 'deepseek-official',
      ok: true,
      kind: 'balance',
      total: '36.04',
      baseline: '20.00',
      usage: { tokens: 9805, calls: 12 },
    });
    assert.equal(rows[0]?.text, '余额（');
    assert.equal(rows[1]?.role, 'tier');
    assert.equal(rows[2]?.text, '）¥<金额>');
    assert.deepEqual(rows[3], { role: 'sub', text: '今日 9805 tokens · 12 次调用' });
  });

  test('无用量 → 不出现空行（金额单行）', () => {
    assert.deepEqual(
      balanceBubbleView({ provider: 'modlens-moark', family: 'moark', ok: true, kind: 'balance', total: '1255.20' }),
      [{ role: 'label', text: '余额 ¥<金额>' }],
    );
  });
});

describe('balancePercent —— 基准随探测结果下发', () => {
  test('moark： ¥<金额>/ 基准 ¥4000 → 已用 68.6%（用写死的 ¥20 会算成 0%）', () => {
    const p = balancePercent({
      provider: 'modlens-moark',
      family: 'moark',
      ok: true,
      kind: 'balance',
      total: '1255.20',
      baseline: '4000.00',
    });
    assert.ok(p !== undefined && Math.abs(p - 68.62) < 0.01, 'p=' + String(p));
  });

  test('缺基准（老响应）→ 回落 DeepSeek 的 ¥20 基准', () => {
    const p = balancePercent({ provider: 'deepseek-official', ok: true, kind: 'balance', total: '8.79' });
    assert.ok(p !== undefined && Math.abs(p - 56.05) < 0.01, 'p=' + String(p));
  });

  test('余额超过基准（充值后）→ 0%（不出现负值）', () => {
    assert.equal(
      balancePercent({
        provider: 'modlens-moark',
        family: 'moark',
        ok: true,
        kind: 'balance',
        total: '9999',
        baseline: '4000',
      }),
      0,
    );
  });
});

describe('fetchBalanceState —— 解析 host 扩展字段', () => {
  test('金额形态：family / baseline / usage 进视图（含来源标记）', async () => {
    const restore = stubFetchOnce({
      ok: true,
      provider: 'modlens-moark',
      family: 'moark',
      kind: 'balance',
      source: 'probe',
      data: { currency: 'CNY', total: '1255.20', baseline: '4000.00' },
      usage: { tokens: <tokens>, calls: 804, source: 'dsh-usage' },
    });
    try {
      assert.deepEqual(await fetchBalanceState(), {
        provider: 'modlens-moark',
        family: 'moark',
        ok: true,
        kind: 'balance',
        currency: 'CNY',
        total: '1255.20',
        baseline: '4000.00',
        usage: { tokens: <tokens>, calls: 804 },
      });
    } finally {
      restore();
    }
  });

  test('老响应（kind deepseek、无 family/baseline/usage）仍可解析：family 回落 deepseek-official', async () => {
    const restore = stubFetchOnce({
      ok: true,
      provider: 'deepseek-official',
      kind: 'deepseek',
      data: { currency: 'CNY', total: '36.04' },
    });
    try {
      const state = await fetchBalanceState();
      assert.equal(state.ok, true);
      assert.equal(state.ok && state.kind, 'balance');
      assert.equal(state.ok && state.family, 'deepseek-official');
      assert.equal(state.ok && state.usage, undefined);
    } finally {
      restore();
    }
  });

  test('用量结构非法 → 当作没有（不显示半截数字）', async () => {
    const restore = stubFetchOnce({
      ok: true,
      provider: 'modlens-moark',
      family: 'moark',
      kind: 'balance',
      data: { total: '1255.20' },
      usage: { tokens: 'abc', calls: 0 },
    });
    try {
      const state = await fetchBalanceState();
      assert.equal(state.ok && state.usage, undefined);
    } finally {
      restore();
    }
  });
});
