/**
 * 深链跳转（桌面提醒卡点一行 -> 网页切会话）单元测试。
 *
 * 钉住的行为（对应 2026-10-08 无头 Chrome 实测出的两个失败点）：
 *   ① 目标会话已在列表里：立刻切、立刻抹参数、不再轮询；
 *   ② 列表基线还没到时不得调 open（open 对不在列表的 id 会抛 unknown session），
 *      等目标出现后再切且只切一次；
 *   ③ 超时仍未出现：不切、不抹参数、告警一次；
 *   ④ open 抛错后继续重试，后续成功则补上抹参数；
 *   ⑤ 读不到列表快照（旧版 DSH 或缺服务）时退化为按拍重试 open；
 *   ⑥ 切换入口是注入的 open 函数（装配层负责用闭包包住服务方法保住接收者，本模块不重复该约束）；
 *   ⑦ 拆除函数生效：调用后不再有任何 open。
 *
 * 跑法：node --experimental-strip-types --test src/client/session-deeplink.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startSessionDeepLink, DEEPLINK_POLL_MS, DEEPLINK_TIMEOUT_MS } from './session-deeplink.ts';

/** 假时钟：接管 setTimeout/clearTimeout 与当前时刻，按时间顺序抽干到期任务 */
function makeClock(): {
  setTimeoutFn: (handler: () => void, ms: number) => number;
  clearTimeoutFn: (handle: number) => void;
  nowFn: () => number;
  advance: (ms: number) => void;
  pending: () => number;
} {
  let now = 0;
  let seq = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeoutFn: (handler, ms) => {
      const handle = ++seq;
      tasks.set(handle, { at: now + ms, fn: handler });
      return handle;
    },
    clearTimeoutFn: (handle) => {
      tasks.delete(handle);
    },
    nowFn: () => now,
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        const due = [...tasks.entries()].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        tasks.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
    pending: () => tasks.size,
  };
}

interface FakeOptions {
  /** 列表里已有的会话 id；不传表示完全不提供 list（读不到快照的退化路径） */
  listed?: Set<string>;
  /** 是否让 open 抛错（模拟 unknown session） */
  throwOnOpen?: boolean;
}

/**
 * 假的取数与切换入口：open 是普通函数（接收者由装配层闭包负责保住，本测试不重复该约束）；
 * throwOnOpen 模拟 unknown session。
 */
function makeSessions(options: FakeOptions = {}): {
  list?: { getSnapshot: () => unknown };
  open: (id: string) => void;
  opened: string[];
  listed: Set<string>;
  setThrow: (value: boolean) => void;
} {
  const listed = options.listed ?? new Set<string>();
  const opened: string[] = [];
  let throwOnOpen = options.throwOnOpen ?? false;
  const open = (id: string): void => {
    if (throwOnOpen) throw new Error('unknown session ' + id);
    opened.push(id);
  };
  return {
    list:
      options.listed === undefined
        ? undefined
        : { getSnapshot: () => ({ byId: Object.fromEntries([...listed].map((id) => [id, { id }])) }) },
    open,
    opened,
    listed,
    setThrow: (value: boolean) => {
      throwOnOpen = value;
    },
  };
}

