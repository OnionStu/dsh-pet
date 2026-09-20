/**
 * 「需要重启宿主」提醒（host 半侧，自包含，不 import src/shared —— DSH 单文件加载约束）。
 *
 * 背景：DSH 宿主事件表里**没有**「需要重启」这种结构化信号（turn/end、approval/asked、
 * tool/call、assistant/message… 都没有）。这件事只存在于助手输出的自然语言里，靠文本
 * 关键词匹配必然误报（讨论重启规则、读 AGENTS.md 都会命中）。因此改为**显式标记**：
 * 本模块注册一个工具，agent 在「改动已做完、必须由用户重启宿主才生效」时主动调用它。
 *
 * 数据流：
 *   agent 调 notify_restart_required
 *     → 本模块的内存 Map<sessionId, RestartNotice>（进程内，宿主重启即清空）
 *     → GET /dsh-pet-7340/restart-notice（浏览器 1s 轮询，与 notify/work-status 同族）
 *     → 宠物头顶提醒卡 + 标签页角标（渲染在 client/approvals.ts 的浮层里）
 *
 * 生命周期：**不设过期**——「用户真的重启了」就是天然的消除事件（宿主内存随之清空，
 * 卡片自己消失）。用户也可以点卡片上的 × 手动消掉（POST .../restart-notice/dismiss）。
 * 同会话重复调用 = 覆盖（最新理由为准），不堆叠。
 *
 * 为什么手写 tool definition 而不用 @deepseek-ai/dsh-tools 的 defineTool：
 *   该包不在本包 node_modules（引它要新增 peer 依赖 + 用户侧 pnpm install，沙箱装不了）。
 *   defineTool 本身只做三件事——把属性表编译成 JSON Schema、编译 output schema、在 execute
 *   前校验入参。前两件的产物已用真实 defineTool 逐字对齐（见下方 parameters/output.schema），
 *   入参校验改为 execute 内部自己兜（模型传空 reason 会被明确拒绝，不静默）。
 *   ctx.tools.register 仍会自行校验定义形状，不符即抛错——调用方有 try/catch 兜底，
 *   绝不会因为本工具注册失败而让整个宠物插件挂掉。
 */

/** 模型可调用的工具名（本能力的唯一入口） */
export const RESTART_NOTICE_TOOL = 'notify_restart_required';

/** 一条重启提醒（渲染与消除的最小单元） */
export interface RestartNotice {
  /** 发起提醒的会话 id（卡片点击跳转 + dismiss 的定位键） */
  sessionId: string;
  /** agent 填写的理由（一句话：改了什么、为什么必须重启） */
  reason: string;
  /** 记录时刻（毫秒；渲染排序用） */
  ts: number;
}

/** 工具返回的规范值（output.schema 声明的形状，注册表会逐值校验） */
export interface RestartNoticeToolValue {
  /** true = 已记录并会弹卡；false = 开关关闭（没弹卡，绝不伪报成功） */
  ok: boolean;
  /** 记录时刻；未记录（ok=false）时为 0 */
  noticedAt: number;
}

/** 重启提醒内存表 */
export interface RestartNoticeStore {
  /** 记录/覆盖一条提醒（同会话重复调用覆盖旧理由并刷新 ts） */
  record(sessionId: string, reason: string, ts?: number): RestartNotice;
  /** 手动消除（卡片 × 按钮）；返回是否真的删掉了一条 */
  dismiss(sessionId: string): boolean;
  /** 当前全部提醒，按 ts 升序（同 ts 按 sessionId 稳定排序——渲染顺序必须确定） */
  snapshot(): RestartNotice[];
  /** 清空（测试/宿主收尾用） */
  clear(): void;
}

/**
 * 建一个重启提醒内存表。
 * @param now - 时钟注入（测试用；默认 Date.now）
 */
