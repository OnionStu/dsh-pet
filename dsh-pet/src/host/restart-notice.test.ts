/**
 * host 「需要重启宿主」提醒单元测试 —— 钉住三件事：
 *   ① 内存表语义：同会话覆盖（不堆叠）、dismiss 幂等、snapshot 顺序确定；
 *   ② 工具定义形状：parameters / output.schema 必须与真实 defineTool 的编译产物一致
 *      （本模块手写定义、不引 @deepseek-ai/dsh-tools，形状一旦漂移 register 会抛错——
 *       这条测试就是防止漂移的第一道闸）；
 *   ③ execute 的三条分支：记录成功 / 开关关闭不伪报 / 无归属会话与空理由显式报错。
 *
 * 跑法：node --experimental-strip-types --test src/host/restart-notice.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESTART_NOTICE_TOOL,
  createRestartNoticeStore,
  restartNoticeToolDefinition,
  type RestartNoticeToolValue,
} from './restart-notice.ts';

describe('createRestartNoticeStore —— 内存表语义', () => {
  test('record 写入并按 ts 升序返回', () => {
    const store = createRestartNoticeStore();
    store.record('s2', '第二', 200);
    store.record('s1', '第一', 100);
    assert.deepEqual(
      store.snapshot().map((n) => n.sessionId),
      ['s1', 's2'],
    );
  });

  test('同会话重复调用 = 覆盖（最新理由为准），不堆叠', () => {
    const store = createRestartNoticeStore();
    store.record('s1', '旧理由', 100);
    store.record('s1', '新理由', 200);
    const snap = store.snapshot();
    assert.equal(snap.length, 1);
    assert.equal(snap[0]?.reason, '新理由');
    assert.equal(snap[0]?.ts, 200);
  });

  test('同 ts 时按 sessionId 稳定排序（渲染顺序必须确定）', () => {
    const store = createRestartNoticeStore();
    store.record('sb', 'b', 100);
    store.record('sa', 'a', 100);
    assert.deepEqual(
      store.snapshot().map((n) => n.sessionId),
      ['sa', 'sb'],
    );
  });

  test('dismiss 返回是否真的删掉；重复 dismiss = false（不伪报）', () => {
    const store = createRestartNoticeStore();
    store.record('s1', 'x', 100);
    assert.equal(store.dismiss('s1'), true);
    assert.equal(store.dismiss('s1'), false);
    assert.equal(store.snapshot().length, 0);
  });

  test('默认时钟注入：不传 ts 时用 now()', () => {
    const store = createRestartNoticeStore(() => 12345);
    assert.equal(store.record('s1', 'x').ts, 12345);
  });

  test('clear 清空', () => {
    const store = createRestartNoticeStore();
    store.record('s1', 'x', 1);
    store.clear();
    assert.equal(store.snapshot().length, 0);
  });
});

describe('restartNoticeToolDefinition —— 定义形状（对齐真实 defineTool 产物）', () => {
  test('工具名固定', () => {
    const def = restartNoticeToolDefinition({ store: createRestartNoticeStore(), enabled: () => true });
    assert.equal(def.name, RESTART_NOTICE_TOOL);
  });

  test('parameters 是已编译的 JSON Schema：reason 为必填 string（无 additionalProperties，与 defineTool 一致）', () => {
    const def = restartNoticeToolDefinition({ store: createRestartNoticeStore(), enabled: () => true });
    const params = def.parameters as {
      type?: unknown;
      required?: unknown;
      additionalProperties?: unknown;
      properties?: Record<string, { type?: unknown; description?: unknown }>;
    };
    assert.equal(params.type, 'object');
    assert.deepEqual(params.required, ['reason']);
    assert.equal(params.additionalProperties, undefined); // defineTool 的参数根不带该键
    assert.equal(params.properties?.reason?.type, 'string');
    assert.equal(typeof params.properties?.reason?.description, 'string');
    assert.deepEqual(Object.keys(params.properties ?? {}), ['reason']);
  });

  test('output.schema 是对象根 + additionalProperties:false + required 数组（与 defineTool 一致）', () => {
    const def = restartNoticeToolDefinition({ store: createRestartNoticeStore(), enabled: () => true });
    assert.deepEqual(def.output.schema, {
      type: 'object',
      additionalProperties: false,
      properties: { ok: { type: 'boolean' }, noticedAt: { type: 'number' } },
      required: ['ok', 'noticedAt'],
    });
  });
});

describe('execute —— 三条分支', () => {
  const run = (
    args: unknown,
    options: { enabled?: boolean; sessionId?: string | undefined; store?: ReturnType<typeof createRestartNoticeStore> },
  ): Promise<RestartNoticeToolValue> => {
    const store = options.store ?? createRestartNoticeStore(() => 777);
    const def = restartNoticeToolDefinition({ store, enabled: () => options.enabled !== false });
    const exec = options.sessionId === undefined ? { agent: undefined } : { agent: { id: options.sessionId } };
    return def.execute(args, exec);
  };

  test('正常路径：记入内存表并返回 ok + noticedAt', async () => {
    const store = createRestartNoticeStore(() => 777);
    const value = await run({ reason: '改了 client.js' }, { sessionId: 'sess-1', store });
    assert.deepEqual(value, { ok: true, noticedAt: 777 });
    assert.equal(store.snapshot()[0]?.sessionId, 'sess-1');
    assert.equal(store.snapshot()[0]?.reason, '改了 client.js');
  });

  test('reason 前后空白被 trim', async () => {
    const store = createRestartNoticeStore();
    await run({ reason: '  改了 client.js  ' }, { sessionId: 'sess-1', store });
    assert.equal(store.snapshot()[0]?.reason, '改了 client.js');
  });

  test('开关关闭：不记录、不弹卡，且 ok=false（绝不伪报「已提醒」）', async () => {
    const store = createRestartNoticeStore();
    const value = await run({ reason: '改了 client.js' }, { sessionId: 'sess-1', enabled: false, store });
    assert.deepEqual(value, { ok: false, noticedAt: 0 });
    assert.equal(store.snapshot().length, 0);
  });

  test('空理由 / 缺 reason / 非字符串 → 显式报错（卡片不能是没有信息量的噪音）', async () => {
    for (const args of [{ reason: '   ' }, {}, { reason: 42 }, null, 'nope']) {
      await assert.rejects(() => run(args, { sessionId: 'sess-1' }), /reason 不能为空/);
    }
  });

  test('无归属会话 → 显式报错（定位不到卡片也没法跳转，不静默吞）', async () => {
    await assert.rejects(() => run({ reason: 'x' }, { sessionId: undefined }), /需要在一个有归属的 agent 会话里调用/);
    await assert.rejects(() => run({ reason: 'x' }, { sessionId: '' }), /需要在一个有归属的 agent 会话里调用/);
  });

  test('render：ok=true 与 ok=false 文案不同（关闭时不谎称已弹卡）', () => {
    const def = restartNoticeToolDefinition({ store: createRestartNoticeStore(), enabled: () => true });
    const on = def.output.render({}, { ok: true, noticedAt: 1 })[0]?.text ?? '';
    const off = def.output.render({}, { ok: false, noticedAt: 0 })[0]?.text ?? '';
    assert.match(on, /已在桌宠上弹出重启提醒卡/);
    assert.match(off, /没有弹卡/);
    assert.notEqual(on, off);
  });
});
