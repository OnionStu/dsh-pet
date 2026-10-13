// 桌面提醒卡深链（`?dsh-pet-session=<id>`）在网页侧的落地实现（client 半侧，浏览器专属）。
//
// 背景：桌面宠物是另一个进程的透明窗，没有切会话的客户端 API，只能让系统浏览器打开带参数的
// GUI 地址（见 runtime/electron-helper/sprite.js 的 openSessionInBrowser）。网页侧读到参数后
// 必须**等会话列表真的到达**再切。
//
// 切换入口在 DSH 0.2 换过：0.1 是 ctx.sessions.open(sessionId)，0.2 的 sessions 服务已没有
// 这个按 id 切会话的方法，改由 ctx.uiWorkspace.openSession(sessionId) 接任（实现走
// uiWorkspace.replaceMain）。所以本模块不再持有「服务 + open 方法」的组合，而是收两个注入物：
// list（会话列表快照，等目标出现再切）与 open（由装配层用闭包包住服务方法，保住类方法的
// 接收者——脱离服务实例调用时 this 为 undefined，调用必抛）。
//
// 2026-10-08 实测（无头 Chrome 打开 `/?dsh-pet-session=<id>`，页面内挂 Error 构造钩子）：
//   - 插件 apply 后 300ms 一次性 open 时，会话列表尚未到达，抛 unknown session 被吞掉，
//     跳转永久丢失，页面停在 GUI 自己恢复的会话上；
//   - 列表基线约 1.5s 才写入本地选择（`dsh.sessions.current`）。
// 因此改为轮询等待目标会话出现在列表里再切，并只在跳转成功后抹掉地址栏参数；
// 超时仍未出现则保留参数并告警，刷新可再试一次。
//
// 可测性：定时器与宿主接口全部注入，单测用假时钟驱动（与 hand-back.test.ts 的纯 node 约定一致）。

/** 列表快照接口（ObservableSnapshot 的窄面） */
export interface SessionListLike {
  getSnapshot?: () => unknown;
}

export interface SessionDeepLinkOptions {
  /** 目标会话 id */
  sessionId: string;
  /** 会话列表快照：等目标会话出现在列表里再切（读不到快照时退化为按拍重试 open） */
  list?: SessionListLike;
  /** 切换入口（0.2 为 uiWorkspace.openSession）：装配层必须传入保住接收者的闭包 */
  open?: (sessionId: string) => void;
  /** 跳转成功后抹掉地址栏参数（由调用方实现，失败不影响跳转本身） */
  clearParam?: () => void;
  warn?: (message: string) => void;
  setTimeoutFn?: (handler: () => void, ms: number) => number;
  clearTimeoutFn?: (handle: number) => void;
  /** 取当前时刻（单测注入假时钟用） */
  nowFn?: () => number;
  /** 轮询间隔 */
  pollMs?: number;
  /** 等待目标会话出现在列表里的上限 */
  timeoutMs?: number;
}

/** 轮询间隔：列表基线通常几百毫秒内到达，100ms 足够贴近且代价可忽略 */
export const DEEPLINK_POLL_MS = 100;

/** 等待上限：超过即可认为该会话不存在（已删除）或宿主异常 */
export const DEEPLINK_TIMEOUT_MS = 20000;

/** 从列表快照里读目标会话是否已在列表中；快照不可用时返回 undefined（无法判断） */
function listedIn(snapshot: unknown, sessionId: string): boolean | undefined {
  const byId = (snapshot as { byId?: unknown } | undefined)?.byId;
  if (typeof byId !== 'object' || byId === null) return undefined;
  return Object.prototype.hasOwnProperty.call(byId, sessionId);
}

/**
 * 启动深链跳转：轮询到目标会话进入列表后切过去，成功后抹掉地址栏参数。
 * @param options 会话 id、sessions 窄接口与可注入的定时器
 * @returns 拆除函数（插件卸载时调用，之后不再有任何跳转动作）
 */
export function startSessionDeepLink(options: SessionDeepLinkOptions): () => void {
  const sessionId = options.sessionId;
  // open 必须由装配层以闭包传入（如 (id) => ctx.uiWorkspace.openSession(id)）：
  // Cordis 注入的是类方法，脱离服务实例调用时 this 为 undefined，必抛
  const list = options.list;
  const open = options.open;
  const clearParam = options.clearParam;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  // 默认定时器取全局：浏览器与 node 单测（注入假时钟）都成立。
  // 返回值统一收敛成 number（node 的 Timeout 对象只在测试注入路径外出现，这里不会用到句柄内容）。
  const setT =
    options.setTimeoutFn ??
    ((handler: () => void, ms: number) => globalThis.setTimeout(handler, ms) as unknown as number);
  const clearT =
    options.clearTimeoutFn ??
    ((handle: number) => globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));
  const now = options.nowFn ?? (() => Date.now());
  const pollMs = options.pollMs ?? DEEPLINK_POLL_MS;
  const deadline = now() + (options.timeoutMs ?? DEEPLINK_TIMEOUT_MS);

  let timer: number | undefined;
  let stopped = false;
  /** 是否见过目标出现在列表里（决定超时告警的措辞：没见到 = 会话可能已删除） */
  let sawListed = false;

  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) {
      clearT(timer);
      timer = undefined;
    }
  };

  /** 抹参数：实现方抛错（如缺 replaceState）不得影响已经完成的跳转 */
  const stripParam = (): void => {
    if (typeof clearParam !== 'function') return;
    try {
      clearParam();
    } catch {
      /* 参数留在地址栏，仅影响观感 */
    }
  };

  /** 尝试切会话；成功返回 true。open 抛错（会话不在列表里 / 服务未就绪）交给下一拍重试 */
  const jump = (): boolean => {
    if (typeof open !== 'function') return false;
    try {
      open(sessionId);
    } catch {
      return false;
    }
    stripParam();
    return true;
  };

  const tick = (): void => {
    timer = undefined;
    if (stopped) return;
    // listed === false 表示列表已经可用但没有这个会话（可能刚被删除）：这一拍不试 open。
    // listed === undefined 表示读不到列表（旧版 DSH 或缺服务）：退化为直接试 open。
    const listed = listedIn(list?.getSnapshot?.(), sessionId);
    if (listed === true) sawListed = true;
    if (listed !== false && jump()) {
      stop();
      return;
    }
    if (now() >= deadline) {
      stop();
      warn(
        sawListed
          ? `[dsh-pet] 深链跳转失败：会话 ${sessionId} 已在列表里但切不过去（地址栏参数保留，刷新可重试）`
          : `[dsh-pet] 深链跳转放弃：会话 ${sessionId} 未出现在会话列表里（地址栏参数保留，刷新可重试）`,
      );
      return;
    }
    timer = setT(tick, pollMs);
  };

  tick();
  return stop;
}
