/**
 * dsh-pet desktop helper —— 其它应用全屏时宠物让位的纯判定（不依赖 Electron，可被 node:test 直接单测）。
 *
 * 需求：其它应用（视频播放器、演示、会议等）全屏占用某块屏时，该屏上的桌面宠物自动隐藏，
 * 退出全屏后恢复；**浏览器不算其它应用**，全屏看 DSH Web GUI 时宠物保留。
 *
 * 为什么不让窗口干脆退出全屏空间（visibleOnFullScreen: false）了事：那个开关是一刀切的，
 * 浏览器全屏时宠物也会一起消失，而浏览器全屏恰恰是桌宠的主场景。所以必须知道
 * 「现在占着屏的是哪个应用」，判定只能落在逐窗探测上。
 *
 * 分工：`fullscreen-probe.jxa` 只负责采集（当前空间内在屏的 layer 0 应用窗口与 layer 24 菜单栏窗口，
 * 走 macOS 自带 osascript + ObjC 桥，不需要任何授权）；本文件负责判定与状态机；main.js 只负责
 * 按结果调 hide()/show()。坐标系约定：全部用「左上为原点、Y 向下」的显示器坐标（Electron 的
 * screen.getPrimaryDisplay().bounds 与 CGWindowList 的 kCGWindowBounds 同属这套）。
 *
 * 判定口径（满足任一条即认为该屏被其它应用全屏占用）：
 *
 * - 非浏览器窗口铺满该屏的完整面板（含菜单栏区域）：原生全屏与无边框全屏都长这样；
 * - 或该屏菜单栏此刻不可见（应用做了系统级全屏展示）且有非浏览器窗口铺满该屏工作区：
 *   云游戏客户端、播放器这类「无边框铺满工作区」的全屏，窗口几何与普通最大化窗口完全相同
 *   （都是面板减去菜单栏那一条），菜单栏是否被隐藏是唯一能把两者区分开的信号。
 *
 * 只放大到工作区、菜单栏仍在的普通最大化窗口两条都不满足，故不会误判。
 * 系统开启「自动隐藏菜单栏」时菜单栏平时就不可见，第二条会退化成「任何最大化窗口都让位」，
 * 所以探测把该开关一并上报（menuBarAutoHide），开着时第二条整体停用，只留第一条。
 */

'use strict';

/** 覆盖判定允许的取整误差（px）：窗口四边与屏边之差在此范围内视为齐平 */
const COVER_TOLERANCE = 4;

/** 菜单栏窗口的高度上限（px）：超过它就不是那条菜单栏，而是别的浮层 */
const MENU_BAR_MAX_HEIGHT = 60;

/** 空探测结果：探测失败到上限后按它处理（没有窗口 = 没有全屏），菜单栏信号一并作废 */
const EMPTY_SNAPSHOT = { windows: [], menuBars: [], menuBarAutoHide: true };

/** 浏览器 bundle id 白名单（全屏看 DSH 时宠物保留；命中即不算其它应用） */
const BROWSER_BUNDLES = new Set([
  'com.google.Chrome',
  'com.google.Chrome.beta',
  'com.google.Chrome.dev',
  'com.google.Chrome.canary',
  'org.chromium.Chromium',
  'com.microsoft.edgemac',
  'com.microsoft.edgemac.Beta',
  'com.microsoft.edgemac.Dev',
  'com.microsoft.edgemac.Canary',
  'com.brave.Browser',
  'com.brave.Browser.beta',
  'company.thebrowser.Browser', // Arc
  'com.apple.Safari',
  'com.apple.SafariTechnologyPreview',
  'org.mozilla.firefox',
  'org.mozilla.firefoxdeveloperedition',
  'com.vivaldi.Vivaldi',
  'com.operasoftware.Opera',
  'com.operasoftware.OperaGX',
]);

