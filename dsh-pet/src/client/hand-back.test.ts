/**
 * client 「切会话后让插件页让位」单元测试 —— 钉住三件事：
 *   ① 中心栏插件家族：派发 dsh-panel-activate（detail='taskboard'）——my-prs/team-board
 *      对非己名 detail 关闭、ssh 对兄弟名 taskboard 关闭，一个事件让三者全让位；
 *   ② 技能中心：对其遮罩根元素派发 click（该插件 onClick 要求 target===currentTarget 才关）；
 *   ③ 没有任何插件页打开时是无害 no-op（不抛、不误触发）。
 * 不碰真实 DOM：handBackCenterColumn 接收宿主接口（默认 document），测试传 stub。
 *
 * 跑法：node --experimental-strip-types --test src/client/hand-back.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { handBackCenterColumn, type HandBackHost } from './hand-back.ts';

/** 记录派发事件的 stub 宿主 */
function stubHost(opts?: { withSkillExplorer?: boolean }): {
  host: HandBackHost;
  events: { type: string; detail?: unknown }[];
  clicks: number;
} {
  const events: { type: string; detail?: unknown }[] = [];
  let clicks = 0;
  const overlay = {
    dispatchEvent() {
      clicks += 1;
      return true;
    },
  } as unknown as Element;
  const container = {
    firstElementChild: overlay,
  } as unknown as Element;
  const host: HandBackHost = {
    dispatchEvent(e: unknown) {
      const ev = e as { type?: string; detail?: unknown };
      events.push({ type: ev.type ?? '', detail: ev.detail });
      return true;
    },
    querySelector(sel: string) {
      if (sel === '[data-dsh-skill-explorer-view]') {
        return opts?.withSkillExplorer === false ? null : container;
      }
      return null;
    },
  };
  return {
    host,
    events,
    get clicks(): number {
      return clicks;
    },
  };
}

describe('handBackCenterColumn —— 切会话后让插件页让位', () => {
  test('派发 dsh-panel-activate，detail=taskboard（my-prs/team-board/ssh 三家都会关）', () => {
    const { host, events } = stubHost({ withSkillExplorer: false });
    handBackCenterColumn(host);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'dsh-panel-activate');
    assert.equal(events[0]?.detail, 'taskboard');
  });

  test('技能中心打开时：对遮罩根元素（容器首子元素）派发 click', () => {
    const s = stubHost();
    handBackCenterColumn(s.host);
    assert.equal(s.clicks, 1);
  });

  test('技能中心已关闭（无容器）时：不派发 click', () => {
    const s = stubHost({ withSkillExplorer: false });
    handBackCenterColumn(s.host);
    assert.equal(s.clicks, 0);
  });

  test('两路都无插件页时仍无害：不抛异常，事件照常派发', () => {
    const { host } = stubHost({ withSkillExplorer: false });
    assert.doesNotThrow(() => handBackCenterColumn(host));
  });
});
