#!/usr/bin/env bash
# 用 git filter-repo 改写历史，把敏感值替换成占位符（blob 内容 + 提交信息）。
#
# 用法：
#   ./rewrite-history.sh <仓库路径> [规则文件]
#
# 规则文件缺省查找顺序：rules.local.txt → rules.example.txt（同目录）。
#
# ⚠️ 改写不可逆，先备份、先在 --mirror 副本上演练：
#     cp -R ~/Work/dsh-pet ~/Work/dsh-pet.bak
#     git clone --no-local --mirror . /tmp/try.git && ./rewrite-history.sh /tmp/try.git
#
# ⚠️ 依赖 git-filter-repo（单文件，无需安装）：
#     curl -sSL -o git_filter_repo.py \
#       https://raw.githubusercontent.com/newren/git-filter-repo/main/git_filter_repo.py
#     放到本目录，或用 GFR 环境变量指向已有副本。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:?用法: ./rewrite-history.sh <仓库路径> [规则文件]}"

# ── 规则文件 ──────────────────────────────────────────────
RULES="${2:-}"
if [ -z "$RULES" ]; then
  if [ -f "$HERE/rules.local.txt" ]; then
    RULES="$HERE/rules.local.txt"
  elif [ -f "$HERE/rules.example.txt" ]; then
    RULES="$HERE/rules.example.txt"
    echo "⚠️  未找到 rules.local.txt，回退到 rules.example.txt（只含路径类规则，金额不会被清洗）"
  else
    echo "❌ 找不到规则文件" >&2; exit 1
  fi
fi

# ── filter-repo ──────────────────────────────────────────
GFR="${GFR:-$HERE/git_filter_repo.py}"
if [ ! -f "$GFR" ]; then
  echo "❌ 找不到 git-filter-repo：$GFR" >&2
  echo "   下载：curl -sSL -o '$GFR' https://raw.githubusercontent.com/newren/git-filter-repo/main/git_filter_repo.py" >&2
  exit 1
fi

git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1 || { echo "❌ $TARGET 不是 git 仓库" >&2; exit 1; }

# ── 规则自检：两个实测踩过的坑，先拦下来 ─────────────────
echo "### 规则自检 ###"
bad=0
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in
    *'==>'*) ;;
    *) echo "  ❌ 缺 ==> 分隔符: $line"; bad=1; continue ;;
  esac
  lhs="${line%%==>*}"
  # 坑 1：==> 左侧尾随空格 → 匹配串带空格 → 命中 0 条且静默
  if [ "$lhs" != "${lhs% }" ]; then
    echo "  ❌ '==>' 左侧有尾随空格（会导致静默失配）: $line"; bad=1
  fi
  rhs="${line#*==>}"
  if [ "$rhs" != "${rhs# }" ]; then
    echo "  ❌ '==>' 右侧有前导空格（会写进结果）: $line"; bad=1
  fi
done < "$RULES"

# 坑 2：长规则必须排在短规则之前（filter-repo 不排序，按文件顺序执行）
python3 - "$RULES" <<'PY' || bad=1
import sys, re
pats = []
for line in open(sys.argv[1], encoding='utf-8'):
    line = line.rstrip('\n')
    if not line or line.startswith('#') or '==>' not in line:
        continue
    lhs = line.split('==>', 1)[0]
    if lhs.startswith('regex:'):
        lhs = lhs[6:]
        # 只取字面前缀做包含比较；含正则元字符则跳过（无法简单判断）
        m = re.match(r'[A-Za-z0-9/._~-]+', lhs)
        lhs = m.group(0) if m else ''
    pats.append(lhs)
bad = False
for i, a in enumerate(pats):
    for b in pats[i+1:]:
        if a and b and b in a and b != a:
            print(f"  ❌ 短规则排在长规则之前（会截断长路径）: {b!r} 在 {a!r} 之后才出现")
            bad = True
sys.exit(1 if bad else 0)
PY
[ "$bad" -eq 0 ] || { echo "❌ 规则自检未通过，已中止" >&2; exit 1; }
echo "  ✅ 通过（分隔符格式、长规则优先）"

# ── 记录改写前状态 ────────────────────────────────────────
BEFORE_HEAD=$(git -C "$TARGET" rev-parse HEAD)
BEFORE_SUBJ=$(git -C "$TARGET" log main --format='%s' 2>/dev/null | sort | shasum | cut -d' ' -f1)
BEFORE_COUNT=$(git -C "$TARGET" rev-list --count main 2>/dev/null || echo 0)
echo "### 改写前 ###"
echo "  main: ${BEFORE_COUNT} 个提交, HEAD=$(git -C "$TARGET" log -1 --oneline main 2>/dev/null || echo '?')"

# ── 执行 ─────────────────────────────────────────────────
# filter-repo 没有 --repo 参数：它在「当前工作目录」里操作（--source/--target
# 仅用于从别处读/写）。所以必须 cd 进目标仓库再执行。
# 另外：filter-repo 会在目标仓库的 .git/filter-repo/ 留下运行元数据（含
# already_ran）。超过一天后再次运行会交互询问「续跑还是重来」（Y=续跑复用
# 旧 commit-map，N=删除重来）。历史重写的场景必须「重来」——旧元数据会按
# 旧规则的重写结果继续，规则每次都在变，续跑结果不可预期。所以直接清掉
# 整个 filter-repo 元数据目录，保证全新跑（删除的是运行元数据，不是仓库数据）。
GFR_DIR="$TARGET/.git/filter-repo"
[ -d "$GFR_DIR" ] && { echo "⚠️  清除旧 filter-repo 运行元数据：$GFR_DIR"; rm -rf "$GFR_DIR"; }

(
  cd "$TARGET" && \
  python3 "$GFR" \
    --replace-text "$RULES" \
    --replace-message "$RULES" \
    --force
)

# ── 校验 ─────────────────────────────────────────────────
# 注意：只比对 main。用 --all 会把 upstream 引用算进来 —— filter-repo 会清掉
# 非本仓主线引用，导致「提交数变化」的假警报（本次实测踩过）。
echo "### 改写后校验 ###"
AFTER_COUNT=$(git -C "$TARGET" rev-list --count main)
AFTER_SUBJ=$(git -C "$TARGET" log main --format='%s' | sort | shasum | cut -d' ' -f1)

ok=1
if [ "$BEFORE_COUNT" != "$AFTER_COUNT" ]; then
  echo "  ❌ main 提交数变化: $BEFORE_COUNT -> $AFTER_COUNT"; ok=0
else
  echo "  ✅ main 提交数不变: $AFTER_COUNT"
fi
if [ "$BEFORE_SUBJ" != "$AFTER_SUBJ" ]; then
  echo "  ❌ main 提交标题集合变化（不应发生）"; ok=0
else
  echo "  ✅ main 全部提交标题逐条一致"
fi

if [ "$ok" -eq 1 ]; then
  echo
  echo "改写完成。HEAD: $BEFORE_HEAD -> $(git -C "$TARGET" rev-parse HEAD)"
  echo
  echo "⚠️ git filter-repo 已摘掉所有 remote（设计行为，防止误推）。加回："
  git -C "$TARGET" remote -v | sed 's/^/     /' || true
  echo "     git -C $TARGET remote add origin <url>"
  echo
  echo "下一步：跑 scan-secrets.sh --history 确认残留为 0，再决定是否强推"
  echo "（泄漏提交若未推送，普通 push 即可；已推送则需协调后用 --force-with-lease）。"
else
  echo
  echo "❌ 校验未通过。用备份恢复：rm -rf $TARGET && mv <备份> $TARGET" >&2
  exit 1
fi
