/**
 * 提醒卡（审批 / 选择题 / 计划评审 / 重启提醒）：共享的**视觉与行模型**。
 *
 * 分工（与 shared 的其余模块一致：数据/纯逻辑在 shared，DOM 挂载各端自己做）：
 *   - 本文件：卡片样式 ALERT_CSS、行模型 alertRowsFromPayload（纯函数，可单测）、理由截断；
 *   - 浏览器：client/approvals.ts 把它渲染成 body 级 fixed 浮层（逐帧跟随宠物、标签页角标、
 *     重启折叠——那套是像素级调校过的，刻意不动它）；
 *   - 桌面：runtime/electron-helper/alerts.js 把它渲染成宠物头顶的窗口内卡片（见该文件）。
 *
 * 行文案由 host 侧 /alerts 直接给出（措辞与浏览器 approvals.ts 对齐），本文件只负责
 * **顺序**（重启行在前、待交互行在后——卡片底边锚在宠物头顶，最后一行才贴着宠物，
 * 与浏览器浮层同序）与容错（缺字段/形状非法一律丢弃，绝不让一条坏数据毁掉整张卡）。
 */

/** 理由在卡片上的显示上限：超出截断（卡片是提醒，不是日志；完整理由在会话里） */
export const REASON_MAX = 60;

/** 理由截断（纯函数，便于测试）：压平空白 + 超长截断加省略号 */
export function truncateReason(reason: string): string {
  const one = reason.replace(/\s+/g, ' ').trim();
  return one.length > REASON_MAX ? one.slice(0, REASON_MAX) + '…' : one;
}

/** 提醒类型：restart = 需要重启宿主；其余三类是待用户回应 */
export type AlertKind = 'restart' | 'approval' | 'question' | 'plan-review';

/** 卡片上的一行 */
export interface AlertRow {
  /** 渲染 key（同会话可挂多条：审批按 id、选择按 callId，host 侧已保证唯一） */
  key: string;
  sessionId: string;
  /** 会话标签（标题或会话 id 前 8 位） */
  label: string;
  /** 行文案 */
  text: string;
  kind: AlertKind;
  /** 只有重启提醒能手动消掉（审批/选择题要在会话里真的处理掉，卡片只是提醒） */
  dismissable: boolean;
}

/** host /alerts 响应体（宽松取值：形状随版本变，坏数据丢弃而不是抛错） */
interface AlertPayloadLike {
  restart?: unknown;
  pending?: unknown;
}

/**
 * 桌面提醒卡「点一行跳会话」的深链参数名。
 *
 * 桌面端没有切会话的客户端 API（`ctx.sessions.open` 只存在于网页），所以点击行 = 用系统浏览器
 * 打开 `http://<host>/?dsh-pet-session=<id>`，由网页里的宠物 client 半侧读到该参数后调
 * sessions.open、再把参数抹掉（见 client/app.ts）。DSH 网页本身是纯状态 SPA、没有任何会话路由，
 * 这个参数是 dsh-pet 自己加的约定——两端都用本常量，避免拼错。
 */
export const SESSION_DEEPLINK_PARAM = 'dsh-pet-session';

/** 从 location.search 里取深链会话 id；没有/为空返回空串（调用方据此决定跳不跳） */
export function sessionDeepLink(search: string): string {
  try {
    return new URLSearchParams(search).get(SESSION_DEEPLINK_PARAM)?.trim() ?? '';
  } catch {
    return ''; // 环境不支持 URLSearchParams：当作没有深链，不影响页面其余功能
  }
}

/** 从 host /alerts 响应体派生卡片行（顺序：重启行在前、待交互行在后） */
export function alertRowsFromPayload(payload: unknown): AlertRow[] {
  const body = (payload ?? {}) as AlertPayloadLike;
  const rows: AlertRow[] = [];
  const restart = Array.isArray(body.restart) ? body.restart : [];
  for (const raw of restart) {
    const item = (raw ?? {}) as { sessionId?: unknown; reason?: unknown };
    const sessionId = typeof item.sessionId === 'string' ? item.sessionId : '';
    if (!sessionId) continue;
    const reason = typeof item.reason === 'string' ? truncateReason(item.reason) : '';
    rows.push({
      key: 'restart:' + sessionId,
      sessionId,
      label: sessionId.slice(0, 8),
      text: '需要重启 DSH' + (reason ? ' · ' + reason : ''),
      kind: 'restart',
      dismissable: true,
    });
  }
  const pending = Array.isArray(body.pending) ? body.pending : [];
  for (const raw of pending) {
    const item = (raw ?? {}) as { kind?: unknown; sessionId?: unknown; label?: unknown; text?: unknown };
    const sessionId = typeof item.sessionId === 'string' ? item.sessionId : '';
    const text = typeof item.text === 'string' ? item.text : '';
    if (!sessionId || !text) continue;
    const kind = item.kind === 'approval' || item.kind === 'plan-review' ? item.kind : 'question';
    rows.push({
      key: kind + ':' + sessionId + ':' + text,
      sessionId,
      label: typeof item.label === 'string' && item.label ? item.label : sessionId.slice(0, 8),
      text,
      kind,
      dismissable: false,
    });
  }
  return rows;
}

/** 提醒卡样式（白泡 + 软糖体，系数随 --dsh-pet-size 缩放）。
 *
 *  **单一来源**：浏览器浮层（client/approvals.ts）与桌面卡片（runtime/electron-helper/alerts.js）
 *  共用这一份——两端只是挂载方式不同（浏览器是 body 级 fixed 浮层 + 逐帧像素定位，
 *  桌面是宠物 stage 内的绝对定位），行视觉与字号缩放必须一模一样，否则两边会慢慢漂移。
 *  用 `--dsh-pet-size` 这一个变量：浏览器从主宠物 root 读到浮层上，桌面把宠物 size 写到卡片上。 */