describe('startSessionDeepLink —— 桌面提醒卡深链跳转', () => {
  test('目标已在列表里：立即切一次并抹参数', () => {
    const clock = makeClock();
    const fake = makeSessions({ listed: new Set(['s-target']) });
    let cleared = 0;
    const stop = startSessionDeepLink({
      sessionId: 's-target',
      list: fake.list,
      open: fake.open,
      clearParam: () => {
        cleared += 1;
      },
      ...clock,
    });
    assert.deepEqual(fake.opened, ['s-target']);
    assert.equal(cleared, 1);
    clock.advance(DEEPLINK_POLL_MS * 5);
    assert.equal(clock.pending(), 0, '成功后不应再留轮询任务');
    assert.equal(fake.opened.length, 1);
    stop();
  });

  test('列表未到达时不切；目标出现后切且只切一次', () => {
    const clock = makeClock();
    const fake = makeSessions({ listed: new Set() });
    let cleared = 0;
    const stop = startSessionDeepLink({
      sessionId: 's-target',
      list: fake.list,
      open: fake.open,
      clearParam: () => {
        cleared += 1;
      },
      ...clock,
    });
    // 列表基线未到：这一拍不得尝试 open（open 对不在列表的 id 会抛错）
    assert.deepEqual(fake.opened, []);
    assert.equal(cleared, 0);
    clock.advance(DEEPLINK_POLL_MS * 3);
    assert.deepEqual(fake.opened, []);
    // 列表到达，目标在其中
    fake.listed.add('s-target');
    clock.advance(DEEPLINK_POLL_MS);
    assert.deepEqual(fake.opened, ['s-target']);
    assert.equal(cleared, 1);
    clock.advance(DEEPLINK_POLL_MS * 10);
    assert.equal(fake.opened.length, 1);
    stop();
  });

  test('超时仍未出现：不切、不抹参数、告警一次', () => {
    const clock = makeClock();
    const fake = makeSessions({ listed: new Set() });
    const warnings: string[] = [];
    let cleared = 0;
    const stop = startSessionDeepLink({
      sessionId: 's-gone',
      list: fake.list,
      open: fake.open,
      clearParam: () => {
        cleared += 1;
      },
      warn: (message) => warnings.push(message),
      ...clock,
    });
    clock.advance(DEEPLINK_TIMEOUT_MS + DEEPLINK_POLL_MS);
    assert.deepEqual(fake.opened, []);
    assert.equal(cleared, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /s-gone/);
    assert.equal(clock.pending(), 0, '超时后不应再留轮询任务');
    stop();
  });

  test('open 抛错后继续重试，成功时补上抹参数', () => {
    const clock = makeClock();
    const fake = makeSessions({ listed: new Set(['s-target']), throwOnOpen: true });
    let cleared = 0;
    const stop = startSessionDeepLink({
      sessionId: 's-target',
      list: fake.list,
      open: fake.open,
      clearParam: () => {
        cleared += 1;
      },
      ...clock,
    });
    // 列表里已经有这个会话，但 open 仍抛错：失败不抹参数，下一拍再试
    assert.deepEqual(fake.opened, []);
    assert.equal(cleared, 0);
    fake.setThrow(false);
    clock.advance(DEEPLINK_POLL_MS);
    assert.deepEqual(fake.opened, ['s-target']);
    assert.equal(cleared, 1);
    clock.advance(DEEPLINK_POLL_MS * 3);
    assert.equal(fake.opened.length, 1);
    stop();
  });

  test('列表里有但一直切不过去：超时告警区分于「列表里没有」', () => {
    const clock = makeClock();
    const fake = makeSessions({ listed: new Set(['s-target']), throwOnOpen: true });
    const warnings: string[] = [];
    const stop = startSessionDeepLink({
      sessionId: 's-target',
      list: fake.list,
      open: fake.open,
      warn: (message) => warnings.push(message),
      ...clock,
    });
    clock.advance(DEEPLINK_TIMEOUT_MS + DEEPLINK_POLL_MS);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /切不过去/);
    assert.equal(clock.pending(), 0);
    stop();
  });

  test('列表快照不可用（旧版 DSH）：退化为按拍重试 open', () => {
    const clock = makeClock();
    const fake = makeSessions({ throwOnOpen: true });
    let cleared = 0;
    const stop = startSessionDeepLink({
      sessionId: 's-target',
      list: fake.list,
      open: fake.open,
      clearParam: () => {
        cleared += 1;
      },
      ...clock,
    });
    // 读不到列表时直接试 open：首次抛错，之后成功
    fake.setThrow(false);
    clock.advance(DEEPLINK_POLL_MS);
    assert.deepEqual(fake.opened, ['s-target']);
    assert.equal(cleared, 1);
    stop();
  });

  test('拆除函数生效：调用后不再尝试跳转', () => {
    const clock = makeClock();
    const fake = makeSessions({ listed: new Set() });
    const stop = startSessionDeepLink({
      sessionId: 's-target',
      list: fake.list,
      open: fake.open,
      ...clock,
    });
    stop();
    fake.listed.add('s-target');
    clock.advance(DEEPLINK_POLL_MS * 5);
    assert.deepEqual(fake.opened, []);
    assert.equal(clock.pending(), 0);
  });

  test('没有 open 方法时不抛错、超时告警一次', () => {
    const clock = makeClock();
    const warnings: string[] = [];
    const stop = startSessionDeepLink({
      sessionId: 's-target',
      warn: (message) => warnings.push(message),
      ...clock,
    });
    clock.advance(DEEPLINK_TIMEOUT_MS + DEEPLINK_POLL_MS);
    assert.equal(warnings.length, 1);
    stop();
  });

  test('常量与实现一致（轮询 100ms、等待 20s）', () => {
    assert.equal(DEEPLINK_POLL_MS, 100);
    assert.equal(DEEPLINK_TIMEOUT_MS, 20000);
  });
});
