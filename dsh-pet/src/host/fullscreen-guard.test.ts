/**
 * 桌面 helper「其它应用全屏时宠物让位」的判定测试。
 *
 * 需求：其它应用（视频播放器、演示、会议等）全屏占用某块屏时，该屏上的桌面宠物自动隐藏，
 * 退出全屏后恢复。浏览器不算其它应用：全屏看 DSH Web GUI 时宠物必须保留，因为桌面宠物
 * 本来就为陪 DSH 而生，把宿主自己的全屏也算进去等于把宠物从主场景里删掉。
 *
 * 本文件钉住四件事：
 *
 * - 覆盖判定：整屏窗口算全屏，只铺到工作区、不盖菜单栏的不算；
 * - 浏览器白名单：bundle id 为主，应用名兜底；
 * - 状态机：隐藏立即生效，恢复要连续确认，探测失败不把宠物永久留在隐藏态；
 * - 源码守卫：helper 主进程确实接上了轮询与 hide/show，探测脚本确实在包里。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = '../../runtime/electron-helper/';
const {
  coversScreen,
  isBrowserWindow,
  screenIndexAt,
  menuBarVisible,
  parseProbeOutput,
  createFullscreenGuard,
} = require(helper + 'fullscreen-guard.js');

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 单屏：面板 1800×1169，工作区 1800×1130（菜单栏占顶部 39px） */
const SCREEN = { x: 0, y: 0, width: 1800, height: 1169 };

/** 整屏全屏窗口（原生全屏：铺满整个面板，含菜单栏区域） */
const fullWindow = (over: Record<string, unknown> = {}) => ({
  pid: 4711,
  app: '芒果TV',
  bundle: 'com.mgtv.pcclientx',
  x: 0,
  y: 0,
  width: 1800,
  height: 1169,
  ...over,
});

/** 只铺到工作区的普通最大化窗口（菜单栏仍在，不算全屏） */
const workAreaWindow = {
  pid: 4711,
  app: 'Code',
  bundle: 'com.microsoft.VSCode',
  x: 0,
  y: 39,
  width: 1800,
  height: 1130,
};

describe('覆盖判定（coversScreen）', () => {
  test('铺满整块面板的窗口算覆盖', () => {
    assert.equal(coversScreen(fullWindow(), SCREEN), true);
  });

  test('只铺到工作区、不盖菜单栏的窗口不算覆盖', () => {
    assert.equal(coversScreen(workAreaWindow, SCREEN), false);
  });

  test('四边各有数像素取整误差时仍算覆盖', () => {
    const win = fullWindow({ x: 2, y: 1, width: 1797, height: 1167 });
    assert.equal(coversScreen(win, SCREEN), true);
    const trimmed = fullWindow({ x: 0, y: 12, width: 1800, height: 1157 }); // 顶部少了 12px：不是全屏
    assert.equal(coversScreen(trimmed, SCREEN), false);
  });

  test('半屏窗口不算覆盖', () => {
    assert.equal(coversScreen(fullWindow({ width: 900, height: 1169 }), SCREEN), false);
  });
});

