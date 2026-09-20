/**
 * client 「需要重启宿主」提醒单元测试 —— 钉住四件事：
 *   ① 派生：**不过滤当前会话**（与审批提醒相反，这是本功能的核心语义差异）；
 *      理由截断 / 空白归一；会话标题缺失时退化为 id 前 8 位；
 *   ② 签名：只在集合真变化时才变（轮询靠它决定要不要重渲染）；
 *   ③ 轮询：签名守卫 + **resync 兜底**（乐观移除后 POST 失败时，卡片必须还能回来）；
 *   ④ 不碰 DOM：本文件不引 jsdom、不伪造 window——纯逻辑能在这里跑起来本身就是证明。
 *
 * 跑法：node --experimental-strip-types --test src/client/restart-notice.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  REASON_MAX,
  deriveRestartRows,
  noticesSignature,
  startRestartNotices,
  truncateReason,
} from './restart-notice.ts';

const list = {
  current: 'sess-1',
  byId: { 'sess-1': { displayTitle: '当前会话' }, 'sess-2': { displayTitle: '改插件的会话' } },
};

describe('deriveRestartRows —— 派生提醒行', () => {
  test('当前会话也提醒（与审批提醒的过滤相反：重启提醒的价值是「别忘」）', () => {
    const rows = deriveRestartRows([{ sessionId: 'sess-1', reason: '改了 client.js', ts: 1 }], list);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.sessionId, 'sess-1');
    assert.equal(rows[0]?.label, '当前会话');
  });

  test('文案 = 「需要重启 DSH · 理由」，kind=restart，key=会话 id', () => {
    const rows = deriveRestartRows([{ sessionId: 'sess-2', reason: '改了 client.js', ts: 1 }], list);
    assert.equal(rows[0]?.text, '需要重启 DSH · 改了 client.js');
    assert.equal(rows[0]?.kind, 'restart');
    assert.equal(rows[0]?.key, 'sess-2');
  });

  test('空理由 → 文案退化为纯「需要重启 DSH」（不出现孤零零的分隔点）', () => {
    const rows = deriveRestartRows([{ sessionId: 'sess-2', reason: '', ts: 1 }], list);
    assert.equal(rows[0]?.text, '需要重启 DSH');
  });

  test('会话标题缺失 → 退化为会话 id 前 8 位', () => {
    const rows = deriveRestartRows([{ sessionId: 'abcdefghijkl', reason: 'x', ts: 1 }], { byId: {} });
    assert.equal(rows[0]?.label, 'abcdefgh');
  });

  test('缺 sessionId 的脏数据被跳过（不渲染无归属的卡片）', () => {
    const rows = deriveRestartRows(
      [
        { sessionId: '', reason: 'x', ts: 1 },
        { sessionId: 'sess-2', reason: 'y', ts: 2 },
      ],
      list,
    );
    assert.deepEqual(
      rows.map((r) => r.sessionId),
      ['sess-2'],
    );
  });

  test('空输入 → 空数组', () => {
    assert.deepEqual(deriveRestartRows([], list), []);
  });
});

describe('truncateReason —— 理由截断', () => {
  test('短理由原样返回', () => {
    assert.equal(truncateReason('改了 client.js'), '改了 client.js');
  });

  test('超长截断到 REASON_MAX 并加省略号', () => {
    const long = 'a'.repeat(REASON_MAX + 50);
    const out = truncateReason(long);
    assert.equal(out.length, REASON_MAX + 1);
    assert.ok(out.endsWith('…'));
  });

  test('换行/连续空白归一为单空格（卡片是提醒，不是日志）', () => {
    assert.equal(truncateReason('改了\n\n  client.js\t重启'), '改了 client.js 重启');
  });

  test('前后空白被裁掉', () => {
    assert.equal(truncateReason('  改了 client.js  '), '改了 client.js');
  });
});

describe('noticesSignature —— 轮询重渲染的判据', () => {
  test('同集合（不同顺序）→ 同签名（不因顺序抖动而重渲染）', () => {
    const a = noticesSignature([
      { sessionId: 's1', reason: 'a', ts: 1 },
      { sessionId: 's2', reason: 'b', ts: 2 },
    ]);
    const b = noticesSignature([
      { sessionId: 's2', reason: 'b', ts: 2 },
      { sessionId: 's1', reason: 'a', ts: 1 },
    ]);
    assert.equal(a, b);
  });

  test('新增 / 移除 / ts 变化 → 签名变化', () => {
    const base = noticesSignature([{ sessionId: 's1', reason: 'a', ts: 1 }]);
    assert.notEqual(base, noticesSignature([]));
    assert.notEqual(base, noticesSignature([{ sessionId: 's1', reason: 'a', ts: 2 }]));
    assert.notEqual(
      base,
      noticesSignature([
        { sessionId: 's1', reason: 'a', ts: 1 },
        { sessionId: 's2', reason: 'b', ts: 2 },
      ]),
    );
  });

  test('理由文本变化**不**改签名（同一会话覆盖理由时 ts 会一起变，靠 ts 判定）', () => {
    const a = noticesSignature([{ sessionId: 's1', reason: 'a', ts: 1 }]);
    const b = noticesSignature([{ sessionId: 's1', reason: 'b', ts: 1 }]);
    assert.equal(a, b);
  });

  test('空集合 → 空串（与"从未拉到数据"的初始基线一致）', () => {
    assert.equal(noticesSignature([]), '');
  });
});

// ---------- 轮询：签名守卫 + resync（乐观移除后的兜底） ----------
// 这里钉的是一个**实现过程中真实修掉的 bug**：卡片 × 走「乐观移除 + POST」，POST 失败时
// host 仍留着那条提醒，而签名（sessionId@ts）没变 → 没有 resync 的话轮询永远不再回调，
// **卡片静默消失、提醒丢了**。

describe('startRestartNotices —— 轮询语义', () => {
  /** 可编程的 fetch 桩：返回指定 items（模拟 host 端点） */
  const stubFetch = (items: () => unknown): (() => void) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, items: items() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  };

  /** 等到 predicate 为真（5ms 一探、超时即失败）——避免用固定 sleep 造成时序抖动 */
  const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('waitFor 超时');
      await new Promise((r) => globalThis.setTimeout(r, 5));
    }
  };

  test('首次拉到数据即回调；签名不变时不再重复回调（不白刷 DOM）', async () => {
    const items = [{ sessionId: 's1', reason: '改了 client.js', ts: 1 }];
    const restore = stubFetch(() => items);
    const ac = new AbortController();
    let called = 0;
    const poll = startRestartNotices(() => (called += 1), ac.signal, 10);
    try {
      await waitFor(() => called >= 1);
      const afterFirst = called;
      await new Promise((r) => globalThis.setTimeout(r, 80)); // 跑过好几拍
      assert.equal(called, afterFirst, '签名未变却重复回调了');
    } finally {
      poll.stop();
      ac.abort();
      restore();
    }
  });

  test('resync 让下一拍无条件重新回调（POST 失败时把卡片拉回来）', async () => {
    const items = [{ sessionId: 's1', reason: '改了 client.js', ts: 1 }];
    const restore = stubFetch(() => items);
    const ac = new AbortController();
    const batches: Array<Array<{ sessionId: string }>> = [];
    const poll = startRestartNotices((got) => batches.push(got as Array<{ sessionId: string }>), ac.signal, 10);
    try {
      await waitFor(() => batches.length >= 1);
      poll.resync(); // 模拟：乐观移除后 POST 失败，host 仍留着该提醒
      await waitFor(() => batches.length >= 2);
      assert.deepEqual(
        batches[1]?.map((i) => i.sessionId),
        ['s1'],
        'resync 后必须重新拿到 host 的真实状态',
      );
    } finally {
      poll.stop();
      ac.abort();
      restore();
    }
  });

  test('端点报错静默跳过：不回调、不抛（宿主未重启时装的是旧版、没有该端点）', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const ac = new AbortController();
    let called = 0;
    const poll = startRestartNotices(() => (called += 1), ac.signal, 10);
    try {
      await new Promise((r) => globalThis.setTimeout(r, 80));
      assert.equal(called, 0);
    } finally {
      poll.stop();
      ac.abort();
      globalThis.fetch = original;
    }
  });

  test('stop() 之后不再轮询', async () => {
    const items = [{ sessionId: 's1', reason: 'x', ts: 1 }];
    const restore = stubFetch(() => items);
    const ac = new AbortController();
    let called = 0;
    const poll = startRestartNotices(() => (called += 1), ac.signal, 10);
    try {
      await waitFor(() => called >= 1);
      poll.stop();
      const afterStop = called;
      await new Promise((r) => globalThis.setTimeout(r, 60));
      assert.equal(called, afterStop, 'stop() 之后仍在轮询');
    } finally {
      ac.abort();
      restore();
    }
  });
});
