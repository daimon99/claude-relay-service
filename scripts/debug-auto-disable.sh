#!/bin/bash

# 自动禁用账户调试脚本
# 用于查看所有被自动禁用的账户及其详细信息

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
echo -e "${CYAN}自动禁用账户调试信息${NC}"
echo -e "${CYAN}=========================================${NC}"
echo -e "Redis: ${REDIS_HOST}:${REDIS_PORT} (DB: ${REDIS_DB})"
echo ""

# 检查 Redis 连接
if ! $REDIS_CMD PING > /dev/null 2>&1; then
  echo -e "${RED}❌ 无法连接到 Redis 服务器${NC}"
  echo "请检查 Redis 配置或确认 Redis 服务正在运行"
  exit 1
fi

# 查看所有被禁用的账户类型
echo -e "${BLUE}📋 所有账户类型的禁用索引:${NC}"
disabled_keys=$($REDIS_CMD KEYS "auto_disabled_accounts:*" 2>/dev/null)

if [ -z "$disabled_keys" ]; then
  echo -e "${GREEN}✅ 没有任何账户被自动禁用${NC}"
  echo ""
  echo -e "${CYAN}=========================================${NC}"
  echo -e "${GREEN}✅ 调试信息收集完成${NC}"
  echo -e "${CYAN}=========================================${NC}"
  exit 0
fi

echo "$disabled_keys"
echo ""

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

# 统计总数
total_disabled=0

# 遍历每个账户类型
for account_type in claude-console bedrock claude-official gemini openai-responses azure-openai droid ccr gemini-api; do
  count=$($REDIS_CMD SCARD "auto_disabled_accounts:$account_type" 2>/dev/null || echo "0")

  if [ "$count" -gt 0 ]; then
    total_disabled=$((total_disabled + count))

    echo -e "${YELLOW}----------------------------------------${NC}"
    echo -e "${YELLOW}🤖 账户类型: ${account_type}${NC}"
    echo -e "${YELLOW}📊 被禁用数量: ${count}${NC}"
    echo -e "${BLUE}📝 账户列表:${NC}"

    # 获取 Redis key 前缀
    key_prefix="${ACCOUNT_TYPE_MAP[$account_type]}"

    if [ -z "$key_prefix" ]; then
      echo -e "${RED}  ⚠️  未知的账户类型: $account_type${NC}"
      continue
    fi

    # 遍历每个账户
    $REDIS_CMD SMEMBERS "auto_disabled_accounts:$account_type" 2>/dev/null | while read account_id; do
      if [ -z "$account_id" ]; then
        continue
      fi

      echo -e "${GREEN}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
      echo -e "  ${CYAN}账户 ID:${NC} $account_id"

      # 获取账户详细信息
      disabled_at=$($REDIS_CMD HGET "${key_prefix}:${account_id}" autoDisabledAt 2>/dev/null)
      disabled_reason=$($REDIS_CMD HGET "${key_prefix}:${account_id}" autoDisabledReason 2>/dev/null)
      disabled_details=$($REDIS_CMD HGET "${key_prefix}:${account_id}" autoDisabledDetails 2>/dev/null)
      last_attempt=$($REDIS_CMD HGET "${key_prefix}:${account_id}" lastAutoRecoveryAttempt 2>/dev/null)
      recovered_at=$($REDIS_CMD HGET "${key_prefix}:${account_id}" autoRecoveredAt 2>/dev/null)
      schedulable=$($REDIS_CMD HGET "${key_prefix}:${account_id}" schedulable 2>/dev/null)

      # 显示基本信息
      if [ -n "$disabled_at" ]; then
        echo -e "  ${CYAN}禁用时间:${NC} $disabled_at"
      else
        echo -e "  ${RED}禁用时间:${NC} (未记录)"
      fi

      if [ -n "$disabled_reason" ]; then
        echo -e "  ${CYAN}禁用原因:${NC} $disabled_reason"
      else
        echo -e "  ${RED}禁用原因:${NC} (未记录)"
      fi

      # 解析详细信息
      if [ -n "$disabled_details" ]; then
        echo -e "  ${CYAN}详细信息:${NC}"

        # 尝试使用 jq 格式化 JSON
        if command -v jq &> /dev/null; then
          echo "$disabled_details" | jq -r '
            "    状态码: \(.statusCode // "未知")",
            "    错误消息: \(.errorMessage // "未知")",
            "    API地址: \(.apiUrl // "未知")",
            "    触发方式: \(if .triggerType == "test" then "测试连接" elif .triggerType == "request" then "API请求" else .triggerType // "未知" end)"
          ' 2>/dev/null || echo "    $disabled_details"
        else
          echo "    $disabled_details"
          echo -e "    ${YELLOW}💡 安装 jq 可以获得更好的格式化显示${NC}"
        fi
      fi

      # 显示恢复尝试信息
      if [ -n "$last_attempt" ]; then
        echo -e "  ${CYAN}最后检测:${NC} $last_attempt"

        # 计算距离下次检测的时间（假设间隔60分钟）
        if command -v date &> /dev/null; then
          last_timestamp=$(date -d "$last_attempt" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "${last_attempt:0:19}" +%s 2>/dev/null)
          if [ -n "$last_timestamp" ]; then
            current_timestamp=$(date +%s)
            next_check=$((last_timestamp + 3600)) # 60分钟 = 3600秒
            time_diff=$((next_check - current_timestamp))

            if [ $time_diff -gt 0 ]; then
              minutes_left=$((time_diff / 60))
              echo -e "  ${GREEN}下次检测:${NC} 约 ${minutes_left} 分钟后"
            else
              echo -e "  ${GREEN}下次检测:${NC} 即将进行"
            fi
          fi
        fi
      else
        echo -e "  ${YELLOW}最后检测:${NC} (尚未检测)"
        echo -e "  ${GREEN}下次检测:${NC} 等待中（首次检测）"
      fi

      if [ -n "$recovered_at" ]; then
        echo -e "  ${GREEN}恢复时间:${NC} $recovered_at"
      fi

      # 显示当前调度状态
      if [ "$schedulable" = "false" ]; then
        echo -e "  ${RED}当前状态:${NC} ❌ 不可调度"
      else
        echo -e "  ${GREEN}当前状态:${NC} ✅ 可调度"
      fi

      echo ""
    done
  fi
done

# 显示总结
echo -e "${CYAN}=========================================${NC}"
echo -e "${YELLOW}📊 统计信息:${NC}"
echo -e "  总计被禁用账户数: ${RED}${total_disabled}${NC}"
echo -e "${CYAN}=========================================${NC}"
echo -e "${GREEN}✅ 调试信息收集完成${NC}"
echo -e "${CYAN}=========================================${NC}"
echo ""
echo -e "${BLUE}💡 提示:${NC}"
echo "  - 账户会在下次检测时自动尝试恢复（默认每60分钟）"
echo "  - 可以手动修复账户凭据后等待自动恢复"
echo "  - 也可以在 Web 界面点击 '测试连接' 手动触发检测"
echo ""