describe('浏览器白名单（isBrowserWindow）', () => {
  test('主流浏览器按 bundle id 识别', () => {
    for (const bundle of ['com.google.Chrome', 'com.apple.Safari', 'org.mozilla.firefox', 'com.microsoft.edgemac']) {
      assert.equal(isBrowserWindow({ app: '任意本地化名', bundle }), true);
    }
  });

  test('bundle 取不到时才按应用名兜底', () => {
    assert.equal(isBrowserWindow({ app: 'Google Chrome', bundle: '' }), true);
    assert.equal(isBrowserWindow({ app: 'Safari', bundle: '' }), true);
    // bundle 能取到就以它为准：名字不再兜底（否则 Chrome 应用会被误判成浏览器）
    assert.equal(isBrowserWindow({ app: 'Safari', bundle: 'com.apple.unknown' }), false);
  });

  test('Chrome 应用（app 模式 / PWA）与普通 Chrome 窗口区分得开，前者照常让位', () => {
    // 实测：云游戏以 Chrome 应用窗口运行，bundle = com.google.Chrome.app.<app-id>，独立进程
    const chromeApp = { app: '云·鸣潮', bundle: 'com.google.Chrome.app.pjeoochmfpenepkfnegmolcalfepjohi' };
    assert.equal(isBrowserWindow(chromeApp), false);
    assert.equal(isBrowserWindow({ app: 'Google Chrome', bundle: 'com.google.Chrome' }), true);
    // 即使这类窗口的 owner 名写成 Google Chrome，bundle 仍然说了算
    assert.equal(isBrowserWindow({ app: 'Google Chrome', bundle: 'com.google.Chrome.app.xyz' }), false);
  });

  test('非浏览器应用不算（含名字相近的）', () => {
    assert.equal(isBrowserWindow({ app: '芒果TV', bundle: 'com.mgtv.pcclientx' }), false);
    assert.equal(isBrowserWindow({ app: 'Google Chrome Helper', bundle: 'com.google.Chrome.helper' }), false);
    assert.equal(isBrowserWindow({ app: '', bundle: '' }), false);
  });
});

describe('屏归属（screenIndexAt）', () => {
  test('落在某屏内返回该屏下标，屏外返回 -1', () => {
    const screens = [SCREEN, { x: 1800, y: 0, width: 1440, height: 900 }];
    assert.equal(screenIndexAt(screens, { x: 10, y: 10 }), 0);
    assert.equal(screenIndexAt(screens, { x: 2000, y: 100 }), 1);
    assert.equal(screenIndexAt(screens, { x: -5, y: 10 }), -1);
  });
});

describe('探测器输出解析（parseProbeOutput）', () => {
  test('解析正常输出（窗口 + 菜单栏窗口 + 自动隐藏开关）', () => {
    const out = parseProbeOutput(
      '{"v":2,"menuBarAutoHide":false,"menuBars":[{"x":0,"y":0,"width":1800,"height":39}],' +
        '"windows":[{"pid":7,"app":"X","bundle":"a.b","x":0,"y":0,"width":1,"height":2}]}\n',
    );
    assert.equal(out?.windows.length, 1);
    assert.deepEqual(out?.windows[0], { pid: 7, app: 'X', bundle: 'a.b', x: 0, y: 0, width: 1, height: 2 });
    assert.deepEqual(out?.menuBars, [{ x: 0, y: 0, width: 1800, height: 39 }]);
    assert.equal(out?.menuBarAutoHide, false);
  });

  test('空窗口列表是合法结果（当前没有全屏应用）', () => {
    assert.deepEqual(parseProbeOutput('{"v":1,"windows":[]}'), {
      windows: [],
      menuBars: [],
      menuBarAutoHide: false,
    });
  });

  test('坏 JSON、缺 windows、非数组一律 null（调用方按探测失败处理）', () => {
    assert.equal(parseProbeOutput(''), null);
    assert.equal(parseProbeOutput('osascript: something went wrong'), null);
    assert.equal(parseProbeOutput('{"v":1}'), null);
    assert.equal(parseProbeOutput('{"v":1,"windows":{}}'), null);
  });

  test('脏窗口条目被丢弃，合法条目保留（少一条不放大成整轮失败）', () => {
    const raw = JSON.stringify({
      v: 1,
      windows: [fullWindow(), { pid: 'x', x: 0, y: 0, width: 1, height: 1 }, { pid: 9, app: 'Y' }],
      menuBars: [{ x: 0, y: 0, width: 1800, height: 39 }, { x: 'bad' }],
    });
    const out = parseProbeOutput(raw);
    assert.equal(out?.windows.length, 1);
    assert.equal(out?.windows[0].pid, 4711);
    assert.deepEqual(out?.menuBars, [{ x: 0, y: 0, width: 1800, height: 39 }]);
  });

  test('容忍 ANSI 前缀与多行输出（取最后一行合法 JSON）', () => {
    const raw = '\u001b[Kwarning: something\n{"v":1,"windows":[]}\n';
    assert.deepEqual(parseProbeOutput(raw)?.windows, []);
  });
});

