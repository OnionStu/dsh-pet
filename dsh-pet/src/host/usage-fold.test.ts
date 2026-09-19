/**
 * 今日用量折叠（host 半侧）的契约测试。
 *
 * 为什么自己折叠而不读 dsh-usage 的台账文件：
 *   - 事实本来就在事件流里（`request/header`|`request/context` 给路由、`assistant/message`
 *     给 `data.usage`），host 已经为 work-status 订阅了同一条 `session/event`；
 *   - 不耦合第三方插件的存储格式（version:1）与 HTTP 契约——插件被禁用/升级都不影响本宠物；
 *   - 包装路由（modlens-moark）经同一套归一化自动归到上游 family，与余额匹配口径一致。
 * 代价：只活在内存里（宿主重启归零）——这正是「远端 dsh-usage 优先」的原因（见 mergeUsage）。
 *
 * 口径钉子：tokens = input + cacheRead + cacheWrite + output（**不含 reasoning**），
 * 与 dsh-usage 台账的 totalTokens 逐字一致——两个来源的数字必须能互相核对，不能各算各的。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createUsageFold, localDateKey, mergeUsage, totalTokens } from './usage-fold.ts';

/** 一次真实形态的调用用量 */
const USAGE = {
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 5000,
  cacheWriteTokens: 0,
  reasoningTokens: 7,
};

const headerEvent = (provider: string, model = 'm'): unknown => ({
  type: 'request/header',
  data: { header: { config: { provider, model } } },
});
const contextEvent = (provider: string, model = 'm'): unknown => ({
  type: 'request/context',
  data: { provider, model },
});
const messageEvent = (usage: unknown): unknown => ({ type: 'assistant/message', data: { usage } });

describe('localDateKey —— 按本机时区取日键', () => {
  test('用本地时间分量构造的时刻 → 本地日期', () => {
    assert.equal(localDateKey(new Date(2026, 8, 18, 13, 34).getTime()), '2026-09-18');
  });

  test('跨本地午夜就是两天（不是 UTC 天）', () => {
    assert.equal(localDateKey(new Date(2026, 8, 18, 23, 59).getTime()), '2026-09-18');
    assert.equal(localDateKey(new Date(2026, 8, 19, 0, 1).getTime()), '2026-09-19');
  });
});

describe('totalTokens —— 与 dsh-usage 台账同口径', () => {
  test('四类之和，不含 reasoningTokens', () => {
    assert.equal(totalTokens(USAGE), 6200);
  });

  test('缺字段按 0（老事件可能没有 cache 字段）', () => {
    assert.equal(totalTokens({ inputTokens: 10, outputTokens: 5 }), 15);
  });

  test('空用量 → 0', () => {
    assert.equal(totalTokens({}), 0);
  });
});

describe('createUsageFold —— 会话事件 → 本地日 × family 用量', () => {
  test('记路由 + 折叠一条用量', () => {
    const fold = createUsageFold(() => new Date(2026, 8, 18, 10, 0).getTime());
    fold.observe('s1', headerEvent('moark'));
    fold.observe('s1', messageEvent(USAGE));
    assert.deepEqual(fold.today('moark'), { tokens: 6200, calls: 1 });
  });

  test('包装路由归到上游 family（modlens-moark → moark）', () => {
    const fold = createUsageFold(() => new Date(2026, 8, 18, 10, 0).getTime());
    fold.observe('s1', headerEvent('modlens-moark'));
    fold.observe('s1', messageEvent(USAGE));
    assert.deepEqual(fold.today('moark'), { tokens: 6200, calls: 1 });
  });

  test('同一 family 的多条路由相加（切路由不该让数字跳变）', () => {
    const fold = createUsageFold(() => new Date(2026, 8, 18, 10, 0).getTime());
    fold.observe('s1', headerEvent('moark'));
    fold.observe('s1', messageEvent(USAGE));
    fold.observe('s2', headerEvent('modlens-moark'));
    fold.observe('s2', messageEvent(USAGE));
    assert.deepEqual(fold.today('moark'), { tokens: 12400, calls: 2 });
  });

  test('request/context 也记路由（两种事件都真实出现）', () => {
    const fold = createUsageFold(() => new Date(2026, 8, 18, 10, 0).getTime());
    fold.observe('s1', contextEvent('modlens-moark'));
    fold.observe('s1', messageEvent(USAGE));
    assert.deepEqual(fold.today('moark'), { tokens: 6200, calls: 1 });
  });

  test('未记路由的会话消息被忽略（宁可少算，也不落到错的 family）', () => {
    const fold = createUsageFold(() => new Date(2026, 8, 18, 10, 0).getTime());
    fold.observe('s1', messageEvent(USAGE));
    assert.deepEqual(fold.today('moark'), { tokens: 0, calls: 0 });
  });

  test('无 usage / usage 非对象 → 不计调用', () => {
    const fold = createUsageFold(() => new Date(2026, 8, 18, 10, 0).getTime());
    fold.observe('s1', headerEvent('moark'));
    fold.observe('s1', messageEvent(undefined));
    fold.observe('s1', messageEvent('nope'));
    fold.observe('s1', { type: 'turn/end' });
    assert.deepEqual(fold.today('moark'), { tokens: 0, calls: 0 });
  });

  test('只统计当天：跨本地日归零（不把昨天的算进今日）', () => {
    let now = new Date(2026, 8, 18, 23, 0).getTime();
    const fold = createUsageFold(() => now);
    fold.observe('s1', headerEvent('moark'));
    fold.observe('s1', messageEvent(USAGE));
    assert.deepEqual(fold.today('moark'), { tokens: 6200, calls: 1 });
    now = new Date(2026, 8, 19, 0, 30).getTime(); // 过零点
    assert.deepEqual(fold.today('moark'), { tokens: 0, calls: 0 });
  });

  test('无记录 → 0/0（气泡据此不留空行）', () => {
    const fold = createUsageFold();
    assert.deepEqual(fold.today('moark'), { tokens: 0, calls: 0 });
  });
});

describe('mergeUsage —— 单一数字，远端优先（重启不丢），绝不相加', () => {
  test('远端有 → 用远端，标 source=dsh-usage', () => {
    assert.deepEqual(mergeUsage({ tokens: 100, calls: 2 }, { tokens: 5000, calls: 744 }), {
      tokens: 5000,
      calls: 744,
      source: 'dsh-usage',
    });
  });

  test('远端缺失 → 用本机折叠，标 source=local', () => {
    assert.deepEqual(mergeUsage({ tokens: 100, calls: 2 }, undefined), { tokens: 100, calls: 2, source: 'local' });
  });

  test('两者都有且不同 → 取远端（不相加）', () => {
    assert.equal(mergeUsage({ tokens: 1, calls: 1 }, { tokens: 9, calls: 9 })?.tokens, 9);
  });

  test('都没有（或没有调用）→ undefined（气泡不留空行）', () => {
    assert.equal(mergeUsage(undefined, undefined), undefined);
    assert.equal(mergeUsage({ tokens: 0, calls: 0 }, undefined), undefined);
    assert.equal(mergeUsage(undefined, { tokens: 0, calls: 0 }), undefined);
  });
});
