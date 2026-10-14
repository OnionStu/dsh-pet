/**
 * 待交互提醒（host 半侧）单测：审批 / 选择题 / 计划评审三类行的**跨事件配对**。
 *
 * 为什么值得单测：这里全部是配对逻辑（approval/asked ⟷ approval/decided、
 * tool/call ⟷ tool/result）。配错一次就是"卡片永不消失"或"审批来了不弹"，
 * 两种都只能等用户发现；而且它跑在 host 的事件流上，没有界面能一眼看出错在哪。
 * 事件形状取自 DSH 的 SessionEventMap（approval/asked 带 id+toolName；tool/result 的 callId
 * 在 0.2 的会话格式里位于 message.toolCallId，旧代际位于 message.content[0].toolCallId，
 * 两种形状都要认）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createPendingAlerts } from './pending-alerts.ts';

/** approval/asked：id 是审批请求 id，toolName 是触发审批的工具 */
const asked = (id: string, toolName: string) => ({ type: 'approval/asked', data: { id, toolName } });
/** approval/decided：按同一个 id 收尾 */
const decided = (id: string) => ({ type: 'approval/decided', data: { id, outcome: 'allow' } });
/** tool/call：callId 是配对的钥匙 */
const toolCall = (callId: string, name: string, args: unknown = {}) => ({
  type: 'tool/call',
  data: { callId, name, arguments: JSON.stringify(args) },
});
/** tool/result（旧代际形状）：callId 嵌在 message.content[0].toolCallId */
const toolResult = (callId: string) => ({
  type: 'tool/result',
  data: { message: { content: [{ type: 'tool-result', toolCallId: callId, content: [] }] } },
});
/**
 * tool/result（当前代际形状，取自 2026-10-13 本机会话记录）：工具结果是独立消息，
 * callId 在 message.toolCallId，content[0] 是纯文本块（没有 toolCallId）。0.2 的会话格式
 * 把 ToolResultBlock 删除后就是这一形状，配对逻辑必须认它，否则待交互行只进不出。
 */
const toolResultCurrent = (callId: string) => ({
  type: 'tool/result',
  data: {
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [{ type: 'text', text: '（工具结果正文）' }],
    },
  },
});
const turnEnd = (kind: string) => ({ type: 'turn/end', data: { reason: { kind } } });
const title = (text: string) => ({ type: 'session/title', data: { title: text } });

const texts = (store: ReturnType<typeof createPendingAlerts>) => store.snapshot().items.map((i) => i.text);
const kinds = (store: ReturnType<typeof createPendingAlerts>) => store.snapshot().items.map((i) => i.kind);

describe('审批行：approval/asked ⟷ approval/decided 按 id 配对', () => {
  test('asked 入表，文案带工具名', () => {
    const store = createPendingAlerts();
    store.observe('s1', asked('a1', 'Bash'));
    assert.deepEqual(texts(store), ['等你审批 · Bash']);
    assert.deepEqual(kinds(store), ['approval']);
  });

  test('decided 只删掉那一个 id，同会话其它审批不受影响', () => {
    const store = createPendingAlerts();
    store.observe('s1', asked('a1', 'Bash'));
    store.observe('s1', asked('a2', 'Write'));
    store.observe('s1', decided('a1'));
    assert.deepEqual(texts(store), ['等你审批 · Write']);
  });

  test('同一 id 重复 asked 不产生第二行（幂等）', () => {
    const store = createPendingAlerts();
    store.observe('s1', asked('a1', 'Bash'));
    store.observe('s1', asked('a1', 'Bash'));
    assert.equal(store.snapshot().items.length, 1);
  });

  test('缺 toolName 时不留下孤零零的分隔点', () => {
    const store = createPendingAlerts();
    store.observe('s1', { type: 'approval/asked', data: { id: 'a1' } });
    assert.deepEqual(texts(store), ['等你审批']);
  });

  test('decided 的 id 未知时不动任何行', () => {
    const store = createPendingAlerts();
    store.observe('s1', asked('a1', 'Bash'));
    store.observe('s1', decided('nope'));
    assert.equal(store.snapshot().items.length, 1);
  });
});