export const ALERT_CSS = [
  '.dsh-pet-alerts{position:fixed;z-index:10001;display:flex;flex-direction:column;gap:calc(var(--dsh-pet-size)*0.014);' +
    'min-width:calc(var(--dsh-pet-size)*0.26);max-width:calc(var(--dsh-pet-size)*0.7);pointer-events:none;' +
    'font-family:"ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","Comic Sans MS","PingFang SC","Microsoft YaHei",sans-serif}',
  '.dsh-pet-alerts[hidden]{display:none}',
  // 有提醒时藏掉宠物自身的全部气泡（余额/碎碎念/work-status），提醒卡独占头顶
  '.dsh-pet-root[data-dsh-pet-alerts] .dsh-pet-bubble{display:none!important}',
  // 底部小尾巴指向下方宠物（与 bubble.ts 同款三角）
  '.dsh-pet-alerts::after{content:"";position:absolute;left:50%;bottom:calc(var(--dsh-pet-size)*-0.017);' +
    'transform:translateX(-50%);border:calc(var(--dsh-pet-size)*0.017) solid transparent;' +
    'border-top-color:rgba(255,255,255,.92);border-bottom:none}',
  // 行卡片：白泡 + 悬浮反馈；整行点击跳会话（pointer-events 从容器 none 里单独放行）
  '.dsh-pet-alert-row{pointer-events:auto;cursor:pointer;background:rgba(255,255,255,.92);color:#2b2b2b;' +
    'border-radius:calc(var(--dsh-pet-size)*0.035);padding:calc(var(--dsh-pet-size)*0.018) calc(var(--dsh-pet-size)*0.028);' +
    'box-shadow:0 calc(var(--dsh-pet-size)*0.009) calc(var(--dsh-pet-size)*0.035) rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08);' +
    'backdrop-filter:blur(6px);max-width:calc(var(--dsh-pet-size)*0.7);overflow:hidden;transition:background .15s ease}',
  '.dsh-pet-alert-row:hover{background:rgba(255,255,255,.99)}',
  // 会话标题/审批内容允许换行（碎碎念变体同款）：截断看不清，宁可多占一行也要读全
  '.dsh-pet-alert-row .dsh-pet-alert-label{font-size:calc(var(--dsh-pet-size)*0.036);color:rgba(43,43,43,.62);' +
    'white-space:normal;overflow-wrap:anywhere;margin-bottom:calc(var(--dsh-pet-size)*0.006)}',
  '.dsh-pet-alert-row .dsh-pet-alert-text{font-size:calc(var(--dsh-pet-size)*0.0455);line-height:1.5;' +
    'white-space:normal;overflow-wrap:anywhere}',
  '.dsh-pet-alert-row .dsh-pet-alert-dot{color:#e53935;margin-right:calc(var(--dsh-pet-size)*0.012)}',
  // 重启提醒变体：点色改蓝（审批红=有人在等你放行、更急；重启蓝=别忘，不阻塞任何事），
  // 右侧留出 × 的位置，行内需要 relative 让 × 绝对定位
  '.dsh-pet-alert-row[data-kind="restart"]{position:relative;padding-right:calc(var(--dsh-pet-size)*0.055)}',
  '.dsh-pet-alert-row[data-kind="restart"] .dsh-pet-alert-dot{color:#1e88e5}',
  // × 手动消除：只对重启提醒出现（审批有自己的处理面板，点卡片跳过去就行）
  '.dsh-pet-alert-row .dsh-pet-alert-close{position:absolute;top:calc(var(--dsh-pet-size)*0.004);' +
    'right:calc(var(--dsh-pet-size)*0.012);width:calc(var(--dsh-pet-size)*0.042);height:calc(var(--dsh-pet-size)*0.042);' +
    'line-height:calc(var(--dsh-pet-size)*0.042);text-align:center;border-radius:50%;' +
    'font-size:calc(var(--dsh-pet-size)*0.038);color:rgba(43,43,43,.38);cursor:pointer}',
  '.dsh-pet-alert-row .dsh-pet-alert-close:hover{background:rgba(0,0,0,.07);color:rgba(43,43,43,.75)}',
  // 重启折叠：紧凑标题行收紧上下 padding（一卡一行高），小字标题去掉下外边距
  // （下面没有正文行了，保持垂直居中）。汇总行**不加粗**——软糖体没有真正的粗体
  // 字形，font-weight 只会触发浏览器合成假粗体，糊成一团很出戏
  '.dsh-pet-alert-row[data-fold="compact"]{padding-top:calc(var(--dsh-pet-size)*0.009);' +
    'padding-bottom:calc(var(--dsh-pet-size)*0.009)}',
  '.dsh-pet-alert-row[data-fold="compact"] .dsh-pet-alert-label{margin-bottom:0}',
  // 汇总行右侧的展开/收起指示（▾/▴）：与 × 同位（汇总行没有 ×，不冲突）
  '.dsh-pet-alert-row .dsh-pet-alert-foldmark{position:absolute;top:calc(var(--dsh-pet-size)*0.004);' +
    'right:calc(var(--dsh-pet-size)*0.012);width:calc(var(--dsh-pet-size)*0.042);height:calc(var(--dsh-pet-size)*0.042);' +
    'line-height:calc(var(--dsh-pet-size)*0.042);text-align:center;font-size:calc(var(--dsh-pet-size)*0.03);' +
    'color:rgba(43,43,43,.38);pointer-events:none}',
].join('\n');
