#!/usr/bin/env bash
# 扫描敏感信息：本机路径 / 凭据位置 / 个人账户数字 / 高熵密钥。
#
# 只报告、不修改 —— 金额类命中必须人工判断（见 README「三类目标」），
# 因为同一个 ¥ 字面量可能是上游示例值或正当代码字面量。
#
# 用法：
#   ./scan-secrets.sh              # 扫 HEAD 的跟踪文件（快）
#   ./scan-secrets.sh --history    # 扫全历史（慢，但唯一能发现已进历史的泄漏）
#
# 退出码：0 = 无命中，1 = 有命中（可直接挂 pre-push 门禁）。
#
# 本脚本会被提交入库，因此只含泛化正则、不含任何真实值。
set -uo pipefail

MODE="worktree"
case "${1:-}" in
  --history) MODE="history" ;;
  -h|--help) sed -n '2,14p' "$0" | sed 's/^# \?//'; exit 0 ;;
  "") ;;
  *) echo "未知参数: ${1}（用 --help）" >&2; exit 2 ;;
esac

cd "$(git rev-parse --show-toplevel)" || exit 2

# 每项：<标签>|<正则>|<备注>
# 备注非空表示「可能误报，需人工判断」。
PATTERNS=(
  '本机路径(Unix)|/Users/[A-Za-z0-9._-]+|'
  '本机路径(Windows)|C:\\\\Users\\\\[A-Za-z0-9._-]+|注意：storage-paths.test.ts 的合成夹具会命中，属误报'
  '机器特定前缀|<全局 node_modules>|'
  '凭据文件|\.credentials\.ya?ml|源码注释里的裸文件名属上游既有内容，不要改'
  '个人金额|¥[0-9]+\.[0-9]{2}|需人工判断：上游示例值(¥8.79/¥20)与正当字面量(¥0.00)不可改'
  '高熵密钥|(ghp_|gho_|sk-|AKIA|xox[baprs]-)[A-Za-z0-9_-]{16,}|'
  'JWT|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|'
  '私钥块|-----BEGIN [A-Z ]*PRIVATE KEY-----|'
  'registry 认证|_auth(Token)?\s*[:=]\s*\S|'
  '内网地址|(10\.[0-9]{1,3}|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}|'
)

# 二进制/生成产物不扫（lib 是构建产物，assets 是素材）
EXCLUDES=( ':(exclude)dsh-pet/lib/**' ':(exclude)**/node_modules/**' ':(exclude)**/package-lock.json' ':(exclude)**/pnpm-lock.yaml' )

total=0

if [ "$MODE" = "history" ]; then
  echo "### 扫描全历史（含已删除文件与提交信息）###"
  for entry in "${PATTERNS[@]}"; do
    label="${entry%%|*}"; rest="${entry#*|}"; re="${rest%|*}"
    if [ "$rest" = "$re" ]; then note=""; else note="${rest#*|}"; fi
    if [ -n "$note" ]; then notesfx="（${note}）"; else notesfx=""; fi
    hits=$(git log --all -p 2>/dev/null | grep -nE "^\+.*(${re})" | grep -vE '^\+\+\+' | head -8)
    if [ -n "$hits" ]; then
      n=$(git log --all -p 2>/dev/null | grep -cE "^\+.*(${re})" || true)
      echo "⚠️  [$label] 命中 ${n} 行${notesfx}"
      printf '%s\n' "$hits" | sed 's/^/      /'
      total=$((total + n))
    fi
  done
  # 提交信息单独扫（--replace-message 的处理对象）
  for entry in "${PATTERNS[@]}"; do
    label="${entry%%|*}"; rest="${entry#*|}"; re="${rest%|*}"
    hits=$(git log --all --format='%H %s%n%b' 2>/dev/null | grep -E "(${re})" | head -5)
    if [ -n "$hits" ]; then
      echo "⚠️  [提交信息·$label] 命中:"
      printf '%s\n' "$hits" | sed 's/^/      /'
      total=$((total + 1))
    fi
  done
else
  echo "### 扫描 HEAD 跟踪文件 ###"
  for entry in "${PATTERNS[@]}"; do
    label="${entry%%|*}"; rest="${entry#*|}"; re="${rest%|*}"
    if [ "$rest" = "$re" ]; then note=""; else note="${rest#*|}"; fi
    if [ -n "$note" ]; then notesfx="（${note}）"; else notesfx=""; fi
    hits=$(git grep -nEI --heading -e "$re" HEAD -- . "${EXCLUDES[@]}" 2>/dev/null | head -10)
    if [ -n "$hits" ]; then
      echo "⚠️  [$label]${notesfx}"
      printf '%s\n' "$hits" | sed 's/^/      /'
      total=$((total + $(printf '%s\n' "$hits" | grep -c .)))
    fi
  done
fi

echo
if [ "$total" -eq 0 ]; then
  echo "✅ 无命中"
  exit 0
fi
echo "❌ 共 ${total} 处命中 —— 金额类需人工判断后再决定是否写进 rules.local.txt"
exit 1