/** 应用名兜底白名单（bundle id 取不到或写成变体时用；浏览器名基本不随系统语言本地化） */
const BROWSER_NAMES = new Set([
  'Google Chrome',
  'Google Chrome Beta',
  'Google Chrome Dev',
  'Google Chrome Canary',
  'Chromium',
  'Microsoft Edge',
  'Microsoft Edge Beta',
  'Microsoft Edge Dev',
  'Microsoft Edge Canary',
  'Brave Browser',
  'Brave Browser Beta',
  'Arc',
  'Safari',
  'Safari Technology Preview',
  'Firefox',
  'Firefox Developer Edition',
  'Vivaldi',
  'Opera',
  'Opera GX',
]);

/**
 * 该窗口的宿主应用是不是浏览器（浏览器全屏不触发让位）。
 *
 * bundle id 能取到时**只认 bundle id**，不再拿应用名兜底：Chrome 应用（PWA、云游戏客户端这类
 * 以 app 模式运行的窗口）与普通 Chrome 窗口是两个进程、两个 bundle（实测云·鸣潮为
 * com.google.Chrome.app.<app-id>，普通 Chrome 为 com.google.Chrome），而它们的 owner 名可能
 * 都写成 Google Chrome；用名字兜底会把这类窗口误判成浏览器，让位就永远不会触发。
 * 应用名只在 bundle 取不到时兜底（非 bundle 进程才可能为空）。
 *
 * @param {{app?: unknown, bundle?: unknown}} win
 */
function isBrowserWindow(win) {
  const bundle = typeof win?.bundle === 'string' ? win.bundle : '';
  if (bundle) return BROWSER_BUNDLES.has(bundle);
  const app = typeof win?.app === 'string' ? win.app : '';
  return app ? BROWSER_NAMES.has(app) : false;
}

/**
 * 窗口是否铺满整块屏（含菜单栏区域）。
 * @param {{x:number,y:number,width:number,height:number}} win
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {number} [tolerance]
 */
function coversScreen(win, rect, tolerance = COVER_TOLERANCE) {
  return (
    win.x <= rect.x + tolerance &&
    win.y <= rect.y + tolerance &&
    win.x + win.width >= rect.x + rect.width - tolerance &&
    win.y + win.height >= rect.y + rect.height - tolerance
  );
}

/**
 * 点落在哪块屏上（多屏不重叠；屏外返回 -1）。
 * @param {Array<{x:number,y:number,width:number,height:number}>} screens
 * @param {{x:number,y:number}} point
 */
function screenIndexAt(screens, point) {
  for (let i = 0; i < screens.length; i++) {
    const s = screens[i];
    if (point.x >= s.x && point.x < s.x + s.width && point.y >= s.y && point.y < s.y + s.height) return i;
  }
  return -1;
}

/** 从任意位置取有限数；取不到返回 undefined */
function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 一个原始窗口条目 → 判定用条目；结构不完整返回 undefined（丢弃单条，不放大成整轮失败） */
function normalizeWindow(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const pid = finite(raw.pid);
  const x = finite(raw.x);
  const y = finite(raw.y);
  const width = finite(raw.width);
  const height = finite(raw.height);
  if (pid === undefined || x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return {
    pid,
    app: typeof raw.app === 'string' ? raw.app : '',
    bundle: typeof raw.bundle === 'string' ? raw.bundle : '',
    x,
    y,
    width,
    height,
  };
}

/**
 * 该屏顶部那条菜单栏此刻是否在屏。在屏列表里没有它，等于「某个应用把它隐藏了」，
 * 也就是该应用在做系统级全屏展示（原生全屏与游戏/播放器的无边框全屏都会这样）。
 */
function menuBarVisible(screen, menuBars) {
  return menuBars.some(
    (b) =>
      b.height > 0 &&
      b.height <= MENU_BAR_MAX_HEIGHT &&
      b.x <= screen.x + COVER_TOLERANCE &&
      b.x + b.width >= screen.x + screen.width - COVER_TOLERANCE &&
      b.y >= screen.y - COVER_TOLERANCE &&
      b.y <= screen.y + COVER_TOLERANCE,
  );
}

/** 矩形条目归一化；结构不完整返回 undefined */
function normalizeRect(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const x = finite(raw.x);
  const y = finite(raw.y);
  const width = finite(raw.width);
  const height = finite(raw.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  return { x, y, width, height };
}

/**
 * 解析探测器的一轮输出，取最后一行能解析成 `{windows: [...]}` 的 JSON。
 * 解析不出来（崩溃、超时残留、输出被截断）返回 null，调用方按探测失败处理。
 * @param {string} stdout
 * @returns {{windows: Array<object>, menuBars: Array<object>, menuBarAutoHide: boolean} | null}
 */
function parseProbeOutput(stdout) {
  if (typeof stdout !== 'string') return null;
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    // 去掉 ANSI 前缀与首尾空白（osascript 偶发带控制序列）
    const line = lines[i].replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (!line.startsWith('{')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.windows)) continue;
    const windows = [];
    for (const raw of obj.windows) {
      const w = normalizeWindow(raw);
      if (w) windows.push(w);
    }
    const menuBars = [];
    if (Array.isArray(obj.menuBars)) {
      for (const raw of obj.menuBars) {
        const r = normalizeRect(raw);
        if (r) menuBars.push(r);
      }
    }
    return { windows, menuBars, menuBarAutoHide: obj.menuBarAutoHide === true };
  }
  return null;
}

