#!/bin/bash

# 一键修复特定账户的自动禁用数据不一致问题

ACCOUNT_ID="2381be85-ee26-4454-a898-0324d53e8ef2"
ACCOUNT_TYPE="claude-console"
KEY_PREFIX="claude_console_account"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}=========================================${NC}"
echo -e "${CYAN}修复账户数据不一致${NC}"
echo -e "${CYAN}=========================================${NC}"
echo -e "账户 ID: ${YELLOW}${ACCOUNT_ID}${NC}"
echo -e "账户类型: ${YELLOW}${ACCOUNT_TYPE}${NC}"
echo ""

# 检查当前状态
echo -e "${BLUE}📋 当前状态:${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 检查是否在 Set 中
IN_SET=$(redis-cli SISMEMBER auto_disabled_accounts:${ACCOUNT_TYPE} ${ACCOUNT_ID})
echo -e "在自动禁用索引中: $([ "$IN_SET" = "1" ] && echo -e "${RED}是${NC}" || echo -e "${GREEN}否${NC}")"

# 检查关键字段
SCHEDULABLE=$(redis-cli HGET ${KEY_PREFIX}:${ACCOUNT_ID} schedulable)
AUTO_DISABLED_AT=$(redis-cli HGET ${KEY_PREFIX}:${ACCOUNT_ID} autoDisabledAt)
AUTO_DISABLED_REASON=$(redis-cli HGET ${KEY_PREFIX}:${ACCOUNT_ID} autoDisabledReason)

echo -e "schedulable: ${SCHEDULABLE}"
echo -e "autoDisabledAt: ${AUTO_DISABLED_AT:-(空)}"
echo -e "autoDisabledReason: ${AUTO_DISABLED_REASON:-(空)}"
echo ""

# 判断是否需要修复
NEEDS_FIX=false
if [ "$IN_SET" = "1" ]; then
  if [ -z "$AUTO_DISABLED_AT" ] || [ -z "$AUTO_DISABLED_REASON" ]; then
    NEEDS_FIX=true
  fi
fi

if [ "$NEEDS_FIX" = "false" ]; then
  echo -e "${GREEN}✅ 数据一致，无需修复${NC}"
  exit 0
fi

echo -e "${YELLOW}⚠️  检测到数据不一致！${NC}"
echo ""

# 提供修复选项
echo -e "${CYAN}请选择修复方式:${NC}"
echo "  1) 彻底清理（从索引移除 + 清理字段 + 启用调度）"
echo "  2) 只从索引移除（保持其他字段不变）"
echo "  3) 取消"
echo ""
read -p "请选择 [1-3]: " choice

case $choice in
  1)
    echo ""
    echo -e "${BLUE}🔧 执行彻底清理...${NC}"

    # 1. 从 Set 中移除
    echo -e "  ➜ 从自动禁用索引移除..."
    redis-cli SREM auto_disabled_accounts:${ACCOUNT_TYPE} ${ACCOUNT_ID} > /dev/null

    # 2. 清理自动禁用字段
    echo -e "  ➜ 清理自动禁用字段..."
    redis-cli HDEL ${KEY_PREFIX}:${ACCOUNT_ID} \
      autoDisabledAt \
      autoDisabledReason \
      autoDisabledDetails \
      lastAutoRecoveryAttempt \
      autoRecoveredAt > /dev/null

    # 3. 启用调度
    echo -e "  ➜ 启用调度..."
    redis-cli HSET ${KEY_PREFIX}:${ACCOUNT_ID} schedulable true > /dev/null

    echo ""
    echo -e "${GREEN}✅ 修复完成！${NC}"
    echo -e "  - 已从自动禁用索引移除"
    echo -e "  - 已清理所有自动禁用字段"
    echo -e "  - 已启用调度 (schedulable: true)"
    ;;

  2)
    echo ""
    echo -e "${BLUE}🔧 只移除索引...${NC}"

    # 只从 Set 中移除
    redis-cli SREM auto_disabled_accounts:${ACCOUNT_TYPE} ${ACCOUNT_ID} > /dev/null

    echo ""
    echo -e "${GREEN}✅ 修复完成！${NC}"
    echo -e "  - 已从自动禁用索引移除"
    echo -e "  - 其他字段保持不变"
    echo -e "  - schedulable 状态: ${SCHEDULABLE}"
    ;;

  3)
    echo ""
    echo -e "${YELLOW}❌ 已取消修复${NC}"
    exit 0
    ;;

  *)
    echo ""
    echo -e "${RED}❌ 无效选择${NC}"
    exit 1
    ;;
esac

echo ""
echo -e "${CYAN}=========================================${NC}"
echo -e "${BLUE}📋 修复后状态:${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 再次检查状态
IN_SET_AFTER=$(redis-cli SISMEMBER auto_disabled_accounts:${ACCOUNT_TYPE} ${ACCOUNT_ID})
SCHEDULABLE_AFTER=$(redis-cli HGET ${KEY_PREFIX}:${ACCOUNT_ID} schedulable)
AUTO_DISABLED_AT_AFTER=$(redis-cli HGET ${KEY_PREFIX}:${ACCOUNT_ID} autoDisabledAt)
AUTO_DISABLED_REASON_AFTER=$(redis-cli HGET ${KEY_PREFIX}:${ACCOUNT_ID} autoDisabledReason)

echo -e "在自动禁用索引中: $([ "$IN_SET_AFTER" = "1" ] && echo -e "${RED}是${NC}" || echo -e "${GREEN}否${NC}")"
echo -e "schedulable: ${SCHEDULABLE_AFTER}"
echo -e "autoDisabledAt: ${AUTO_DISABLED_AT_AFTER:-(空)}"
echo -e "autoDisabledReason: ${AUTO_DISABLED_REASON_AFTER:-(空)}"

echo ""
echo -e "${GREEN}✅ 修复流程完成${NC}"
echo -e "${CYAN}=========================================${NC}"
echo ""

echo -e "${BLUE}💡 后续步骤:${NC}"
echo "  1. 刷新 Web 界面查看账户状态"
echo "  2. 运行调试脚本验证: ./scripts/debug-auto-disable.sh"
echo "  3. 如需测试账户，在 Web 界面点击 '测试连接'"
echo ""