describe('菜单栏可见性（menuBarVisible）', () => {
  const BAR = { x: 0, y: 0, width: 1800, height: 39 };

  test('该屏顶部有菜单栏窗口即为可见', () => {
    assert.equal(menuBarVisible(SCREEN, [BAR]), true);
  });

  test('列表里没有菜单栏 = 被应用隐藏（应用在做系统级全屏展示）', () => {
    assert.equal(menuBarVisible(SCREEN, []), false);
  });

  test('菜单栏在另一块屏上不算本屏可见', () => {
    assert.equal(menuBarVisible(SCREEN, [{ ...BAR, x: 1800 }]), false);
  });

  test('同一屏里高度异常的浮层不算菜单栏', () => {
    assert.equal(menuBarVisible(SCREEN, [{ ...BAR, height: 400 }]), false);
  });
});

describe('状态机（createFullscreenGuard）', () => {
  const petsOf = (...ids: string[]) => ids.map((id, i) => ({ id, center: { x: 100 + i * 10, y: 100 + i * 10 } }));
  /** 面板 1800×1169 与工作区 1800×1130@0,39（菜单栏占顶部 39px） */
  const SCREENS = [{ ...SCREEN, workArea: { x: 0, y: 39, width: 1800, height: 1130 } }];
  const MENU_BAR = { x: 0, y: 0, width: 1800, height: 39 };
  /** 探测器一轮结果；默认菜单栏可见（menuBar: false 表示菜单栏被应用隐藏） */
  const snap = (windows: unknown[], opts: { menuBar?: boolean; autoHide?: boolean } = {}) => ({
    windows,
    menuBars: opts.menuBar === false ? [] : [MENU_BAR],
    menuBarAutoHide: opts.autoHide === true,
  });
  /** 探测定为全屏 / 定为空 / 探测失败三种输入的固定屏幕与宠物参数 */
  const arg = (snapshot: unknown) => ({ snapshot, screens: SCREENS, pets: petsOf('main'), ownPid: 999 });

  test('首次探测到全屏即隐藏，退出全屏需连续确认才恢复', () => {
    const guard = createFullscreenGuard({ restoreTicks: 2 });
    const blocked = snap([fullWindow()]);
    const clear = snap([]);

    assert.deepEqual(guard.update(arg(blocked)), { hide: ['main'], show: [] });
    // 已隐藏：再次探测到全屏不重复下发
    assert.deepEqual(guard.update(arg(blocked)), { hide: [], show: [] });
    // 第一次空探测：恢复确认未满，保持隐藏
    assert.deepEqual(guard.update(arg(clear)), { hide: [], show: [] });
    assert.deepEqual(guard.update(arg(clear)), { hide: [], show: ['main'] });
  });

  test('恢复确认中途又出现全屏：确认计数清零，继续隐藏', () => {
    const guard = createFullscreenGuard({ restoreTicks: 2 });
    const blocked = snap([fullWindow()]);
    const clear = snap([]);

    guard.update(arg(blocked));
    guard.update(arg(clear)); // 确认 1/2
    guard.update(arg(blocked)); // 又满了：清零
    assert.deepEqual(guard.update(arg(clear)), { hide: [], show: [] });
    assert.deepEqual(guard.update(arg(clear)), { hide: [], show: ['main'] });
  });

  test('浏览器全屏不隐藏', () => {
    const guard = createFullscreenGuard();
    const chromeFull = snap([fullWindow({ app: 'Google Chrome', bundle: 'com.google.Chrome' })]);
    assert.deepEqual(guard.update(arg(chromeFull)), { hide: [], show: [] });
  });

  test('本进程自己的窗口不算其它应用', () => {
    const guard = createFullscreenGuard();
    const own = snap([fullWindow({ pid: 999, app: 'Electron', bundle: 'com.github.Electron' })]);
    assert.deepEqual(guard.update(arg(own)), { hide: [], show: [] });
  });

  test('多屏：只隐藏被占用那块屏上的宠物', () => {
    const screens = [SCREEN, { x: 1800, y: 0, width: 1440, height: 900 }];
    const pets = [
      { id: 'left', center: { x: 100, y: 100 } },
      { id: 'right', center: { x: 2000, y: 100 } },
    ];
    const guard = createFullscreenGuard();
    const blockedRight = snap([fullWindow({ x: 1800, y: 0, width: 1440, height: 900 })]);
    assert.deepEqual(guard.update({ snapshot: blockedRight, screens, pets, ownPid: 999 }), {
      hide: ['right'],
      show: [],
    });
  });

  test('宠物中心落在所有屏之外时不判定', () => {
    const guard = createFullscreenGuard();
    const pets = [{ id: 'ghost', center: { x: 5000, y: 5000 } }];
    assert.deepEqual(guard.update({ snapshot: snap([fullWindow()]), screens: [SCREEN], pets, ownPid: 999 }), {
      hide: [],
      show: [],
    });
  });

  test('skip 集合内的宠物本轮不动（既不隐藏也不恢复）', () => {
    const guard = createFullscreenGuard();
    const withSkip = (skip?: string[]) => ({ ...arg(snap([fullWindow()])), skip });
    assert.deepEqual(guard.update(withSkip(['main'])), { hide: [], show: [] });
    // 下一轮不再 skip：立刻补上隐藏
    assert.deepEqual(guard.update(withSkip()), { hide: ['main'], show: [] });
  });

  test('探测失败先冻结状态，连续失败达上限后按空探测恢复（不永久留在隐藏态）', () => {
    const guard = createFullscreenGuard({ restoreTicks: 2, failTicks: 3 });

    assert.deepEqual(guard.update(arg(snap([fullWindow()]))), { hide: ['main'], show: [] });
    // 连续 2 次失败：冻结，仍旧隐藏
    assert.deepEqual(guard.update(arg(null)), { hide: [], show: [] });
    assert.deepEqual(guard.update(arg(null)), { hide: [], show: [] });
    // 第 3 次失败起按空探测处理，走恢复确认
    assert.deepEqual(guard.update(arg(null)), { hide: [], show: [] });
    assert.deepEqual(guard.update(arg(null)), { hide: [], show: ['main'] });
  });

  test('探测恢复成功后失败计数清零', () => {
    const guard = createFullscreenGuard({ restoreTicks: 1, failTicks: 2 });
    guard.update(arg(null));
    guard.update(arg(snap([]))); // 成功一轮：清零
    guard.update(arg(null));
    assert.deepEqual(guard.update(arg(null)), { hide: [], show: [] }); // 未被当成连续 2 次失败
  });

  test('无边框全屏：铺满工作区 + 菜单栏连续缺席 → 隐藏', () => {
    // 云游戏客户端这类全屏：窗口只铺满工作区，与普通最大化窗口几何完全相同
    const game = fullWindow({ app: '云·绝区零', bundle: 'com.miHoYo.cloudgames.Nap', y: 39, height: 1130 });
    const guard = createFullscreenGuard();
    const hidden = snap([game], { menuBar: false });
    // 切换 Space 的动画帧里菜单栏会短暂缺席：单轮缺席不触发
    assert.deepEqual(guard.update(arg(hidden)), { hide: [], show: [] });
    assert.deepEqual(guard.update(arg(hidden)), { hide: ['main'], show: [] });
  });

  test('菜单栏只缺席一轮（切屏动画）不会误藏宠物', () => {
    const game = fullWindow({ app: '云·绝区零', bundle: 'com.miHoYo.cloudgames.Nap', y: 39, height: 1130 });
    const guard = createFullscreenGuard();
    guard.update(arg(snap([game], { menuBar: false }))); // 动画帧
    assert.deepEqual(guard.update(arg(snap([game]))), { hide: [], show: [] }); // 菜单栏回来了：清零
    assert.deepEqual(guard.update(arg(snap([game], { menuBar: false }))), { hide: [], show: [] });
    assert.deepEqual(guard.update(arg(snap([game], { menuBar: false }))), { hide: ['main'], show: [] });
  });

  test('普通最大化窗口（菜单栏还在）不隐藏', () => {
    const game = fullWindow({ app: '云·绝区零', bundle: 'com.miHoYo.cloudgames.Nap', y: 39, height: 1130 });
    const guard = createFullscreenGuard();
    assert.deepEqual(guard.update(arg(snap([game]))), { hide: [], show: [] });
  });

  test('窗口没铺满工作区时不隐藏（哪怕菜单栏被隐藏）', () => {
    const partial = fullWindow({ y: 39, width: 900, height: 1130 });
    const guard = createFullscreenGuard();
    assert.deepEqual(guard.update(arg(snap([partial], { menuBar: false }))), { hide: [], show: [] });
  });

  test('铺满工作区的是浏览器时不隐藏（全屏看 DSH 保留宠物）', () => {
    const chrome = fullWindow({ app: 'Google Chrome', bundle: 'com.google.Chrome', y: 39, height: 1130 });
    const guard = createFullscreenGuard();
    assert.deepEqual(guard.update(arg(snap([chrome], { menuBar: false }))), { hide: [], show: [] });
  });

  test('系统开了自动隐藏菜单栏时该口径停用，铺满整块面板那条仍生效', () => {
    const game = fullWindow({ app: '云·绝区零', bundle: 'com.miHoYo.cloudgames.Nap', y: 39, height: 1130 });
    const guard = createFullscreenGuard();
    assert.deepEqual(guard.update(arg(snap([game], { menuBar: false, autoHide: true }))), { hide: [], show: [] });
    assert.deepEqual(guard.update(arg(snap([fullWindow()], { menuBar: false, autoHide: true }))), {
      hide: ['main'],
      show: [],
    });
  });
});

