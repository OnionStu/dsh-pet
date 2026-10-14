/**
 * dsh-pet desktop helper —— 提醒卡（审批 / 选择题 / 计划评审 / 重启提醒）。
 *
 * 为什么桌面端要自己有一份：浏览器的浮层引擎（client/approvals.ts）是**浏览器专属**——
 * 数据源 `ctx.uiSession.pendingInteractions` 只存在于网页那份 client ctx 里。桌面宠物是另一个
 * 进程的透明窗，只能轮询宿主 /dsh-pet-7340/alerts（host 从 DSH 事件表推导，见 src/host/pending-alerts.ts）。
 * 于是分工是：host 出数据 → shared/alerts 出**行模型与视觉（ALERT_CSS）** → 本文件把它挂成
 * 宠物头顶的窗口内卡片。
 *
 * 与浏览器浮层的差异（刻意的，都是为了适配"窗口就是宠物+余量"这个前提）：
 *   - 定位：浏览器是 body 级 fixed 浮层 + 逐帧读宠物 rect 算像素；桌面直接绝对定位在宠物盒内，
 *     底边锚点与碎碎念/余额气泡**同一行公式**（`bottom: calc(100% - size*0.108)`），无需逐帧 JS。
 *   - 高度上限：卡片自然高度超过窗口顶部余量时，sprite 会把窗口整体向上加高（margin.t 动态化），
 *     装不下（宠物已贴屏幕顶）才退回容器内滚动（max-height 封顶，滚动条隐藏，避免透明窗上一条灰条）。
 *   - 重启折叠：重启提醒 ≥2 条时折成「汇总行 + 紧凑标题行」（与浏览器 planAlertRows 同规则），
 *     点汇总行展开看完整理由。
 *   - 点击跳转：桌面没有"切会话"的客户端 API，改为用系统浏览器打开带 `?dsh-pet-session=<id>`
 *     的 GUI 地址，由网页里的宠物 client 半侧读这个参数调 sessions.open（见 client/app.ts）。
 *
 * 视觉不重复定义：行 DOM 的 class 与浏览器浮层完全一致，样式全部来自 shared 的 ALERT_CSS
 * （单一来源；`--dsh-pet-size` 由本文件写到卡片根上）。
 */
'use strict';

