// 切会话后把中栏交还对话区（client 半侧，浏览器专属）。
// 背景：左侧插件页打开时（Team 看板 / 我的 PR / SSH / 技能中心），要么以更高 z-index
// 覆盖层盖住宠物卡片（技能中心 9999、SSH 60，点击被覆盖层消费），要么激活时用
// display:none!important 隐藏对话区（切了会话也看不见）。本模块在宠物「切到会话 X」
// 的点击路径里被调用，让打开的插件页按生态既有契约让位，用户才能看到切换结果：
//  - 中心栏插件家族（my-prs / team-board / ssh）都监听 document 上的
//    `dsh-panel-activate`（detail = 激活面板名）：my-prs / team-board 对「非己名」
//    detail 关闭自己，ssh 对兄弟名 'taskboard' 关闭。统一派发 detail='taskboard'
//    恰好让三者全部走自己的 close 路径（都只在自身 open 时才响应，无副作用）。
//  - 技能中心是 body 级全屏遮罩，不监听该事件；按它自己的 backdrop 契约关闭：
//    overlay onClick 里 event.target===event.currentTarget 才 onClose()，
//    于是直接对遮罩根元素派发一个 click（target===currentTarget 自然成立）。
// 没有任何插件页打开时，本函数是无害 no-op（事件没人响应、选择器查不到）。
//
// 可测性：接收一个极小的宿主接口（默认 document），单测传 stub 即可，
// 不依赖 jsdom（与 restart-notice.test.ts 的纯 node 约定一致）。

export interface HandBackHost {
  dispatchEvent(event: unknown): boolean;
  querySelector(selector: string): Element | null;
}

/** 技能中心容器选择器：其首个子元素即全屏遮罩根（overlay div） */
const SKILL_EXPLORER_CONTAINER = '[data-dsh-skill-explorer-view]';

/** 造一个可冒泡的 click 事件；个别 node 环境没有 MouseEvent 时退回 Event */
function makeClickEvent(): Event {
  try {
    return new MouseEvent('click', { bubbles: true });
  } catch {
    return new Event('click', { bubbles: true });
  }
}

/**
 * 让当前打开的插件页让位，把中栏交还给对话区。幂等、无插件页时 no-op。
 * @param host 默认真实 document；测试传 stub。
 */
export function handBackCenterColumn(host: HandBackHost = document as HandBackHost): void {
  // 1) 中心栏插件家族：一个 activate 事件让 my-prs / team-board / ssh 全部关闭
  try {
    host.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: 'taskboard' }));
  } catch {
    /* 个别环境缺 CustomEvent：跳过事件路，下面的技能中心路照常 */
  }
  // 2) 技能中心：对遮罩根派发 click（其 onClick 要求 target===currentTarget）
  const container = host.querySelector(SKILL_EXPLORER_CONTAINER);
  const overlay = container?.firstElementChild;
  // 用鸭子类型而非 instanceof HTMLElement：保持与纯 node 单测约定兼容（无 DOM 全局）
  if (overlay !== null && overlay !== undefined && typeof overlay.dispatchEvent === 'function') {
    try {
      overlay.dispatchEvent(makeClickEvent());
    } catch {
      /* 派发失败（如已卸载）：忽略 */
    }
  }
}
