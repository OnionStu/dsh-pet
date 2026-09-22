/**
 * client 提醒浮层「渲染计划」单元测试 —— 钉住重启折叠规则：
 *   ① 重启卡 >= RESTART_FOLD_MIN 时计划最前插入汇总行；折叠态（默认）重启行全部 compact；
 *   ② 展开态汇总行仍在（expanded=true，可再收起），重启行恢复完整渲染；
 *   ③ < 阈值不折叠、无汇总行；审批行永不折叠、恒排重启块之后；
 *   ④ 汇总行是导航不是条目：计划里 type='row' 的条数恒等于 重启 + 审批（角标语义）；
 *   ⑤ 纯函数不碰 DOM（与 restart-notice.test.ts 同约定：不引 jsdom、不伪造 window）。
 *
 * 跑法：node --experimental-strip-types --test src/client/approvals.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { planAlertRows, RESTART_FOLD_MIN, type ApprovalAlertRow } from './approvals.ts';
import type { RestartAlertRow } from './restart-notice.ts';

const restart = (sessionId: string): RestartAlertRow => ({
  key: sessionId,
  sessionId,
  label: '会话' + sessionId,
  text: '需要重启 DSH · 改了 client.js',
  kind: 'restart',
});

const approval = (sessionId: string): ApprovalAlertRow => ({
  key: sessionId + ':approval',
  sessionId,
  label: '会话' + sessionId,
  text: '等你审批 · some_tool',
  kind: 'approval',
});

describe('planAlertRows —— 重启折叠的渲染计划', () => {
  test('阈值钉死为 2（两张「需要重启 DSH」已经重复出戏）', () => {
    assert.equal(RESTART_FOLD_MIN, 2);
  });

  test('0 重启 + 1 审批：无汇总行，审批行不 compact', () => {
    const plan = planAlertRows([], [approval('s1')], false);
    assert.deepEqual(
      plan.map((e) => e.type),
      ['row'],
    );
    assert.equal(plan[0]?.type === 'row' && plan[0].compact, false);
  });

  test('1 张重启不折叠：无汇总行、完整渲染（阈值以下恒完整）', () => {
    for (const expanded of [false, true]) {
      const plan = planAlertRows([restart('s1')], [], expanded);
      assert.deepEqual(
        plan.map((e) => e.type),
        ['row'],
      );
      assert.equal(plan[0]?.type === 'row' && plan[0].compact, false);
    }
  });

  test('2 张重启（达阈值）默认折叠：汇总行打头 + 两行 compact', () => {
    const plan = planAlertRows([restart('s1'), restart('s2')], [], false);
    assert.deepEqual(
      plan.map((e) => e.type),
      ['summary', 'row', 'row'],
    );
    const head = plan[0];
    assert.equal(head?.type === 'summary' && head.count, 2);
    assert.equal(head?.type === 'summary' && head.expanded, false);
    const rows = plan.filter((e) => e.type === 'row');
    assert.ok(
      rows.every((e) => e.type === 'row' && e.compact),
      '折叠态重启行必须全部 compact',
    );
  });

  test('展开态：汇总行保留（expanded=true 可再收起），重启行恢复完整渲染', () => {
    const plan = planAlertRows([restart('s1'), restart('s2')], [], true);
    const head = plan[0];
    assert.equal(head?.type === 'summary' && head.expanded, true);
    const rows = plan.filter((e) => e.type === 'row');
    assert.ok(
      rows.every((e) => e.type === 'row' && !e.compact),
      '展开态不该再有 compact 行',
    );
  });

  test('混合：审批行永不折叠、恒排重启块之后（贴宠物头顶的位置规则）', () => {
    const plan = planAlertRows([restart('s1'), restart('s2')], [approval('s3')], false);
    assert.deepEqual(
      plan.map((e) => (e.type === 'summary' ? 'summary' : e.row.kind + (e.compact ? ':compact' : ''))),
      ['summary', 'restart:compact', 'restart:compact', 'approval'],
    );
  });

  test('汇总行不计入条目数：type=row 的条数恒等于 重启 + 审批（角标 [N 待处理] 语义）', () => {
    const plan = planAlertRows([restart('s1'), restart('s2'), restart('s3')], [approval('s4')], false);
    assert.equal(plan.filter((e) => e.type === 'row').length, 4);
    assert.equal(plan.filter((e) => e.type === 'summary').length, 1);
  });
});