describe('源码守卫：主进程接线与探测脚本在位', () => {
  test('探测脚本随包发布', () => {
    assert.equal(existsSync(fileURLToPath(new URL(helper + 'fullscreen-probe.jxa', import.meta.url))), true);
    assert.equal(existsSync(fileURLToPath(new URL(helper + 'fullscreen-guard.js', import.meta.url))), true);
  });

  test('运行时脚本都能被 Node 解析（重名声明、漏括号这类错会让桌宠启动即崩）', () => {
    // runtime/ 被 eslint 整体忽略、也不进 tsc，语法错只能在桌宠真正启动那一刻炸出来。
    // 这里补一道廉价的全量语法检查：main.js 曾因与 fullscreen-guard 的同名导出撞名而整份解析失败。
    for (const rel of ['main.js', 'fullscreen-guard.js', 'pointer-target.js']) {
      execFileSync(process.execPath, ['--check', fileURLToPath(new URL(helper + rel, import.meta.url))], {
        stdio: 'pipe',
      });
    }
    // 探测脚本是 .jxa（node --check 不认这个扩展名），改用只编译不执行的语法检查
    assert.doesNotThrow(() => new Function(readSource(helper + 'fullscreen-probe.jxa')));
  });

  test('主进程加载判定模块并按开关决定是否启用', () => {
    const src = readSource('../../runtime/electron-helper/main.js');
    assert.match(src, /require\(['"]\.\/fullscreen-guard\.js['"]\)/);
    assert.match(src, /DSH_PET_HIDE_ON_FULLSCREEN/);
    // 让位必须靠 hide()/show() 落地，并被某个轮询驱动
    assert.match(src, /\.hide\(\)/);
    assert.match(src, /setInterval\([\s\S]{0,400}?fullscreen/i);
  });

  test('探测脚本走 ObjC 桥取窗口列表，不依赖任何 npm 依赖', () => {
    const probe = readSource(helper + 'fullscreen-probe.jxa');
    assert.match(probe, /CGWindowListCopyWindowInfo/);
    assert.match(probe, /kCGWindowLayer/);
    assert.doesNotMatch(probe, /require\(/);
  });
});
