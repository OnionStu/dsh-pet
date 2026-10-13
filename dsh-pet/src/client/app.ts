// client 半侧「装配层」：注入 react → 组装两个页面组件 → 注册进 DSH 插槽。
// 页面代码不在本文件：宠物页面在 pet.ts，设置页在 settings.ts——
// 类似 Vue 的 App.vue 只挂根组件、SpringBoot 启动类只做装配，不写页面业务。
import { makePetUI } from './pet';
import { makePetConfigSection, NS, zh, en, petBridge } from './settings';
import { startNotify } from './notify';
import { startApprovalAlerts } from './approvals';
import { startSessionDeepLink, type SessionListLike } from './session-deeplink';
import { SESSION_DEEPLINK_PARAM, sessionDeepLink } from '../shared/alerts';
import type * as ReactNS from 'react';

/**
 * 返回 DSH 插件 factory：`(require) => module`。
 * 插件三件套（name / inject / apply）都在其返回的 module 上。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH __ModuleLoader__ 契约（f(require) => module），外部无静态类型
export function makeFactory(): (require: (mod: string) => any) => any {
  return (require) => {
    const module = { exports: {} };

    const react: typeof ReactNS = require('react');
    const { useEffect, useRef, useState } = react;
    const { jsx: h } = require('react/jsx-runtime');

    // 宠物页面（overlay）与配置设置页：组件各自独立文件，这里只组装 + 注册
    const PetMulti = makePetUI({ h, useState, useEffect, useRef });

    const name = 'pet';
    // commandUi 写成服务依赖（与官方 client-ui-permission-presets 的写法一致）：
    // 让 cordis 等「/」命令入口服务就绪后才 apply 本插件，保证 /pet 装饰必然注册成功。
    // uiSession/sessions：跨会话提醒的数据源（当前会话过滤、会话列表）与会话切换列表；
    // uiWorkspace.openSession：0.2 的切会话入口（原 ctx.sessions.open 已移除）。
    // 声明为服务依赖保证 apply 时三个服务已就绪。
    const inject = ['slots', 'locale', 'connection', 'remote', 'remote.commands', 'commandUi', 'uiSession', 'sessions', 'uiWorkspace'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（locale/slots/webServer 等 service 无静态类型）
    function apply(ctx: any) {
      // 本地化字典（设置页文案）
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-pet: dictionaries');
      const t = ctx.locale.bind(NS);

      // 系统通知：host 侧监听 DSH 宿主事件生成通知帧（/dsh-pet-7340/notify），本引擎轮询拉取。
      // 不再依赖浏览器 connection 事件流（DSH 0.1.5 删除了 api.events.mux/host）——
      // 启动仅需 AbortSignal，host 端点缺失时轮询静默失败，不影响页面其余功能。
      // ctx 注入跨会话归属：帧带 sessionId 且不属于当前会话时，即使页面聚焦也弹 toast（点击可跳会话）。
      ctx.effect(() => {
        const ac = new AbortController();
        void startNotify(ctx, ac.signal);
        return () => ac.abort();
      }, 'dsh-pet: notifications');

      // 跨会话提醒浮层（宠物头顶卡片 + 标签页 [N 待处理] 角标），两路数据源：
      //   ① 审批/选择题：轮询 host /alerts（0.2 移除了 uiSession.pendingInteractions 读面）；
      //   ② 重启提醒：轮询 host /restart-notice（agent 调 notify_restart_required 工具写入）。
      // 两路各自降级，缺一路不影响另一路。
      ctx.effect(() => {
        const ac = new AbortController();
        startApprovalAlerts(ctx, ac.signal);
        return () => ac.abort();
      }, 'dsh-pet: cross-session alerts');

      // 桌面提醒卡的「点一行跳会话」深链：桌面端（Electron 透明窗）没有切会话的客户端 API，
      // 它的做法是用系统浏览器打开 `?dsh-pet-session=<id>`，由这里读参数、等会话列表到达再切会话。
      // 不能固定延时一拍就切：实测约 300ms 时会话列表还没到，open 抛错被吞掉，
      // 跳转就此丢失（详见 client/session-deeplink.ts 头注释）。
      ctx.effect(() => {
        const sessionId = sessionDeepLink(window.location.search);
        if (!sessionId) return () => {};
        return startSessionDeepLink({
          sessionId,
          list: (ctx as { sessions?: { list?: SessionListLike } }).sessions?.list,
          // 0.2 的切会话入口是 uiWorkspace.openSession：用闭包包住调用保住类方法的接收者
          open: (id: string) => {
            const workspace = (ctx as { uiWorkspace?: { openSession?: (target: string) => void } }).uiWorkspace;
            if (typeof workspace?.openSession !== 'function') throw new Error('uiWorkspace.openSession 不可用');
            workspace.openSession(id);
          },
          clearParam: () => {
            const url = new URL(window.location.href);
            url.searchParams.delete(SESSION_DEEPLINK_PARAM);
            window.history.replaceState(null, '', url.pathname + url.search + url.hash);
          },
        });
      }, 'dsh-pet: session deep link');

      // /pet 选择框：裸输 /pet 回车或菜单点选时弹出桌宠列表，选中后提交 /pet <id> 由 host 命令落地。
      // commandUi 已声明为服务依赖（上方 inject）：插件只在「/」命令服务就绪后 apply，
      // 装饰注册有保障；仍保留缺失时的降级提示，防止异常装配下静默失效。
      ctx.effect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入服务无静态类型
        const commandUi = (ctx as any).get?.('commandUi');
        if (!commandUi || typeof commandUi.decorate !== 'function') {
          console.warn('[dsh-pet] 命令选择框不可用：commandUi 服务缺失（/pet 仍可手输 id 或名字）');
          return () => {};
        }
        return commandUi.decorate({
          name: 'pet',
          available: () => true,
          ui: {
            kind: 'popupSelect',
            // 选项 = 当前生效宠物列表（petBridge.current：主宠物 + 文件宠物，name 已兜底）
            options: async () =>
              petBridge.current.map((p) => ({
                id: p.id,
                label: p.name || p.id,
                detail: (p.assetRoot && p.assetRoot !== p.id ? p.assetRoot + ' / ' : '') + p.id,
              })),
            // 选中 → 提交 /pet <id>（host handler 校验并设置当前桌宠，命令节点回显名字）
            onSelect: async (option: { id: string }, session: { sessionId: string }) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- remote 无静态类型
              await (ctx as any).remote?.commands?.execute(session.sessionId, '/pet ' + option.id, []);
            },
          },
        });
      }, 'dsh-pet: /pet picker');

      // 宠物 overlay（多开：容器渲染多个 PetCard）
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({ name: 'shell.overlay', id: 'pet', order: 1000 }, () => h(PetMulti, {}));
      });

      // 设置页：「桌宠配置」（大小/位置，保存即时生效）
      const PetConfigSection = makePetConfigSection({ h, useState, useEffect, t });
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          { name: 'settings.section', id: 'pet-config', order: 30, label: () => t('nav'), inject: () => ({ t }) },
          PetConfigSection,
        );
      });
    }

    module.exports = { apply, inject, name };
    return module.exports;
  };
}
