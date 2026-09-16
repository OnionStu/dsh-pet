/**
 * 桌面 helper「点击穿透兜底通道」的判定测试（采纳 issue #55 报告者的补丁）。
 *
 * 背景：窗口默认整窗点击穿透，只靠 Electron 的 forward 低级鼠标钩子把 mousemove 转发进渲染端做命中
 * 判定——**整条链路只有一个入口**。该钩子在 Windows 上会静默失效（回调超时被系统摘掉 / 被别的软件
 * 的钩子干扰），失效后没有任何退路：光标悬浮不触发手套光标、拖不动、点击与右键全无反应。
 * 报告者的修法：主进程按**真实光标位置**独立判定并翻转，不依赖那条转发链路。
 *
 * 本文件把三件事钉住：
 *   ① 判定规则（宠物身上=可交互；窗口余量区=**保持当前**，菜单/弹窗才点得到；窗外=穿透）；
 *   ② 几何：窗口矩形 → 宠物身体命中区（必须与渲染端 sprite.js 的命中判定同源，否则两条通道打架）；
 *   ③ 源码守卫：helper 的 main.js 里必须有兜底显示与兜底轮询（Electron 起不来，只能读源码断言）。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = '../../runtime/electron-helper/';
const { HIT_BOX, CANVAS_H, STAGE_W, spriteHitRect, decideWindowIgnore } = require(helper + 'pointer-target.js');

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 真实窗口矩形（DIP）：宠物 size 462 → 窗口 = 462 + 两侧各 231 = 924；高度 = 画布 + bottomPad + 两侧余量 */
const bounds = { x: 1000, y: 500, width: 924, height: 743 };

