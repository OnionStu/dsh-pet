/**
 * 提醒卡共享行模型单测（浏览器与桌面共用这一份：视觉靠 ALERT_CSS，行为靠这里）。
 *
 * 这里钉的是**顺序与容错**：卡片底边锚在宠物头顶，最后一行才贴着宠物，所以"重启行在前、
 * 待交互行在后"不是审美而是布局前提；而 host 响应体是跨进程数据，形状一变就得丢弃坏行
 * 而不是整张卡崩掉。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALERT_CSS,
  REASON_MAX,
  SESSION_DEEPLINK_PARAM,
  alertRowsFromPayload,
  sessionDeepLink,
  truncateReason,
} from './alerts.ts';

const payload = (restart: unknown[], pending: unknown[]) => ({ ok: true, ts: 1, restart, pending });

describe('alertRowsFromPayload —— 行顺序与形状', () => {
  test('重启行在前、待交互行在后（卡片贴宠物头顶的布局前提）', () => {
    const rows = alertRowsFromPayload(
      payload(
        [{ sessionId: 's-restart', reason: '改了 client.js' }],
        [{ kind: 'approval', sessionId: 's-appr', label: '修尺寸', text: '等你审批 · Bash' }],
      ),
    );
    assert.deepEqual(
      rows.map((r) => r.kind),
      ['restart', 'approval'],
    );
    assert.deepEqual(
      rows.map((r) => r.text),
      ['需要重启 DSH · 改了 client.js', '等你审批 · Bash'],
    );
  });

  test('重启行可手动消除，待交互行不可（审批要在会话里真的处理掉）', () => {
    const rows = alertRowsFromPayload(
      payload([{ sessionId: 's1', reason: 'x' }], [{ kind: 'question', sessionId: 's2', text: '等你选择' }]),
    );
    assert.equal(rows[0]?.dismissable, true);
    assert.equal(rows[1]?.dismissable, false);
  });

  test('无 reason 的重启行不带分隔点', () => {
    const rows = alertRowsFromPayload(payload([{ sessionId: 's1' }], []));
    assert.equal(rows[0]?.text, '需要重启 DSH');
  });

  test('标签缺失时退化为会话 id 前 8 位（两端同款兜底）', () => {
    const rows = alertRowsFromPayload(
      payload(
        [{ sessionId: 'abcdef1234567890', reason: 'x' }],
        [{ kind: 'approval', sessionId: 'abcdef1234567890', text: '等你审批' }],
      ),
    );
    assert.deepEqual(
      rows.map((r) => r.label),
      ['abcdef12', 'abcdef12'],
    );
  });

  test('未知 kind 归入 question（新增类型不该让行消失）', () => {
    const rows = alertRowsFromPayload(payload([], [{ kind: 'plan-review', sessionId: 's1', text: '等你评审计划' }]));
    assert.equal(rows[0]?.kind, 'plan-review');
    const unknown = alertRowsFromPayload(payload([], [{ kind: '未来新类型', sessionId: 's1', text: '等你选择' }]));
    assert.equal(unknown[0]?.kind, 'question');
  });

  test('缺 sessionId / 缺 text 的坏行被丢弃，其余行照常渲染', () => {
    const rows = alertRowsFromPayload(
      payload(
        [{ reason: '没有会话 id' }, { sessionId: 'ok', reason: 'x' }],
        [
          { kind: 'approval', sessionId: 'no-text' },
          { kind: 'approval', sessionId: 'ok2', text: '等你审批 · Write' },
        ],
      ),
    );
    assert.deepEqual(
      rows.map((r) => r.sessionId),
      ['ok', 'ok2'],
    );
  });

  test('响应体形状非法（null / 缺两组 / 不是数组）不抛错，返回空列表', () => {
    for (const bad of [null, undefined, {}, { restart: 'nope', pending: 42 }, { restart: [null], pending: [null] }]) {
      assert.deepEqual(alertRowsFromPayload(bad), []);
    }
  });

  test('key 在同一会话的多条提醒之间不重复（React/虚拟 DOM 风格渲染要求唯一）', () => {
    const rows = alertRowsFromPayload(
      payload(
        [{ sessionId: 's1', reason: 'a' }],
        [
          { kind: 'approval', sessionId: 's1', text: '等你审批 · Bash' },
          { kind: 'approval', sessionId: 's1', text: '等你审批 · Write' },
        ],
      ),
    );
    assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
  });
});

describe('truncateReason —— 理由截断（与浏览器同一份规则）', () => {
  test('短理由原样保留', () => {
    assert.equal(truncateReason('改了 client.js'), '改了 client.js');
  });

  test('超长截断到 REASON_MAX 并加省略号', () => {
    const out = truncateReason('a'.repeat(REASON_MAX + 50));
    assert.equal(out.length, REASON_MAX + 1);
    assert.ok(out.endsWith('…'));
  });

  test('换行/连续空白压成单个空格（卡片是一行行渲染的）', () => {
    assert.equal(truncateReason('  改完 了\n\n请重启  '), '改完 了 请重启');
  });

  test('重启行文案用截断后的理由', () => {
    const rows = alertRowsFromPayload(payload([{ sessionId: 's1', reason: 'b'.repeat(200) }], []));
    assert.equal(rows[0]?.text, '需要重启 DSH · ' + 'b'.repeat(REASON_MAX) + '…');
  });
});

describe('ALERT_CSS —— 两端共用的卡片视觉', () => {
  test('按 --dsh-pet-size 缩放（两端各自把宠物尺寸写到这个变量上）', () => {
    assert.ok(ALERT_CSS.includes('var(--dsh-pet-size)'));
  });

  test('含行/标签/正文/圆点/消除按钮/折叠标记全部选择器（缺一个就是少一块视觉）', () => {
    for (const sel of [
      '.dsh-pet-alerts',
      '.dsh-pet-alerts[hidden]',
      '.dsh-pet-alert-row',
      '.dsh-pet-alert-label',
      '.dsh-pet-alert-text',
      '.dsh-pet-alert-dot',
      '.dsh-pet-alert-close',
      '.dsh-pet-alert-foldmark',
    ]) {
      assert.ok(ALERT_CSS.includes(sel), `ALERT_CSS 应包含 ${sel}`);
    }
  });
});

describe('sessionDeepLink —— 桌面点行跳会话的深链参数', () => {
  test('取出会话 id', () => {
    assert.equal(sessionDeepLink('?dsh-pet-session=sess-123'), 'sess-123');
  });

  test('没有该参数时返回空串（正常打开 GUI 不受影响）', () => {
    assert.equal(sessionDeepLink(''), '');
    assert.equal(sessionDeepLink('?other=1'), '');
  });

  test('与其它参数共存 / 编码过的 id 都能解出来', () => {
    assert.equal(sessionDeepLink('?foo=bar&dsh-pet-session=abc%2Fdef'), 'abc/def');
  });

  test('空值当作没有（不返回空字符串以外的意外值）', () => {
    assert.equal(sessionDeepLink('?dsh-pet-session='), '');
  });

  test('参数名是两端共用的常量（桌面拼 URL 用它，网页读它）', () => {
    assert.equal(SESSION_DEEPLINK_PARAM, 'dsh-pet-session');
    assert.equal(sessionDeepLink('?' + SESSION_DEEPLINK_PARAM + '=x'), 'x');
  });
});
