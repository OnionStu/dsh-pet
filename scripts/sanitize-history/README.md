# 提交历史脱敏（sanitize-history）

把已经进入 git 历史的**本机路径 / 凭据文件位置 / 个人账户数字**替换成占位符。

本目录是 2026-09-20 那次全历史审计的产物。审计起因：一次例行检查发现
`HANDOFF.md` 与余额相关测试夹具里粘了本机实测数据。

## 为什么需要它

敏感值一旦进入提交，`git rm` 或后续提交**都删不掉**——它仍留在历史对象里，
任何 `git clone` 的人都能翻出来。唯一办法是改写历史。

好消息是改写通常**不需要强推**：只要这些提交还没推送到远端，改写后就只是一次
普通快进推送。**先确认再动手**（见下方「判断是否需要强推」）。

## 三类目标，以及为什么金额不能一概正则化

| 类别 | 例子 | 能否通用正则化 |
| --- | --- | --- |
| 本机绝对路径 | `/Users/<用户名>/...`、`<全局 node_modules>` | ✅ 能，见 `rules.example.txt` |
| 凭据文件位置 | `~/.dsh/` 下的 credentials 文件 | ✅ 能（只匹配带 `~/.dsh/` 前缀的形态） |
| 个人账户数字 | 余额、token 数、调用次数、快照时间戳 | ❌ **不能**，必须人工确认 |

金额之所以不能一概替换，是因为同一个字面量在仓库里含义不同：

- `¥8.79`、`¥20` —— **上游 README 的示例值**。改掉就与 upstream 分叉，
  以后合并上游会一直冲突。
- `¥0.00` —— 「假 0 防线」的**正当代码字面量**（`绝不显示 ¥0.00`），
  是契约的一部分，改掉就破坏了语义。
- 本机实测粘进测试夹具/文档的**真实账户余额**（形如 `¥1xxx.xx` 的数值）——
  必须清掉。

正则区分不了这三者。所以：**路径类自动替换，金额类由扫描器报出来、人工往
`rules.local.txt` 里补字面量**。

## 用法

### 1. 先扫描

```bash
# 扫工作区（HEAD 的跟踪文件）
./scripts/sanitize-history/scan-secrets.sh

# 扫全历史（慢，但这是唯一能发现「已进历史的泄漏」的方式）
./scripts/sanitize-history/scan-secrets.sh --history
```

命中会列出 `文件:行` 并让脚本以非 0 退出，可直接挂进 pre-push 门禁。

扫描器**只报告、不修改**——因为要区分上面那三种金额，只有人能做。

### 2. 准备规则

```bash
cd scripts/sanitize-history
cp rules.example.txt rules.local.txt
# 把扫描器报出的金额字面量按 rules.local.txt 里的注释格式补进去
```

`rules.local.txt` 已被 `.gitignore` 忽略——**它本身含真实敏感值，绝不能入库**。

规则文件格式（与 `git filter-repo --replace-text` 一致）：

```
字面量==>替换文本
regex:正则==>替换文本
```

⚠️ **两个坑，都踩过**：

1. **`==>` 两侧不做 strip**。写成 `旧值 ==> 新值` 会让匹配串带上**尾随空格**，
   于是命中 0 条却**毫无报错**（本次第一版规则就是这么静默失效的）。
   必须紧贴：`旧值==>新值`。
2. **规则按文件顺序执行，不做长度排序**。`<仓库根>` 与
   `<home>` 同时存在时，短规则若排在前面会把长路径截断成 `<home>/Work/dsh-pet`。
   **长规则必须排在前面**（`rules.example.txt` 已按此排序）。

### 3. 先演练，再动真格

```bash
# 忠实副本（--mirror 会带上 upstream 引用，比 cp -R 可靠）
git clone --no-local --mirror . /tmp/dsh-pet-try.git

./scripts/sanitize-history/rewrite-history.sh /tmp/dsh-pet-try.git

# 验证：应输出 0
git -C /tmp/dsh-pet-try.git log --all -p \
  | grep -cE '(/Users/|/opt/homebrew/lib|\.credentials\.yaml|¥[0-9]+\.[0-9]{2})'
```

演练确认后再对真仓执行：

```bash
cp -R ~/Work/dsh-pet ~/Work/dsh-pet.bak        # 改写不可逆
./scripts/sanitize-history/rewrite-history.sh ~/Work/dsh-pet
```

**已跑过一次、想重跑？** 直接再跑同一命令即可，无需额外操作：
`rewrite-history.sh` 会自动清掉旧的 filter-repo 元数据（`.git/filter-repo/`，
那是运行记录不是仓库数据）并以全新规则重跑；幂等——若上次已清干净，
重跑后提交 SHA 完全不变。本次审计期间就是这么反复演练的。

### 4. 加回 remote 并推送

`git filter-repo` **会主动摘掉所有 remote**（防止你顺手推错地方），这是设计行为，
不是出错。改写后加回：

```bash
git remote add origin https://github.com/OnionStu/dsh-pet
git push origin main
```

## 判断是否需要强推

```bash
git merge-base --is-ancestor <泄漏提交> origin/main && echo "已推送 → 需要强推并通知协作者" \
                                                      || echo "未推送 → 普通推送即可"
```

若已推送：强推会改写他人本地历史，**必须先协调**，并用 `--force-with-lease`
（而非 `--force`）以免覆盖别人的新提交。

> 本仓现状（2026-09-19 实测）：泄漏提交从未推送，`origin/main` 指向的
> 远端历史是干净的，**改写后普通 `git push origin main` 即可，不需要强推**。
> 注意 filter-repo 会摘掉 `origin`，推送前先 `git remote add origin` 加回。
> 若你之前已跑过一次 filter-repo 但还没加回 origin，重跑脚本后按「第 4 步」
> 加回并推送。

## 明确不动的路径（避免过度清洗）

这些看着像机器指纹，实际是**跨平台源码的一部分**，清洗会破坏代码或与上游分叉：

| 路径 | 为什么不动 |
| --- | --- |
| `/usr/local/bin/electron`、`/usr/local/lib/node_modules/electron/dist` | Electron 的**标准系统安装位置**查找回落（`scripts/ensure-electron.mjs`） |
| `C:\Users\p'c\.dsh\profiles\web\...` | `storage-paths.test.ts` 的**合成夹具**（故意用带引号的怪名字测解析） |
| 源码注释里的裸 `.credentials.yaml` | 上游 `balance.ts` 既有注释，规则只匹配带 `~/.dsh/` 前缀的形态 |
| `¥8.79`、`¥20`、`¥0.00` | 上游示例值 / 正当代码字面量，见上文 |

## 复盘：本次审计的两个教训

1. **泄漏面比第一眼大**。最初只在 `HANDOFF.md`（本地新增文档）里发现本机路径；
   继续查才发现**源码测试夹具**里粘了真实余额与用量数字，**提交信息**里也有。
   审计必须覆盖：blob 内容 + 提交信息 + 图片元数据 + 已删除文件 + stash/notes。
2. **测试夹具不要粘真实响应**。把本机实测响应直接贴进单测，既泄漏个人信息，
   又让测试隐含依赖「某台机器的某个时刻」。正确做法是**合成数据 + 保持内部自洽**
   （如各分段之和等于总量），断言只依赖形状与自洽性。更不要改成「读本地配置」——
   跑 CI 的人没有那份配置，而且把敏感值读进断言等于把它搬回可观察面。
