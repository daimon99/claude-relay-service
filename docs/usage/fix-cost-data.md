# 费用数据修复脚本

## 概述

`scripts/fix-cost-data.js` 用于修复因定价数据缺失导致的 API Key 费用计算错误。

### 问题背景

当使用的模型（如 `claude-opus-4-5-20251101`、`claude-haiku-4-5-20251001`）不在 `pricingService` 的定价数据中时，流式请求的费用会被错误地计算为 0，导致 `usage:cost:total:{keyId}` 累计值偏低。

此脚本会从历史 token 使用数据（`usage:{keyId}:model:monthly:*`）重新计算费用，并更新正确的累计值。

## 使用方法

```bash
cd /data/prd/claude-relay-service/app

# 检查所有 API Key（dry-run 模式，只查看不修改）
node scripts/fix-cost-data.js

# 按名称检查指定 Key
node scripts/fix-cost-data.js --name <keyName>

# 按 ID 检查指定 Key
node scripts/fix-cost-data.js --key <keyId>

# 修复指定 Key（按名称）
node scripts/fix-cost-data.js --name <keyName> --fix

# 修复指定 Key（按 ID）
node scripts/fix-cost-data.js --key <keyId> --fix

# 修复所有 API Key
node scripts/fix-cost-data.js --fix
```

## 参数说明

| 参数 | 说明 |
|------|------|
| `--name <keyName>` | 按名称模糊匹配 API Key |
| `--key <keyId>` | 按 UUID 精确匹配 API Key |
| `--fix` | 执行修复（不加此参数为 dry-run 检查模式） |

## 输出示例

### Dry-run 模式（检查）

```
============================================================
💰 费用数据修复工具
============================================================
Mode: DRY-RUN (检查模式)
Searching for API Key with name containing: 小笼包
Found API Key: 小笼包 (8475f90b-bf39-4a40-bed8-994ab9ff47a1)
============================================================

📊 API Key: 小笼包 (8475f90b-bf39-4a40-bed8-994ab9ff47a1)
   Data source: monthly
   Current total cost:  $9.202820
   Calculated cost:     $41.633468
   Difference:          $32.430648 (352.4%)
   By model:
     - claude-haiku-4-5-20251001: $4.2597 (234 reqs, 5,025,608 tokens)
     - claude-sonnet-4-5-20250929: $4.1321 (50 reqs, 7,342,032 tokens)
     - claude-opus-4-5-20251101: $33.2416 (335 reqs, 73,716,248 tokens)
   ℹ️  Dry-run mode, no changes made. Use --fix to apply.

============================================================
📊 Summary
============================================================
Total API Keys checked: 1
Keys with cost discrepancy: 1
Total cost difference: $32.430648

⚠️  This was a dry-run. Run with --fix to apply changes.
```

### Fix 模式（修复）

```
============================================================
💰 费用数据修复工具
============================================================
Mode: FIX (修复模式)
...
   ✅ Fixed! Updated total cost to $41.633468

============================================================
📊 Summary
============================================================
Total API Keys checked: 1
Keys with cost discrepancy: 1
Total cost difference: $32.430648

✅ All cost data has been fixed!
```

## 技术说明

### 数据来源

脚本优先使用 `usage:{keyId}:model:monthly:*` 数据（90 天 TTL），如果没有则使用 `usage:{keyId}:model:daily:*` 数据（30 天 TTL）。

### 费用计算

使用 `CostCalculator` 计算费用，该模块在找不到模型定价时会回退到 `unknown` 兜底价格：
- Input: $3/M tokens
- Output: $15/M tokens
- Cache Write: $3.75/M tokens
- Cache Read: $0.3/M tokens

### 修改的 Redis Key

脚本只修改 `usage:cost:total:{keyId}` 的值，不影响其他统计数据。

## 注意事项

1. **先检查后修复**：建议先不加 `--fix` 参数运行，确认差异符合预期后再��行修复
2. **备份数据**：如有需要，可先导出 Redis 数据备份
3. **历史数据限制**：由于 daily 数据有 30 天 TTL，超过 30 天的详细 token 数据可能已丢失，此时会使用 monthly 汇总数据
4. **定价准确性**：修复使用的是 `unknown` 兜底价格，与实际模型价格可能有差异。建议同时更新定价文件以支持新模型

## 相关文件

- 脚本位置: `scripts/fix-cost-data.js`
- 定价服务: `src/services/pricingService.js`
- 费用计算器: `src/utils/costCalculator.js`
- API Key 服务: `src/services/apiKeyService.js`