/** 注入提醒卡样式（ALERT_CSS 来自 shared-core，两端同一份）；只注入一次 */
function injectAlertCss() {
  if (document.querySelector('style[data-plugin-css="dsh-pet/alerts"]') !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = 'dsh-pet/alerts';
  tag.textContent = S.ALERT_CSS;
  document.head.appendChild(tag);
}

/** 蓝点 + 文本（与浏览器 renderAlerts 的 dotText 同结构，样式靠 ALERT_CSS 的 class 命中） */
function alertDotText(content) {
  const text = document.createElement('div');
  text.className = 'dsh-pet-alert-text';
  const dot = document.createElement('span');
  dot.className = 'dsh-pet-alert-dot';
  dot.textContent = '●';
  text.appendChild(dot);
  text.appendChild(document.createTextNode(content));
  return text;
}

/**
 * 建一张提醒卡（挂在传入的容器里，初始隐藏）。
 * @param {{container: HTMLElement, size: number, onOpenSession: (id: string) => void, onDismiss: (id: string) => void}} opts
 * @returns {{update: (rows: Array<object>) => void, containsPoint: (x: number, y: number) => boolean,
 *            isVisible: () => boolean, hide: () => void, dispose: () => void}}
 */
function createAlertCard(opts) {
  injectAlertCss();
  const root = document.createElement('div');
  root.className = 'dsh-pet-alerts';
  root.hidden = true; // 无提醒行时不显示、不占位、不参与命中判定（与浏览器浮层同语义）
  root.style.setProperty('--dsh-pet-size', opts.size + 'px');
  opts.container.appendChild(root);

  /** 重启折叠阈值：达到它就折成汇总行 + 紧凑标题行（与浏览器 planAlertRows 同规则） */
  const RESTART_FOLD_MIN = 2;
  /** 折叠态开关：默认折叠，点汇总行展开看完整理由 */
  let restartExpanded = false;
  /** 最近一次渲染的行（汇总行点击后重渲染用） */
  let currentRows = [];

  /** 重启折叠汇总行：「● 需要重启 DSH × N」+ 右侧 ▾/▴，整行点击切换展开/收起（无 ×） */
  const buildSummaryRow = (count) => {
    const el = document.createElement('div');
    el.className = 'dsh-pet-alert-row';
    el.dataset.kind = 'restart';
    el.dataset.fold = 'summary';
    el.title = restartExpanded ? '收起重启提醒' : '展开重启提醒（看完整理由）';
    el.appendChild(alertDotText('需要重启 DSH × ' + count));
    const mark = document.createElement('span');
    mark.className = 'dsh-pet-alert-foldmark';
    mark.textContent = restartExpanded ? '▴' : '▾';
    el.appendChild(mark);
    el.addEventListener('click', () => {
      restartExpanded = !restartExpanded;
      update(currentRows);
    });
    return el;
  };

  /** 单条提醒行；compact 只渲染小字标题一行（折叠态），不渲染正文与 × */
  const buildRow = (row, compact) => {
    const el = document.createElement('div');
    el.className = 'dsh-pet-alert-row';
    el.dataset.kind = row.kind; // CSS 据此切点色 / 留 × 位置
    if (compact) el.dataset.fold = 'compact';
    el.title = '在浏览器打开该会话：' + row.label;
    const label = document.createElement('div');
    label.className = 'dsh-pet-alert-label';
    label.textContent = '「' + row.label + '」';
    el.appendChild(label);
    if (!compact) el.appendChild(alertDotText(row.text));
    if (!compact && row.dismissable) {
      const close = document.createElement('span');
      close.className = 'dsh-pet-alert-close';
      close.textContent = '×';
      close.title = '消掉这条重启提醒（不影响那个会话）';
      // 整行是"跳会话"的点击区，× 是"消除"：必须 stopPropagation，不能两个都触发
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        opts.onDismiss(row.sessionId);
      });
      el.appendChild(close);
    }
    el.addEventListener('click', () => opts.onOpenSession(row.sessionId));
    return el;
  };

  const update = (rows) => {
    const list = Array.isArray(rows) ? rows : [];
    currentRows = list;
    root.replaceChildren();
    if (list.length === 0) {
      root.hidden = true;
      naturalH = 0;
      // 卡片清空：窗口还原默认余量（同样要通知，否则窗口停在加高状态）
      if (typeof opts.onNaturalHeight === 'function') opts.onNaturalHeight();
      return;
    }
    // 行序：重启块在前、待交互行在后（与 alertRowsFromPayload 一致）；重启行达阈值才折叠
    const restartRows = list.filter((row) => row && row.kind === 'restart');
    const pendingRows = list.filter((row) => !row || row.kind !== 'restart');
    const foldable = restartRows.length >= RESTART_FOLD_MIN;
    const compact = foldable && !restartExpanded;
    if (foldable) root.appendChild(buildSummaryRow(restartRows.length));
    for (const row of restartRows) root.appendChild(buildRow(row, compact));
    for (const row of pendingRows) root.appendChild(buildRow(row, false));
    root.hidden = false;
    // 自然高度在渲染后现量：scrollHeight 不受 max-height 封顶影响，sprite 拿它决定窗口加高多少
    naturalH = root.scrollHeight;
    // 通知窗口重算余量（折叠/展开也走这条：卡片收起/展开后窗口当场缩/长）
    if (typeof opts.onNaturalHeight === 'function') opts.onNaturalHeight();
  };
  /** 最近一次渲染的自然高度（px，窗口局部 CSS 系；隐藏时为 0） */
  let naturalH = 0;

  return {
    update,
    /** 卡片的自然内容高度（max-height 封顶前的完整高度） */
    naturalHeight() {
      return naturalH;
    },
    /** 封顶高度（px，写入 --dsh-pet-alert-max-h）；<= 0 时移除，回退 CSS 默认上限 */
    setMaxHeight(px) {
      if (px > 0) root.style.setProperty('--dsh-pet-alert-max-h', px + 'px');
      else root.style.removeProperty('--dsh-pet-alert-max-h');
    },
    /** 光标是否落在卡片上（窗口局部坐标，CSS 系）——命中判定用它把整窗可交互范围扩到卡片 */
    containsPoint(x, y) {
      if (root.hidden) return false;
      const r = root.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    },
    isVisible: () => !root.hidden,
    hide() {
      root.hidden = true;
      root.replaceChildren();
    },
    dispose() {
      root.remove();
    },
  };
}
