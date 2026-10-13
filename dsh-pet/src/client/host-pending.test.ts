/**
 * client 浮层的审批/选择题数据源（./host-pending）单元测试 —— 钉住从 host /alerts
 * 派生行的纯规则：
 *   ① 当前会话的行不提醒（已经在看就别催）；
 *   ② 标签优先级：客户端列表 displayTitle > host 给的 label > 会话 id 前 8 位；
 *   ③ kind 收敛：approval 恒为 approval，question / plan-review 归「等你选择」一档；
 *   ④ 缺 sessionId / 缺 text 的行丢弃（绝不让一条坏数据毁掉整张卡）；
 *   ⑤ 签名与顺序无关、随内容变化（轮询端靠它避免无谓重渲染）。
 *
 * 跑法：node --experimental-strip-types --import ./scripts/test-register.mjs --test src/client/host-pending.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { derivePendingRows, pendingSignature, type HostPendingItem } from './host-pending.ts';

/** 造一条 host /alerts pending 项 */
const item = (over: Partial<HostPendingItem>): HostPendingItem => ({
  kind: 'question',
  sessionId: 's1',
  label: 'host-label',
  text: '等你选择 · 要不要删库？',
  ts: 1,
  ...over,
});

describe('derivePendingRows —— host /alerts 派生审批/选择题行', () => {
  test('当前会话的行被过滤，其余保留', () => {
    const rows = derivePendingRows([item({ sessionId: 'cur' }), item({ sessionId: 'other' })], {}, 'cur');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sessionId, 'other');
  });

  test('标签优先级：客户端 displayTitle > host label > id 前 8 位', () => {
    const withTitle = derivePendingRows(
      [item({ sessionId: 's1' })],
      { byId: { s1: { displayTitle: '修桌面端尺寸' } } },
      '',
    );
    assert.equal(withTitle[0].label, '修桌面端尺寸');
    const hostLabel = derivePendingRows([item({ sessionId: 's1', label: '来自host' })], {}, '');
    assert.equal(hostLabel[0].label, '来自host');
    const noLabel = derivePendingRows([item({ sessionId: 'abcdef1234567890', label: '' })], {}, '');
    assert.equal(noLabel[0].label, 'abcdef12');
  });

  test('kind 收敛：approval 保持，question 与 plan-review 归入「等你选择」一档', () => {
    const rows = derivePendingRows(
      [
        item({ kind: 'approval', text: '等你审批 · Bash' }),
        item({ kind: 'question' }),
        item({ kind: 'plan-review', text: '等你评审计划' }),
      ],
      {},
      '',
    );
    assert.deepEqual(
      rows.map((r) => r.kind),
      ['approval', 'question', 'question'],
    );
  });

  test('缺 sessionId 或缺 text 的行丢弃，且不抛错', () => {
    const junk: HostPendingItem[] = [
      item({ sessionId: '' }),
      item({ text: '' }),
      null,
      'junk',
      { kind: 'question', sessionId: 's1', text: 'ok' },
    ] as unknown as HostPendingItem[];
    const rows = derivePendingRows(junk, {}, '');
    assert.deepEqual(
      rows.map((r) => r.text),
      ['ok'],
    );
  });
});

describe('pendingSignature —— 轮询签名', () => {
  test('与顺序无关，且随内容变化', () => {
    const a = [item({ sessionId: 's1', ts: 1 }), item({ sessionId: 's2', ts: 2 })];
    const b = [item({ sessionId: 's2', ts: 2 }), item({ sessionId: 's1', ts: 1 })];
    assert.equal(pendingSignature(a), pendingSignature(b));
    const c = [item({ sessionId: 's1', ts: 1 }), item({ sessionId: 's1', text: '等你选择 · 换一个问题', ts: 3 })];
    assert.notEqual(pendingSignature(a), pendingSignature(c));
  });
});
