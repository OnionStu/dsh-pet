/**
 * 待交互提醒（host 半侧，自包含，不 import src/shared —— DSH 单文件加载约束）。
 *
 * 背景：审批卡/选择卡的浮层引擎（client/approvals.ts）是**浏览器专属**——它的数据源
 * `ctx.uiSession.pendingInteractions` 只存在于网页那份 client ctx 里。桌面宠物是另一个进程
 * 的透明窗，拿不到它，于是「别的会话挂着审批」在桌面上完全没有提示（只有 work-status 的
 * waiting 档位动画）。本模块把同一份语义搬到 host：**直接从 DSH 会话事件推导待交互行**，
 * 让桌面半侧也能轮询到。
 *
 * 事件配对（形状取自 DSH 的 SessionEventMap，都是精确配对、无启发式）：
 *   - 审批：`approval/asked {id, toolName}` 入表 ⟷ `approval/decided {id}` 出表；
 *   - 选择/计划评审：`tool/call {callId, name}` 入表 ⟷ `tool/result` 出表。callId 的取法随会话
 *     代际变化：0.2（会话格式 v4）把它放在 `message.toolCallId`（工具结果是独立消息，
 *     `content[0]` 只是文本块），更早的代际放在 `message.content[0].toolCallId`；两者都认
 *     （见 toolResultCallId）。
 *   - 僵尸兜底：`turn/end` 的终局态（aborted/interrupted/error/max-tokens）清掉该会话的行
 *     ——终局回合不可能还挂着待交互，挂着说明配对事件没来全（宁可少留一拍，也不要永久假卡）。
 *     `completed` **不清**：配对事件可能只是晚到，宁可多留一拍也不要丢提醒。
 *
 * 与浏览器半侧的差异（刻意）：
 *   - 会话标题来自 `session/title` 事件，**只覆盖宿主本次启动之后发过标题的会话**；
 *     拿不到就退化成会话 id 前 8 位（与浏览器 `displayTitle` 的 fallback 同款）。
 *   - 计划评审（exit_plan_mode）用固定文案「等你评审计划」：那句评审问句是 plan-mode 服务
 *     内部生成的，不在 tool/call 的 arguments 里（arguments 只有 plan 正文，太长）。
 *   - 不过滤"当前会话"（浏览器会过滤掉你正在看的那个会话）：host 不知道网页在看哪个会话，
 *     而桌面宠物本来就浮在所有窗口之上，全显示更符合它的用途。
 */
'use strict';

/** 待交互类型（渲染与排序的最小单元；plan-review 单列一档，桌面端用固定文案） */
export type PendingAlertKind = 'approval' | 'question' | 'plan-review';

/** 内存表里的条目 */
export interface PendingAlertEntry {
  kind: PendingAlertKind;
  sessionId: string;
  /** 配对键：审批 = ApprovalRequestId；选择/计划评审 = ToolCallId */
  key: string;
  /** 行文案的补充片段：审批 = 工具名（approval/asked.toolName）；选择题 = 首个问题文本；其余为空串 */
  detail: string;
  /** 入表时刻（ms；排序用） */
  ts: number;
}

/** 对外快照条目（路由响应体里的元素） */
export interface PendingAlertItem {
  kind: PendingAlertKind;
  sessionId: string;
  /** 会话标签：标题（session/title 事件）或会话 id 前 8 位 */
  label: string;
  /** 行文案：「等你审批 · Bash」/「等你选择 · 要不要删库？」/「等你评审计划」 */
  text: string;
  ts: number;
}

export interface PendingAlertSnapshot {
  /** 最近一次变化时刻（轮询端按它判断是否需要重渲染） */
  ts: number;
  items: PendingAlertItem[];
}

/** 会触发「待用户回应」的工具名 → 行类型（其余工具是普通干活，不该弹提醒） */
export const PENDING_TOOL_KINDS: Record<string, PendingAlertKind> = {
  ask_user_question: 'question',
  exit_plan_mode: 'plan-review',
};

/** 终局回合：清掉该会话的待交互行（见文件头「僵尸兜底」） */
const TERMINAL_TURN_REASONS = new Set(['aborted', 'interrupted', 'error', 'max-tokens']);

/** 表键：同一会话可同时挂多条（多个审批 / 审批 + 选择题） */
const keyOf = (sessionId: string, key: string): string => sessionId + '\u0000' + key;

/** 宽松取值：事件来自宿主，形状随版本可能变；拿不到就当没有，绝不抛 */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 从 tool/call 的 arguments 里取首个问题文本（ask_user_question 的 questions[0].question） */
export function firstQuestion(argumentsRaw: unknown): string {
  if (typeof argumentsRaw !== 'string' || !argumentsRaw) return '';
  try {
    const parsed = JSON.parse(argumentsRaw) as { questions?: unknown } | null;
    const list = parsed?.questions;
    if (!Array.isArray(list) || list.length === 0) return '';
    const first = list[0] as { question?: unknown } | null;
    return str(first?.question);
  } catch {
    return ''; // 非法 JSON：退化为无问题文本（文案仍成立）
  }
}