/**
 * 全屏让位状态机。每轮喂一次探测器结果，取回本轮要执行的翻转（只在状态真正改变时下发）。
 *
 * 策略：
 * - 隐藏立即生效（一轮探测到全屏就藏），避免宠物压在全屏画面上；
 * - 恢复要连续 confirm 若干轮，躲开全屏进出动画期间窗口边界不稳定的抖动；
 * - 探测失败先冻结状态（不因一次抖动把宠物放出来），连续失败达上限后按空探测处理，
 *   保证宠物绝不永久留在隐藏态；
 * - skip 集合内的宠物本轮完全不参与判定（如渲染端正拿着鼠标拖拽，不在交互中途抽走窗口）。
 *
 * @param {{restoreTicks?: number, failTicks?: number}} [options]
 */
function createFullscreenGuard(options = {}) {
  const restoreTicks = Number.isFinite(options.restoreTicks) && options.restoreTicks > 0 ? options.restoreTicks : 2;
  const failTicks = Number.isFinite(options.failTicks) && options.failTicks > 0 ? options.failTicks : 3;
  /** 菜单栏信号要连续缺席这么多轮才算「被应用隐藏」：切换 Space 的动画帧里它会短暂缺席 */
  const menuBarConfirmTicks =
    Number.isFinite(options.menuBarConfirmTicks) && options.menuBarConfirmTicks > 0 ? options.menuBarConfirmTicks : 2;

  /** 当前判定为隐藏的宠物 id */
  const hidden = new Set();
  /** 各宠物连续探测为空（可恢复）的轮数 */
  const clearStreak = new Map();
  /** 各屏菜单栏连续缺席的轮数（下标 = screens 下标） */
  const menuBarHiddenStreak = new Map();
  /** 连续探测失败轮数 */
  let failStreak = 0;

  /**
   * 本轮哪些屏被其它应用全屏占用（两种口径取或，见文件头）。
   * @param {Array<{x:number,y:number,width:number,height:number,workArea?:object}>} screens 各显示器面板与工作区
   * @param {{windows: Array<object>, menuBars: Array<object>, menuBarAutoHide: boolean}} snapshot
   * @param {number} ownPid
   */
  function blockedScreens(screens, snapshot, ownPid) {
    const blocked = screens.map(() => false);
    const bars = Array.isArray(snapshot.menuBars) ? snapshot.menuBars : [];
    // 系统开了自动隐藏菜单栏时，「菜单栏不可见」不再代表全屏，第二条口径整体停用
    const useMenuBarSignal = snapshot.menuBarAutoHide !== true;
    // 每屏算一次（不是每窗口一次）：菜单栏连续缺席够多轮才算被应用隐藏
    const menuBarHidden = screens.map((screen, i) => {
      if (!useMenuBarSignal) {
        menuBarHiddenStreak.set(i, 0);
        return false;
      }
      if (menuBarVisible(screen, bars)) {
        menuBarHiddenStreak.set(i, 0);
        return false;
      }
      const streak = (menuBarHiddenStreak.get(i) ?? 0) + 1;
      menuBarHiddenStreak.set(i, streak);
      return streak >= menuBarConfirmTicks;
    });

    for (const win of snapshot.windows) {
      if (win.pid === ownPid) continue; // 自家窗口（宠物窗口本身）不算其它应用
      if (isBrowserWindow(win)) continue; // 浏览器全屏保留宠物
      for (let i = 0; i < screens.length; i++) {
        if (blocked[i]) continue;
        if (coversScreen(win, screens[i])) {
          blocked[i] = true; // 铺满整块面板
          continue;
        }
        const workArea = screens[i].workArea;
        if (menuBarHidden[i] && workArea && coversScreen(win, workArea)) {
          blocked[i] = true; // 铺满工作区 + 菜单栏被这个应用隐藏
        }
      }
    }
    return blocked;
  }

  return {
    /**
     * @param {object} input
     * @param {{windows: Array<object>, menuBars: Array<object>, menuBarAutoHide: boolean} | null | undefined} input.snapshot
     *   探测器一轮结果；null/undefined 表示本轮失败
     * @param {Array<{x:number,y:number,width:number,height:number,workArea?:object}>} input.screens 各显示器面板与工作区
     * @param {Array<{id: string, center: {x:number,y:number}}>} input.pets 各宠物窗口的中心点
     * @param {number} input.ownPid 本进程 pid
     * @param {Iterable<string>} [input.skip] 本轮不参与判定的宠物 id
     * @returns {{hide: string[], show: string[]}}
     */
    update(input) {
      const screens = Array.isArray(input?.screens) ? input.screens : [];
      const pets = Array.isArray(input?.pets) ? input.pets : [];
      const skip = new Set(input?.skip ?? []);
      const snapshot = input?.snapshot ?? null;

      // 探测失败：先冻结；连续失败够多则按空探测走（宁可放出来，也不把宠物永久关在隐藏态）
      let effective = snapshot;
      if (snapshot === null) {
        failStreak += 1;
        if (failStreak < failTicks) return { hide: [], show: [] };
        effective = EMPTY_SNAPSHOT;
      } else {
        failStreak = 0;
      }

      const blocked = blockedScreens(screens, effective, input?.ownPid);
      const hide = [];
      const show = [];

      for (const pet of pets) {
        if (!pet || typeof pet.id !== 'string' || skip.has(pet.id)) continue;
        const idx = screenIndexAt(screens, pet.center);
        const busy = idx >= 0 && blocked[idx];
        if (busy) {
          clearStreak.set(pet.id, 0);
          if (!hidden.has(pet.id)) {
            hidden.add(pet.id);
            hide.push(pet.id);
          }
          continue;
        }
        const streak = (clearStreak.get(pet.id) ?? 0) + 1;
        clearStreak.set(pet.id, streak);
        if (hidden.has(pet.id) && streak >= restoreTicks) {
          hidden.delete(pet.id);
          show.push(pet.id);
        }
      }

      return { hide, show };
    },
  };
}

/**
 * 全屏让位在本平台是否可用：**仅 macOS**。
 *
 * 平台例外与判定规则一样住在本模块（main.js 只接线）：本模块有单测，判断写在那边等于绕过测试。
 * Windows / Linux 没有对应的探测实现（fullscreen-probe.jxa 是 osascript 脚本）。
 */
function fullscreenGuardSupported() {
  return process.platform === 'darwin';
}

module.exports = {
  COVER_TOLERANCE,
  MENU_BAR_MAX_HEIGHT,
  BROWSER_BUNDLES,
  BROWSER_NAMES,
  isBrowserWindow,
  coversScreen,
  screenIndexAt,
  menuBarVisible,
  parseProbeOutput,
  createFullscreenGuard,
  fullscreenGuardSupported,
};