describe('选择题 / 计划评审：tool/call ⟷ tool/result 按 callId 配对', () => {
  test('ask_user_question 入表，文案带首个问题', () => {
    const store = createPendingAlerts();
    store.observe('s1', toolCall('c1', 'ask_user_question', { questions: [{ question: '要不要删库？' }] }));
    assert.deepEqual(texts(store), ['等你选择 · 要不要删库？']);
    assert.deepEqual(kinds(store), ['question']);
  });

  test('exit_plan_mode 入表为计划评审（host 侧拿不到那句评审问句，用固定文案）', () => {
    const store = createPendingAlerts();
    store.observe('s1', toolCall('c1', 'exit_plan_mode', { plan: '# 计划\n…' }));
    assert.deepEqual(texts(store), ['等你评审计划']);
    assert.deepEqual(kinds(store), ['plan-review']);
  });

  test('问题文本解析失败/缺失时退化为「等你选择」', () => {
    const store = createPendingAlerts();
    store.observe('s1', toolCall('c1', 'ask_user_question', { questions: [] }));
    store.observe('s1', {
      type: 'tool/call',
      data: { callId: 'c2', name: 'ask_user_question', arguments: '{坏 JSON' },
    });
    assert.deepEqual(texts(store), ['等你选择', '等你选择']);
  });

  test('tool/result 按 callId 出表，别的 callId 不动其它行', () => {
    const store = createPendingAlerts();
    store.observe('s1', toolCall('c1', 'ask_user_question', { questions: [{ question: 'A' }] }));
    store.observe('s1', toolCall('c2', 'ask_user_question', { questions: [{ question: 'B' }] }));
    store.observe('s1', toolResult('c1'));
    assert.deepEqual(texts(store), ['等你选择 · B']);
    store.observe('s1', toolResult('c2'));
    assert.equal(store.snapshot().items.length, 0);
  });

  test('当前代际形状（callId 在 message.toolCallId）也必须出表', () => {
    const store = createPendingAlerts();
    store.observe('s1', toolCall('c1', 'ask_user_question', { questions: [{ question: 'A' }] }));
    store.observe('s1', toolResultCurrent('c1'));
    assert.equal(store.snapshot().items.length, 0);
  });

  test('不关心的工具名不进表（普通干活不该弹提醒）', () => {
    const store = createPendingAlerts();
    store.observe('s1', toolCall('c1', 'Bash', { command: 'ls' }));
    assert.equal(store.snapshot().items.length, 0);
  });

  test('审批与选择题可同时挂着（两类各一条，互不干扰）', () => {
    const store = createPendingAlerts();
    store.observe('s1', asked('a1', 'Bash'));
    store.observe('s1', toolCall('c1', 'ask_user_question', { questions: [{ question: '选哪个？' }] }));
    assert.deepEqual(texts(store), ['等你审批 · Bash', '等你选择 · 选哪个？']);
  });
});

describe('僵尸行清理：终局回合清该会话的待交互行', () => {
  test('turn/end aborted 清掉本会话全部待交互行，其它会话不受影响', () => {
    const store = createPendingAlerts();
    store.observe('s1', asked('a1', 'Bash'));
    store.observe('s1', toolCall('c1', 'ask_user_question', { questions: [{ question: 'A' }] }));
    store.observe('s2', asked('b1', 'Write'));
    store.observe('s1', turnEnd('aborted'));
    const items = store.snapshot().items;
    assert.deepEqual(
      items.map((i) => i.sessionId),
      ['s2'],
    );
  });

  test('turn/end completed 不清（配对可能只是晚到，宁可多留一拍也不要丢提醒）', () => {
    const store = createPendingAlerts();
    store.observe('s1', asked('a1', 'Bash'));
    store.observe('s1', turnEnd('completed'));
    assert.equal(store.snapshot().items.length, 1);
  });
});

describe('会话标题与排序', () => {
  test('session/title 提供标签；没有标题时退化为会话 id 前 8 位', () => {
    const store = createPendingAlerts();
    store.observe('s1', asked('a1', 'Bash'));
    store.observe('abcdef1234567890', asked('a2', 'Bash'));
    store.observe('s1', title('修桌面端尺寸'));
    const labels = store.snapshot().items.map((i) => i.label);
    assert.deepEqual(labels, ['修桌面端尺寸', 'abcdef12']);
  });

  test('标题后到也能补上（asked 先于 title 的常见时序）', () => {
    const store = createPendingAlerts();
    store.observe('s1', asked('a1', 'Bash'));
    assert.deepEqual(
      store.snapshot().items.map((i) => i.label),
      ['s1'],
    );
    store.observe('s1', title('后到的标题'));
    assert.deepEqual(
      store.snapshot().items.map((i) => i.label),
      ['后到的标题'],
    );
  });

  test('titleOf 单查标题（/alerts 给重启提醒行补 label 用）；无记录返回 undefined', () => {
    const store = createPendingAlerts();
    assert.equal(store.titleOf('s1'), undefined);
    store.observe('s1', title('修桌面端尺寸'));
    assert.equal(store.titleOf('s1'), '修桌面端尺寸');
    assert.equal(store.titleOf('别的会话'), undefined);
  });

  test('按入表时刻升序（最早的在最上），snapshot.ts 随变化推进', () => {
    const store = createPendingAlerts();
    store.observe('s1', asked('a1', 'Bash'));
    const first = store.snapshot();
    store.observe('s2', asked('b1', 'Write'));
    const second = store.snapshot();
    assert.deepEqual(
      second.items.map((i) => i.text),
      ['等你审批 · Bash', '等你审批 · Write'],
    );
    assert.ok(second.ts >= first.ts, 'ts 不应回退');
  });

  test('无关事件不推进 ts（轮询端靠它避免无谓重渲染）', () => {
    const store = createPendingAlerts();
    store.observe('s1', asked('a1', 'Bash'));
    const before = store.snapshot().ts;
    store.observe('s1', { type: 'assistant/chunk', data: {} });
    assert.equal(store.snapshot().ts, before);
  });

  test('事件形状非法（null/非对象）不抛错', () => {
    const store = createPendingAlerts();
    store.observe('s1', null);
    store.observe('s1', { type: 'approval/asked' });
    assert.equal(store.snapshot().items.length, 0);
  });
});