describe('decideWindowIgnore —— 兜底通道的判定规则（issue #55 报告者实测表）', () => {
  test('光标在宠物身体上 → 不穿透（可交互）', () => {
    const r = spriteHitRect(bounds);
    const center = { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
    assert.equal(decideWindowIgnore(bounds, center, true), false);
    assert.equal(decideWindowIgnore(bounds, center, false), false);
  });

  test('窗口余量区保持当前状态：当前可交互则维持（自绘菜单/弹窗点得到）、当前穿透则维持穿透', () => {
    const margin = { x: bounds.x + 20, y: bounds.y + 20 }; // 窗口左上角余量区（宠物外）
    assert.equal(decideWindowIgnore(bounds, margin, false), false, '菜单打开时鼠标移到余量区不得翻回穿透');
    assert.equal(decideWindowIgnore(bounds, margin, true), true, '没交互时余量区必须保持穿透，不挡桌面图标');
  });

  test('光标在窗口外 → 恢复穿透（四个方向）', () => {
    const cases = [
      { x: bounds.x - 1, y: bounds.y + 100 },
      { x: bounds.x + bounds.width, y: bounds.y + 100 },
      { x: bounds.x + 100, y: bounds.y - 1 },
      { x: bounds.x + 100, y: bounds.y + bounds.height },
    ];
    for (const p of cases) assert.equal(decideWindowIgnore(bounds, p, false), true, JSON.stringify(p));
  });

  test('边界取整：窗口左上角算窗口内、右下角算窗口外', () => {
    assert.equal(decideWindowIgnore(bounds, { x: bounds.x, y: bounds.y }, false), false);
    assert.equal(
      decideWindowIgnore(bounds, { x: bounds.x + bounds.width - 1, y: bounds.y + bounds.height - 1 }, false),
      false,
    );
  });

  test('窗口尺寸未落定（renderer 首帧上报前）不误判：极小矩形内不产生"可交互"', () => {
    const tiny = { x: 0, y: 0, width: 4, height: 4 };
    assert.equal(decideWindowIgnore(tiny, { x: 0, y: 0 }, true), true);
  });
});

describe('spriteHitRect —— 与渲染端命中判定同源（否则两条通道会互相翻回来）', () => {
  test('size 462 的真实窗口：命中区落在身体矩形内，且中心 = 窗口中心（真机实测一致）', () => {
    const r = spriteHitRect(bounds);
    // 窗口 = 画布 + 两侧各 margin(231)；画布 462×260，身体命中区取画布 640×360 的 200..440 / 50..335
    const margin = 231;
    const stageH = (462 * CANVAS_H) / STAGE_W;
    const near = (actual: number, expected: number) => Math.abs(actual - expected) < 0.01;
    assert.ok(near(r.left, bounds.x + margin + (200 / STAGE_W) * 462), 'left=' + r.left);
    assert.ok(near(r.right, bounds.x + margin + (440 / STAGE_W) * 462), 'right=' + r.right);
    assert.ok(near(r.top, bounds.y + margin + (50 / CANVAS_H) * stageH), 'top=' + r.top);
    assert.ok(near(r.bottom, bounds.y + margin + (335 / CANVAS_H) * stageH), 'bottom=' + r.bottom);
    // 命中区必须完全落在窗口内（否则永远不会触发 + 会误判窗外）
    assert.ok(r.left > bounds.x && r.right < bounds.x + bounds.width);
    assert.ok(r.top > bounds.y && r.bottom < bounds.y + bounds.height);
    // 与真机实测的落点一致：我把光标注入到窗口中心时，命中区中心正是窗口中心
    assert.ok(Math.abs((r.left + r.right) / 2 - (bounds.x + bounds.width / 2)) < 0.01);
  });

  test('命中区随窗口尺寸等比缩放（宠物放大/缩小后仍对得上）', () => {
    const small = { x: 0, y: 0, width: 600, height: 482 }; // size 300：300 + 两侧各 150
    const r = spriteHitRect(small);
    assert.ok(r.left > 150 && r.left < 300);
    assert.ok(r.right > 300 && r.right < 450);
  });
});

describe('源码守卫 —— helper 的两个兜底必须在位', () => {
  const main = readSource(helper + 'main.js');

  test('#55-1 兜底显示：ready-to-show 之外还要有"加载完成后仍未显示就 show"', () => {
    assert.ok(/once\('ready-to-show', \(\) => win\.show\(\)\)/.test(main), 'ready-to-show 的正常路径不能删');
    assert.ok(
      /once\('did-finish-load'/.test(main),
      '必须有 did-finish-load 兜底（paintWhenInitiallyHidden:false 时 ready-to-show 永不触发）',
    );
    assert.ok(
      /!win\.isDestroyed\(\) && !win\.isVisible\(\)\) win\.show\(\)/.test(main),
      '兜底必须在"仍未显示"时才 show',
    );
  });

  test('#55-2 兜底轮询：主进程按真实光标独立判定，且与渲染端通道共用同一出口', () => {
    assert.ok(/decideWindowIgnore\(/.test(main), '必须调用纯判定（不依赖 forward 鼠标钩子）');
    assert.ok(/screen\.getCursorScreenPoint\(\)/.test(main), '必须读真实光标位置');
    assert.ok(/POINTER_POLL_MS/.test(main), '轮询间隔必须是命名常量（60ms）');
    assert.ok(
      (main.match(/setWindowIgnore\(/g) ?? []).length >= 3,
      '所有翻转必须走 setWindowIgnore（创建 / IPC / 兜底轮询），镜像状态才不失步',
    );
    assert.ok(
      !/win\.setIgnoreMouseEvents\(/.test(main.replace(/function setWindowIgnore[\s\S]*?\n}/, '')),
      '不得再有绕过出口的直接调用',
    );
    assert.ok(/clearInterval\(pointerTimer\)/.test(main), '窗口关闭时必须停掉轮询');
  });
});

describe('守卫：主进程镜像的命中盒常量不得与 src/shared/constants.ts 漂移', () => {
  test('HIT_BOX / CANVAS_H 与 shared 常量一致，画布宽沿用同一约定（字面量 640）', () => {
    const shared = readSource('../shared/constants.ts');
    const num = (name: string): number => {
      const m = new RegExp(String.raw`export const ${name} = (\d+)`).exec(shared);
      assert.ok(m, 'shared 里找不到 ' + name);
      return Number(m[1]);
    };
    assert.equal(CANVAS_H, num('CANVAS_H'));
    const hit = /export const HIT_BOX = \{ x0: (\d+), y0: (\d+), x1: (\d+), y1: (\d+) \}/.exec(shared);
    assert.ok(hit, 'shared 里的 HIT_BOX 形状变了，请同步 pointer-target.js');
    assert.deepEqual(HIT_BOX, { x0: Number(hit[1]), y0: Number(hit[2]), x1: Number(hit[3]), y1: Number(hit[4]) });
    // 画布宽 shared 没有导出（各处都用字面量 640）：这里断言渲染端也是同一约定，避免我们把宽写成别的值
    assert.equal(STAGE_W, 640);
    assert.ok(
      /S\.HIT_BOX\.x0 \/ 640/.test(readSource(helper + 'sprite.js')),
      'sprite.js 的命中判定用 640 作画布宽——两边必须同一约定',
    );
  });
});