/** 行文案：与浏览器 approvals.ts / restart-notice.ts 的措辞对齐（计划评审见文件头说明） */
export function pendingAlertText(entry: Pick<PendingAlertEntry, 'kind' | 'detail'>): string {
  if (entry.kind === 'approval') return '等你审批' + (entry.detail ? ' · ' + entry.detail : '');
  if (entry.kind === 'plan-review') return '等你评审计划';
  return '等你选择' + (entry.detail ? ' · ' + entry.detail : '');
}

/**
 * 待交互提醒表（host 常驻内存；宿主重启即清空——与 restart-notice 同语义：
 * 「用户处理掉了」就是天然的消除事件，不需要过期策略）。
 *
 * 用**工厂 + 闭包**而不是 class：与 ./restart-notice 的 createRestartNoticeStore 同款，
 * 也让产物里不出现 `_defineProperty` 助手（那会 import 构建期的 @oxc-project/runtime，
 * 而它不在本包依赖里 → 宿主加载 lib/index.js 时 ERR_MODULE_NOT_FOUND）。
 */
export function createPendingAlerts(): {
  observe(sessionId: string, event: unknown): void;
  snapshot(): PendingAlertSnapshot;
} {
  const table = new Map<string, PendingAlertEntry>();
  const titles = new Map<string, string>();
  let changedAt = 0;
  let clock = 0;

  /** 单调递增的"入表时刻"：同毫秒内多条也能稳定排序（不依赖 Date.now 的分辨率） */
  const nextTs = (): number => {
    const now = Date.now();
    clock = now > clock ? now : clock + 1;
    return clock;
  };

  /** 入表/覆盖（同 key 重复入表不产生第二行；覆盖时保留原 ts，避免无谓的重排序） */
  const put = (entry: PendingAlertEntry): void => {
    const k = keyOf(entry.sessionId, entry.key);
    const prev = table.get(k);
    table.set(k, prev ? { ...entry, ts: prev.ts } : entry);
    changedAt = nextTs();
  };

  const drop = (sessionId: string, key: string): void => {
    if (table.delete(keyOf(sessionId, key))) changedAt = nextTs();
  };

  const clearSession = (sessionId: string): void => {
    let hit = false;
    for (const [k, entry] of table) {
      if (entry.sessionId !== sessionId) continue;
      table.delete(k);
      hit = true;
    }
    if (hit) changedAt = nextTs();
  };

  return {
    /** 消费一条 session/event（含 session/title）。不关心的类型直接返回。 */
    observe(sessionId: string, event: unknown): void {
      const sid = str(sessionId);
      const ev = event as { type?: unknown; data?: unknown } | null;
      const type = str(ev?.type);
      if (!sid || !type) return;
      const data = (ev?.data ?? {}) as Record<string, unknown>;
      if (type === 'session/title') {
        const title = str(data.title).trim();
        if (!title || titles.get(sid) === title) return;
        titles.set(sid, title);
        changedAt = nextTs(); // 标题变化要重渲染（label 变了）
        return;
      }
      if (type === 'approval/asked') {
        const id = str(data.id);
        if (!id) return;
        put({ kind: 'approval', sessionId: sid, key: id, detail: str(data.toolName), ts: nextTs() });
        return;
      }
      if (type === 'approval/decided') {
        const id = str(data.id);
        if (id) drop(sid, id);
        return;
      }
      if (type === 'tool/call') {
        const callId = str(data.callId);
        const kind = PENDING_TOOL_KINDS[str(data.name)];
        if (!callId || !kind) return;
        put({
          kind,
          sessionId: sid,
          key: callId,
          // 选择题的补充片段是首个问题文本（审批的补充片段是工具名，见 approval/asked 分支）
          detail: kind === 'question' ? firstQuestion(data.arguments) : '',
          ts: nextTs(),
        });
        return;
      }
      if (type === 'tool/result') {
        const callId = toolResultCallId(data);
        if (callId) drop(sid, callId);
        return;
      }
      if (type === 'turn/end') {
        const reason = str((data.reason as { kind?: unknown } | undefined)?.kind);
        if (TERMINAL_TURN_REASONS.has(reason)) clearSession(sid);
      }
    },

    /** 快照（按入表时刻升序：最早挂上的在最上面） */
    snapshot(): PendingAlertSnapshot {
      const items = [...table.values()]
        .sort((a, b) => a.ts - b.ts)
        .map((entry): PendingAlertItem => {
          const label = titles.get(entry.sessionId) ?? entry.sessionId.slice(0, 8);
          return { kind: entry.kind, sessionId: entry.sessionId, label, text: pendingAlertText(entry), ts: entry.ts };
        });
      return { ts: changedAt, items };
    },
  };
}

/** tool/result 里的 callId（宽松取值：当前代际在 message.toolCallId，旧代际在 content[0].toolCallId） */
export function toolResultCallId(data: Record<string, unknown>): string {
  const message = data.message as
    | { toolCallId?: unknown; source?: { callId?: unknown }; content?: unknown }
    | undefined;
  const top = str(message?.toolCallId);
  if (top) return top;
  const fromSource = str(message?.source?.callId);
  if (fromSource) return fromSource;
  const content = message?.content;
  if (!Array.isArray(content) || content.length === 0) return '';
  const first = content[0] as { toolCallId?: unknown } | null;
  return str(first?.toolCallId);
}
