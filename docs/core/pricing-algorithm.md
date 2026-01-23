# 计费模型算法说明

本文档详细说明 Claude Relay Service 的计费模型算法及价格回退策略。

## 目录

- [概述](#概述)
- [价格数据源](#价格数据源)
- [模型价格匹配流程](#模型价格匹配流程)
- [智能兜底策略](#智能兜底策略)
- [特殊价格处理](#特殊价格处理)
- [费用计算](#费用计算)
- [使用示例](#使用示例)

## 概述

PricingService 负责管理和计算 AI 模型的使用费用。系统采用多级匹配策略，确保即使新模型或未知模型也能获得合理的价格估算。

## 价格数据源

### 1. 主要数据源

- **远程数据源**: 从配置的 URL 定期下载最新的模型价格数据
- **本地缓存**: 保存在 `data/model_pricing.json`
- **Fallback 数据**: `resources/model-pricing/model_prices_and_context_window.json`

### 2. 硬编码价格

#### 1 小时缓存价格 (ephemeral_1h)

```javascript
{
  // Opus 系列: $30/MTok
  'claude-opus-4-1': 0.00003,
  'claude-3-opus-latest': 0.00003,

  // Sonnet 系列: $6/MTok
  'claude-3-5-sonnet-latest': 0.000006,
  'claude-sonnet-4-20250514': 0.000006,

  // Haiku 系列: $1.6/MTok
  'claude-3-5-haiku-latest': 0.0000016,
  'claude-3-haiku-20240307': 0.0000016
}
```

#### 1M 上下文模型价格

当总输入 tokens 超过 200k 时，使用特殊的 1M 上下文价格：

```javascript
{
  'claude-sonnet-4-20250514[1m]': {
    input: 0.000006,   // $6/MTok
    output: 0.0000225  // $22.50/MTok
  }
}
```

## 模型价格匹配流程

系统采用以下优先级顺序尝试匹配模型价格：

### 1. 精确匹配 (Exact Match)

直接使用模型名称在价格数据中查找。

```javascript
// 示例
modelName = 'claude-3-5-sonnet-20241022'
// → 直接在 pricingData 中查找该键
```

### 2. 特殊模型处理

#### GPT-5-Codex 回退

```javascript
if (modelName === 'gpt-5-codex' && !found) {
  return pricingData['gpt-5']
}
```

### 3. Bedrock 区域前缀处理

移除 AWS Bedrock 模型的区域前缀（us/eu/apac）：

```javascript
// 示例
modelName = 'us.anthropic.claude-sonnet-4-20250514-v1:0'
// → 尝试匹配 'anthropic.claude-sonnet-4-20250514-v1:0'
```

### 4. 模糊匹配 (Fuzzy Match)

规范化模型名称（移除下划线和连字符）进行模糊匹配：

```javascript
// 示例
modelName = 'claude_3_5_sonnet'
// → 规范化为 'claude35sonnet'
// → 与价格数据中的键进行模糊比对
```

### 5. Bedrock 核心模型匹配

对于 Bedrock 模型，提取核心模型名进行匹配：

```javascript
// 示例
modelName = 'us.anthropic.claude-haiku-3-5-v2:0'
// → 提取核心部分 'claude-haiku-3-5-v2:0'
// → 在价格数据中查找包含该核心名的模型
```

## 智能兜底策略

**新增功能**: 基于模型名称关键字的智能兜底机制，使用固定价格确保不同版本计费一致。

### 兜底规则

当以上所有匹配策略都失败时，系统会根据模型名称中的关键字使用固定的系列价格：

#### 1. Haiku 系列兜底

```javascript
if (modelName.toLowerCase().includes('haiku')) {
  return {
    input_cost_per_token: 0.000001,              // $1/MTok
    output_cost_per_token: 0.000005,             // $5/MTok
    cache_creation_input_token_cost: 0.00000125, // $1.25/MTok
    cache_read_input_token_cost: 0.0000001       // $0.1/MTok
  }
}
```

**适用场景**:

- `claude-haiku-4-5-20251001` → 使用固定 Haiku 系列价格
- `claude-haiku-5` → 使用固定 Haiku 系列价格
- `anthropic.claude-haiku-20260101` → 使用固定 Haiku 系列价格
- 任何包含 "haiku" 的未知模型

#### 2. Opus 系列兜底

```javascript
if (modelName.toLowerCase().includes('opus')) {
  return {
    input_cost_per_token: 0.000005,              // $5/MTok
    output_cost_per_token: 0.000025,             // $25/MTok
    cache_creation_input_token_cost: 0.00000625, // $6.25/MTok
    cache_read_input_token_cost: 0.0000005       // $0.5/MTok
  }
}
```

**适用场景**:

- `claude-opus-4-5-20251101` → 使用固定 Opus 系列价格
- `claude-opus-5` → 使用固定 Opus 系列价格
- `us.anthropic.claude-opus-20260101` → 使用固定 Opus 系列价格
- 任何包含 "opus" 的未知模型

#### 3. Sonnet 系列兜底

```javascript
if (modelName.toLowerCase().includes('sonnet')) {
  return {
    input_cost_per_token: 0.000003,              // $3/MTok
    output_cost_per_token: 0.000015,             // $15/MTok
    cache_creation_input_token_cost: 0.00000375, // $3.75/MTok
    cache_read_input_token_cost: 0.0000003       // $0.3/MTok
  }
}
```

**适用场景**:

- `claude-sonnet-5` → 使用固定 Sonnet 系列价格
- `anthropic.claude-sonnet-20260101` → 使用固定 Sonnet 系列价格
- 任何包含 "sonnet" 的未知模型

### 优先级顺序

智能兜底的检查顺序为：**Haiku → Opus → Sonnet**

这个顺序确保了最具体的匹配优先。注意系统使用 `includes()` 检查，因此如果模型名同时包含多个关键字（如 `claude-sonnet-opus`），会匹配到第一个命中的规则。

### 固定价格的优势

使用固定价格而非引用特定版本（如 `claude-3-5-haiku-latest`）的优点：

1. **计费一致性**: 避免因不同版本价格差异导致历史数据重新计算时费用不一致
2. **版本独立**: 不依赖具体版本存在于定价数据中
3. **可预测性**: 新版本发布不会影响兜底价格
4. **简化维护**: 无需频繁更新兜底规则

### 日志记录

当使用兜底策略时，系统会记录 info 级别的日志：

```
💰 Using fixed haiku series pricing as fallback for unknown model: claude-haiku-4-5-20251001
💰 Using fixed opus series pricing as fallback for unknown model: claude-opus-4-5-20251101
💰 Using fixed sonnet series pricing as fallback for unknown model: claude-sonnet-5
```

## 特殊价格处理

### 1. 缓存价格 (Prompt Caching)

如果模型价格数据中缺少缓存价格，系统会自动计算：

```javascript
cache_creation_input_token_cost = input_cost_per_token × 1.25
cache_read_input_token_cost = input_cost_per_token × 0.1
```

### 2. 5 分钟缓存 (ephemeral_5m)

使用 `cache_creation_input_token_cost` 价格。

### 3. 1 小时缓存 (ephemeral_1h)

使用硬编码的 `ephemeral1hPricing` 价格，支持系列兜底：

```javascript
getEphemeral1hPricing(modelName) {
  // 1. 尝试直接匹配
  if (ephemeral1hPricing[modelName]) return price

  // 2. 系列兜底
  if (modelName.includes('opus')) return 0.00003    // $30/MTok
  if (modelName.includes('sonnet')) return 0.000006 // $6/MTok
  if (modelName.includes('haiku')) return 0.0000016 // $1.6/MTok

  return 0 // 未知模型
}
```

## 费用计算

### 基本计算公式

```javascript
totalCost = inputCost + outputCost + cacheCreateCost + cacheReadCost

// 其中：
inputCost = input_tokens × input_cost_per_token
outputCost = output_tokens × output_cost_per_token
cacheReadCost = cache_read_tokens × cache_read_cost_per_token
```

### 缓存创建费用

系统支持两种格式：

#### 详细格式 (推荐)

```javascript
cacheCreateCost = ephemeral5mCost + ephemeral1hCost

// 其中：
ephemeral5mCost = ephemeral_5m_tokens × cache_creation_cost
ephemeral1hCost = ephemeral_1h_tokens × ephemeral_1h_price
```

#### 旧格式 (向后兼容)

```javascript
cacheCreateCost = cache_creation_input_tokens × cache_creation_cost
```

### 1M 上下文特殊处理

当模型名包含 `[1m]` 且总输入 tokens > 200k 时：

```javascript
// 使用 1M 上下文特殊价格
inputCost = input_tokens × longContextPrices.input
outputCost = output_tokens × longContextPrices.output

// 缓存价格保持不变
```

### 返回结果

```javascript
{
  inputCost: 0.0015,        // 输入费用
  outputCost: 0.0075,       // 输出费用
  cacheCreateCost: 0.0002,  // 缓存创建费用
  cacheReadCost: 0.00001,   // 缓存读取费用
  ephemeral5mCost: 0.00015, // 5分钟缓存费用
  ephemeral1hCost: 0.00005, // 1小时缓存费用
  totalCost: 0.009351,      // 总费用
  hasPricing: true,         // 是否找到价格
  isLongContextRequest: false, // 是否使用1M上下文价格
  pricing: {                // 使用的价格（每token）
    input: 0.000003,
    output: 0.000015,
    cacheCreate: 0.00000375,
    cacheRead: 0.0000003,
    ephemeral1h: 0.000006
  }
}
```

## 使用示例

### 示例 1: 精确匹配

```javascript
// 请求
modelName = 'claude-3-5-sonnet-20241022'

// 结果：直接在价格数据中找到
// 使用 claude-3-5-sonnet-20241022 的官方价格
```

### 示例 2: Bedrock 模型

```javascript
// 请求
modelName = 'us.anthropic.claude-sonnet-4-20250514-v1:0'

// 匹配过程：
// 1. 精确匹配失败
// 2. 移除区域前缀 → 'anthropic.claude-sonnet-4-20250514-v1:0'
// 3. 在价格数据中找到匹配

// 结果：使用匹配到的价格
```

### 示例 3: 未知 Haiku 模型（兜底）

```javascript
// 请求
modelName = 'claude-haiku-4' // 假设这是未来的新模型

// 匹配过程：
// 1. 精确匹配失败
// 2. 特殊处理不适用
// 3. 区域前缀处理不适用
// 4. 模糊匹配失败
// 5. Bedrock 匹配不适用
// 6. **智能兜底**: 检测到 'haiku' 关键字
// 7. 使用 'claude-3-5-haiku-latest' 价格

// 结果：
// logger.info('💰 Using claude-3-5-haiku-latest pricing as fallback for unknown haiku model: claude-haiku-4')
// 返回 claude-3-5-haiku-latest 的价格数据
```

### 示例 4: 未知 Sonnet 模型（兜底）

```javascript
// 请求
modelName = 'anthropic.claude-sonnet-20260101-v2:0'

// 匹配过程：
// 1-5. 各级匹配失败
// 6. **智能兜底**: 检测到 'sonnet' 关键字
// 7. 使用 'claude-3-5-sonnet-latest' 价格

// 结果：使用 Sonnet 系列兜底价格
```

### 示例 5: 1M 上下文请求

```javascript
// 请求
modelName = 'claude-sonnet-4-20250514[1m]'
usage = {
  input_tokens: 250000,
  output_tokens: 1000
}

// 计算：
// 总输入 > 200k，使用 1M 上下文价格
inputCost = 250000 × 0.000006 = $1.50
outputCost = 1000 × 0.0000225 = $0.0225
totalCost = $1.5225
```

### 示例 6: 详细缓存费用

```javascript
// 请求
usage = {
  input_tokens: 10000,
  output_tokens: 500,
  cache_creation: {
    ephemeral_5m_input_tokens: 5000,
    ephemeral_1h_input_tokens: 2000
  },
  cache_read_input_tokens: 3000
}

// 计算：
ephemeral5mCost = 5000 × cache_creation_cost
ephemeral1hCost = 2000 × ephemeral_1h_price
cacheReadCost = 3000 × cache_read_cost
totalCost = inputCost + outputCost + ephemeral5mCost + ephemeral1hCost + cacheReadCost
```

## 价格数据更新

### 自动更新机制

- **定时更新**: 每 24 小时自动检查并更新价格数据
- **哈希校验**: 每 10 分钟检查远程文件哈希，发现变化立即更新
- **文件监听**: 监听本地价格文件变化，自动重新加载（60 秒轮询）

### 手动更新

```bash
# 通过 API 强制更新
curl -X POST http://localhost:3000/admin/pricing/force-update

# 或使用脚本
npm run update:pricing
```

### Fallback 策略

当远程数据不可用时，系统会按以下优先级使用数据：

1. 本地缓存 (`data/model_pricing.json`)
2. Fallback 文件 (`resources/model-pricing/model_prices_and_context_window.json`)
3. 空数据（返回 `hasPricing: false`）

## 最终兜底价格

如果所有匹配策略（包括智能兜底）都失败，系统会在 `calculateCost` 中返回：

```javascript
{
  hasPricing: false,
  totalCost: 0,
  // 所有费用字段均为 0
}
```

**注意**: `costCalculator.js` 可能有额外的硬编码兜底价格处理未知模型。

## 相关文件

- **核心服务**: `src/services/pricingService.js`
- **费用计算器**: `src/utils/costCalculator.js`
- **价格配置**: `config/pricingSource.js`
- **价格数据**: `data/model_pricing.json`
- **Fallback 数据**: `resources/model-pricing/model_prices_and_context_window.json`
- **更新脚本**: `scripts/update-model-pricing.js`
- **测试脚本**: `scripts/test-pricing-fallback.js`

## 调试和日志

### 查看价格匹配日志

```bash
# 设置日志级别为 debug
LOG_LEVEL=debug npm start

# 查看价格相关日志
tail -f logs/claude-relay-*.log | grep "💰"
```

### 测试价格回退

```bash
# 运行价格回退测试脚本
npm run test:pricing-fallback
```

### 常见日志消息

```
💰 Found exact pricing match for claude-3-5-sonnet-20241022
💰 Using claude-3-5-haiku-latest pricing as fallback for unknown haiku model: claude-haiku-4
💰 Using gpt-5 pricing as fallback for gpt-5-codex
💰 Found pricing for us.anthropic.claude-sonnet-4 by removing region prefix
💰 Using 1M context pricing for claude-sonnet-4-20250514[1m]
💰 No pricing found for model: unknown-model-xyz
```

## 最佳实践

1. **定期更新价格数据**: 使用自动更新机制或定期手动更新
2. **监控兜底使用**: 关注使用兜底价格的模型，考虑添加精确价格
3. **测试新模型**: 新模型上线前，先测试价格计算是否正确
4. **日志分析**: 定期检查日志，识别未匹配的模型
5. **Fallback 维护**: 保持 fallback 文件为最新的官方价格数据

## 未来改进

- [ ] 支持更多模型系列的智能兜底（如 GPT、Gemini 等）
- [ ] 添加价格预警机制（价格变化通知）
- [ ] 支持自定义兜底价格配置
- [ ] 提供价格匹配质量评分
- [ ] 增加价格历史追踪功能