export function createRestartNoticeStore(now: () => number = Date.now): RestartNoticeStore {
  const bySession = new Map<string, RestartNotice>();
  return {
    record(sessionId, reason, ts) {
      const notice: RestartNotice = { sessionId, reason, ts: ts ?? now() };
      bySession.set(sessionId, notice);
      return notice;
    },
    dismiss(sessionId) {
      return bySession.delete(sessionId);
    },
    snapshot() {
      return [...bySession.values()].sort((a, b) => a.ts - b.ts || (a.sessionId < b.sessionId ? -1 : 1));
    },
    clear() {
      bySession.clear();
    },
  };
}

/** ctx.tools.register 需要的最小定义面（@deepseek-ai/dsh-tools 的 ToolDefinition 子集）。
 *  形状按真实 defineTool 的输出逐字对齐：parameters 是**已编译的 JSON Schema**，
 *  output.schema 是对象根的值 schema（properties 里逐属性 required:true 已提升为根的 required 数组）。 */
export interface RestartNoticeToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: RestartNoticeToolValue) => Array<{ type: 'text'; text: string }>;
  };
  execute: (args: unknown, exec: unknown) => Promise<RestartNoticeToolValue>;
}

/** 工具描述（模型视角：什么时候该调、什么时候不该调，写清楚——这是零误报的前提） */
const TOOL_DESCRIPTION = [
  '改动已经做完、但必须由用户重启 DSH 宿主（或刷新标签页）才会生效时调用：',
  '桌宠会在用户屏幕上弹出一张持久提醒卡，避免用户漏看而忘记重启。',
  '',
  '调用后请照常在回复里说明「改动已提交、需要你自己重启」。',
  '',
  '约束：',
  '- 只用于「已经改完、正等用户重启」的时刻；只是在讨论重启、或改动还没做完时不要调用；',
  '- 不要用它代替回复里的说明，它只是多加一道提醒；',
  '- 它不会真的重启任何进程。',
].join('\n');

/**
 * 造一个「重启提醒」工具定义（纯工厂：store 与开关由调用方注入，便于单测）。
 * @param options.store - 提醒内存表
 * @param options.enabled - 开关读取（每次 execute 现读，改配置即时生效）；返回 false 时不记录、不弹卡
 * @returns 可直接交给 ctx.tools.register 的定义对象
 */
export function restartNoticeToolDefinition(options: {
  store: RestartNoticeStore;
  enabled: () => boolean;
}): RestartNoticeToolDefinition {
  const { store, enabled } = options;
  return {
    name: RESTART_NOTICE_TOOL,
    description: TOOL_DESCRIPTION,
    // = defineTool({ parameters: { reason: { type:'string', required:true, description } } }) 的编译产物
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '一句话说明改了什么、为什么必须重启（会原样显示在提醒卡上，别写空话）',
        },
      },
      required: ['reason'],
    },
    output: {
      // = defineTool({ output: { schema: { type:'object', additionalProperties:false, properties:{...} } } }) 的编译产物
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          noticedAt: { type: 'number' },
        },
        required: ['ok', 'noticedAt'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.ok
            ? '已在桌宠上弹出重启提醒卡。请照常在回复里说明改动已提交、需要用户自行重启。'
            : '桌宠的重启提醒开关已关闭，没有弹卡。请直接在回复里告知用户需要自行重启。',
        },
      ],
    },
    async execute(args, exec) {
      const reason =
        typeof (args as { reason?: unknown } | null)?.reason === 'string'
          ? (args as { reason: string }).reason.trim()
          : '';
      // 入参校验自己兜（手写定义绕过了 defineTool 的校验）：空理由会让卡片变成没有信息量的噪音
      if (!reason) throw new Error(RESTART_NOTICE_TOOL + '：reason 不能为空，请用一句话说明改了什么、为什么必须重启');
      const sessionId = String((exec as { agent?: { id?: unknown } } | null)?.agent?.id ?? '');
      // 无归属会话的调用无法定位卡片、也无法跳转：显式失败，不静默吞掉
      if (!sessionId) throw new Error(RESTART_NOTICE_TOOL + ' 需要在一个有归属的 agent 会话里调用');
      if (!enabled()) return { ok: false, noticedAt: 0 };
      return { ok: true, noticedAt: store.record(sessionId, reason).ts };
    },
  };
}
