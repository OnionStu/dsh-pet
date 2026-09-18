# 图片查看链路 Playbook（agent 侧看图 / 超时兜底 / 像素分析）

> 来源：2026-09-17~18 「跨会话审批提醒」视觉验收实战复盘（HANDOFF.md 的姊妹篇）。
> 场景：纯文本模型（无原生视觉输入）+ 用户 GUI 贴图，驱动多轮 UI 像素级微调。

## 1. 图片从哪来、到哪读

- 用户在 DeepSeek Harness Web GUI 输入框贴图 → 自动上传为附件对象：
  - **物理路径**：`~/.dsh/attachments/v1/objects/<sha256 前 2 位>/<完整 sha256>`（无扩展名，格式靠内容嗅探，PIL 可直接 open）。
  - **消息内引用**：`![图片](/describe-image/raw/sha256:<hash>?ref=<url-encoded json>)`——把这段完整 Markdown 原样传给 `describe_image` 的 `image` 参数即可（宿主重启/嵌套调用后仍有效）；裸 id 只在当前进程有效。
- 文本模型看不到图片本体，两条桥：
  - `describe_image`：通用视觉问答（位置关系/布局判断首选，可指定语言与聚焦）。
  - `modlens_read_image`：结构化 OCR（全文转录/表格/不确定项清单），传物理路径或 URL。
- 两个桥都可用时按需求选：语义/空间 → describe_image；逐字转录 → modlens。

## 2. 工具优先级与降级链

```
read_image（模型支持图像时）→ describe_image / modlens（文本模型）
        ↓ 双双超时（连续 2-3 次，上游引擎抖动，重试同图大概率仍超时）
本地像素分析（venv + Pillow）做定量测量
        ↓ 视觉桥恢复（几分钟后的下一轮通常就好了）
视觉结论为准，像素分析做定量交叉验证
```

- **桥超时**：`Error: ... aborted due to timeout`。不要原地连刷 >3 次；转兜底，稍后下一轮再试视觉（实战中下一张图就恢复了）。
- **结论冲突时信视觉**：像素分析会被同色污染骗（见 §4 案例 B）；视觉也可能数错像素（「约几十至上百像素」）——定量以像素测量为准，定性以视觉为准。

## 3. 像素分析兜底环境（一次搭建全会话复用）

```bash
# 依赖：本机无 PIL/magick/sharp 时
python3 -m venv /tmp/.petimg-venv
/tmp/.petimg-venv/bin/pip install -q pillow
# 沙箱 workspace-write 下 /tmp venv + 网络安装会被拒 →
# 同一命令带 sandbox_permissions=danger-full-access + justification 重试一次（弹用户审批）
```

分析套路（UI 对齐问题足够用）：

```python
from PIL import Image
im = Image.open('<objects 下的物理路径>').convert('RGB')
W, H = im.size; px = im.load()
def white(p): r,g,b=p; return r>225 and g>225 and b>225
def blue(p):  r,g,b=p; return b>90 and b-r>35 and b-g>20 and g<180  # 蓝毛女仆发色
# 逐行统计（x 步长 2），run>60 采样判「卡片大块」，滤掉衣物/文字小片白
# 尾巴 = 卡片主体行以下、中轴附近宽 <20px 的白细条（dy 1..10）
# 关键输出：card_bottom 与 hair_top 的差值（负=压住 / ~0=贴合 / 正=悬空）
```

## 4. 实战案例（同批图，两种方法的对错教训）

- **案例 A（像素成功）**：用户报「位置跟上次一样」但视觉桥全超时 → Pillow 量出卡底与发顶重叠 -17px（截图坐标）+ 尾巴细条可见 → 直接判定「新代码已生效、只差微距」，省掉一轮往返。
- **案例 B（像素误判，视觉纠案）**：680×1024 竖图，像素分析把 **x0-358 的左半大白块**当成卡片、得出「卡贴左缘」；describe_image 恢复后证实卡实际贴的是**右缘**并被裁切，左白块是另一 UI。教训：画面里存在多个同色大块时，先 `describe` 建立结构认知，再 `像素` 做定量，顺序反了会整案皆错。
- **案例 C（沟通）**：截图裁掉关键区（宠物头顶/浏览器标签栏）→ 明确告诉用户缺哪块、为什么（modlens 的 Uncertain 项也提示「裁切导致结论只在视野内成立」）；无法入镜的事实（如标题角标）改用选项直接问，别逼用户重拍。

## 5. 常见坑速查

| 坑 | 症状 | 处理 |
| --- | --- | --- |
| 附件无扩展名 | 部分工具拒绝按路径识别 | PIL open 靠内容嗅探，直接传即可 |
| 视觉桥超时 | 连续 `aborted due to timeout` | ≤3 次后转像素分析，下轮再回视觉 |
| 同色污染 | 白色 run 统计跨全图异常 | 提高行阈值/找最长连续 run/缩小 y 窗口；最终以视觉纠案 |
| 沙箱拒写 /tmp、pip 装包 | `[sandbox: file access denied]` | 同命令带 `sandbox_permissions=danger-full-access`+justification 原样重试一次 |
| 截图裁剪 | 结论覆盖不到关键区 | 要求重截或选项直接问；标注 Uncertain 传播给结论的项 |
| 用户说「跟上次一样」 | 无法区分「没刷新」vs「生效仍不对」 | 给一行 console 读数（`getBoundingClientRect` 三值）一击定性 |

## 6. 本会话图片台账（审计用）

| 附件 sha256 前缀 | 尺寸 | 内容 | 用了哪条链 |
| --- | --- | --- | --- |
| `ea4a7fcf` | 694×166 | toast 条（命令回执） | modlens ✅ |
| `023ec819` | 602×628 | work 气泡正常态 | modlens ✅ |
| `06096b89` | 706×722 | 审批卡压头顶（偏下证据） | modlens ✅ |
| `713189fd` | 766×788 | 「跟上次一样」 | 视觉×3 超时 → **像素** ✅ |
| `6a274eef` | 680×1024 | 卡贴右缘被裁 | 像素（误判左缘）→ describe_image ✅ 纠案 |
| `24f6f98d` | 804×956 | 0.025 版悬空缝 | describe_image ✅ |
| `b859b753`+`e5ead375` | 736×914 / 566×608 | 审批卡 vs 碎碎念对比 | describe_image ✅ ×2 |
