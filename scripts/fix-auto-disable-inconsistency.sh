#!/bin/bash

# 自动禁用数据不一致修复脚本
# 用于修复被错误添加到 auto_disabled_accounts Set 中的账户

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 读取 Redis 配置
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# 尝试从 .env 文件读取配置
if [ -f "$PROJECT_ROOT/.env" ]; then
  export $(cat "$PROJECT_ROOT/.env" | grep -E "^REDIS_" | xargs)
fi

# Redis 连接参数
REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"
REDIS_DB="${REDIS_DB:-0}"

# 构建 redis-cli 命令
REDIS_CMD="redis-cli -h $REDIS_HOST -p $REDIS_PORT -n $REDIS_DB"
if [ -n "$REDIS_PASSWORD" ]; then
  REDIS_CMD="$REDIS_CMD -a $REDIS_PASSWORD"
fi

echo -e "${CYAN}=========================================${NC}"
echo -e "${CYAN}自动禁用数据不一致修复工具${NC}"
echo -e "${CYAN}=========================================${NC}"
echo -e "Redis: ${REDIS_HOST}:${REDIS_PORT} (DB: ${REDIS_DB})"
echo ""

# 检查 Redis 连接
if ! $REDIS_CMD PING > /dev/null 2>&1; then
  echo -e "${RED}❌ 无法连接到 Redis 服务器${NC}"
  echo "请检查 Redis 配置或确认 Redis 服务正在运行"
  exit 1
fi

# 定义账户类型映射
declare -A ACCOUNT_TYPE_MAP
ACCOUNT_TYPE_MAP["claude-console"]="claude_console_account"
ACCOUNT_TYPE_MAP["bedrock"]="bedrock_account"
ACCOUNT_TYPE_MAP["claude-official"]="claude_account"
ACCOUNT_TYPE_MAP["gemini"]="gemini_account"
ACCOUNT_TYPE_MAP["openai-responses"]="openai_responses_account"
ACCOUNT_TYPE_MAP["azure-openai"]="azure_openai_account"
ACCOUNT_TYPE_MAP["droid"]="droid_account"
ACCOUNT_TYPE_MAP["ccr"]="ccr_account"
ACCOUNT_TYPE_MAP["gemini-api"]="gemini_api_account"

# 创建临时文件记录统计
TEMP_DIR=$(mktemp -d)
STAT_FILE="$TEMP_DIR/stats"
echo "0" > "$STAT_FILE.checked"
echo "0" > "$STAT_FILE.fixed"
echo "0" > "$STAT_FILE.skipped"

echo -e "${BLUE}🔍 扫描数据不一致的账户...${NC}"
echo ""

# 遍历每个账户类型
for account_type in claude-console bedrock claude-official gemini openai-responses azure-openai droid ccr gemini-api; do
  count=$($REDIS_CMD SCARD "auto_disabled_accounts:$account_type" 2>/dev/null || echo "0")

  if [ "$count" -gt 0 ]; then
    key_prefix="${ACCOUNT_TYPE_MAP[$account_type]}"

    if [ -z "$key_prefix" ]; then
      continue
    fi

    # 获取所有账户ID
    account_ids=$($REDIS_CMD SMEMBERS "auto_disabled_accounts:$account_type" 2>/dev/null)

    # 遍历每个账户
    while IFS= read -r account_id; do
      if [ -z "$account_id" ]; then
        continue
      fi

      # 增加检查计数
      checked=$(cat "$STAT_FILE.checked")
      echo $((checked + 1)) > "$STAT_FILE.checked"

      # 检查账户字段
      disabled_at=$($REDIS_CMD HGET "${key_prefix}:${account_id}" autoDisabledAt 2>/dev/null)
      disabled_reason=$($REDIS_CMD HGET "${key_prefix}:${account_id}" autoDisabledReason 2>/dev/null)

      # 如果字段为空，说明数据不一致
      if [ -z "$disabled_at" ] || [ -z "$disabled_reason" ]; then
        echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${YELLOW}发现数据不一致:${NC}"
        echo -e "  账户类型: $account_type"
        echo -e "  账户 ID: $account_id"
        echo -e "  autoDisabledAt: ${disabled_at:-(空)}"
        echo -e "  autoDisabledReason: ${disabled_reason:-(空)}"
        echo ""

        # 询问是否修复
        read -p "是否从自动禁用索引中移除此账户? (y/n): " confirm
        if [[ $confirm =~ ^[Yy]$ ]]; then
          # 从 Set 中移除
          $REDIS_CMD SREM "auto_disabled_accounts:$account_type" "$account_id" > /dev/null 2>&1

          if [ $? -eq 0 ]; then
            echo -e "${GREEN}✅ 已移除账户 $account_id${NC}"
            fixed=$(cat "$STAT_FILE.fixed")
            echo $((fixed + 1)) > "$STAT_FILE.fixed"
          else
            echo -e "${RED}❌ 移除失败${NC}"
          fi
        else
          echo -e "${BLUE}⏭️  跳过此账户${NC}"
          skipped=$(cat "$STAT_FILE.skipped")
          echo $((skipped + 1)) > "$STAT_FILE.skipped"
        fi
        echo ""
      fi
    done <<< "$account_ids"
  fi
done

# 读取最终统计
total_checked=$(cat "$STAT_FILE.checked")
total_fixed=$(cat "$STAT_FILE.fixed")
total_skipped=$(cat "$STAT_FILE.skipped")

# 清理临时文件
rm -rf "$TEMP_DIR"

# 显示总结
echo -e "${CYAN}=========================================${NC}"
echo -e "${YELLOW}📊 修复统计:${NC}"
echo -e "  检查账户数: ${CYAN}${total_checked}${NC}"
echo -e "  修复账户数: ${GREEN}${total_fixed}${NC}"
echo -e "  跳过账户数: ${BLUE}${total_skipped}${NC}"
echo -e "${CYAN}=========================================${NC}"
echo -e "${GREEN}✅ 修复完成${NC}"
echo -e "${CYAN}=========================================${NC}"
echo ""

if [ $total_fixed -gt 0 ]; then
  echo -e "${BLUE}💡 提示:${NC}"
  echo "  - 已从自动禁用索引中移除 $total_fixed 个不一致的账户"
  echo "  - 这些账户的 schedulable 状态未改变"
  echo "  - 如需启用调度，请在 Web 界面手动启用或运行:"
  echo "    redis-cli HSET <account_key> schedulable true"
  echo ""
fi
