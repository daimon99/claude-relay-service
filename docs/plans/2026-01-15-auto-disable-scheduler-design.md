# 自动账户调度禁用和恢复设计

**设计日期**: 2026-01-15
**设计者**: Claude Code (with user)
**状态**: 已确认，待实现

## 概述

当后端 API 返回 4xx 或 5xx 错误时，自动将该账户标记为"不可调度"状���，避免继续使用有问题的账户。同时提供自动恢复机制，定期测试被禁用的账户，测试通过后自动恢复可调度状态。

## 需求确认

1. **触发条件**: 所有 4xx/5xx HTTP 状态码统一处理
2. **触发场景**: 正常 API 请求错误 + 手动连通性测试错误
3. **恢复策略**: 每 1 小时自动测试，测试通过即恢复
4. **恢复限制**: 无限制，只要测试通过就恢复
5. **适用范围**: 所有账户类型（Claude官方/Console、Gemini、Bedrock、Azure、Droid、CCR 等）

## 设计方案

### 1. 核心数据结构

#### 账户状态字段扩展

在现有账户数据结构中新增以下字段：

```javascript
{
  // === 现有字段 ===
  schedulable: false,  // 是否可调度（现有）

  // === 新增字段 ===
  autoDisabledAt: "2026-01-15T12:00:00Z",  // 自动禁用的时间
  autoDisabledReason: "HTTP 404: page not found",  // 禁用原因（简短）
  autoDisabledDetails: {  // 详细错误信息（JSON 字符串存储）
    statusCode: 404,
    errorMessage: "404 page not found",
    apiUrl: "https://api.example.com/v1/messages",
    triggerType: "request"  // "request" 或 "test"
  },
  lastAutoRecoveryAttempt: "2026-01-15T13:00:00Z",  // 最后一次自动恢复尝试时间
  autoRecoveredAt: "2026-01-15T14:00:00Z"  // 最后一次自动恢复成功时间
}
```

#### Redis 索引设计

为了高效查询需要自动恢复的账户，新增 Redis Set 索引：

```
auto_disabled_accounts:claude-official     # Set: 所有被自动禁用的 Claude 官方账户 ID
auto_disabled_accounts:claude-console      # Set: 所有被自动禁用的 Claude Console 账户 ID
auto_disabled_accounts:gemini              # Set: 所有被自动禁用的 Gemini 账户 ID
auto_disabled_accounts:bedrock             # Set: 所有被自动禁用的 Bedrock 账户 ID
auto_disabled_accounts:azure-openai        # Set: 所有被自动禁用的 Azure OpenAI 账户 ID
auto_disabled_accounts:droid               # Set: 所有被自动禁用的 Droid 账户 ID
auto_disabled_accounts:ccr                 # Set: 所有被自动禁用的 CCR 账户 ID
auto_disabled_accounts:openai-responses    # Set: 所有被自动禁用的 OpenAI Responses 账户 ID
```

**设计理由**:
- 使用 Set 数据结构，方便快速查询和去重
- 按账户类型分组，便于分批处理和并发控制
- 恢复成功后从 Set 中移除，减少后续扫描开销

### 2. 统一的自动禁用服务

#### 新建服务文件

创建 `src/services/accountAutoDisableService.js`，提供统一的错误处理和账户禁用逻辑。

```javascript
class AccountAutoDisableService {
  /**
   * 处理错误响应并可能禁用账户
   * @param {string} accountId - 账户 ID
   * @param {string} accountType - 账户类型
   * @param {number} statusCode - HTTP 状态码
   * @param {string} errorMessage - 错误消息
   * @param {string} apiUrl - 请求的 URL
   * @param {string} triggerType - 触发类型："request" 或 "test"
   * @returns {Promise<Object>} { disabled: boolean, reason: string }
   */
  async handleErrorResponse(accountId, accountType, statusCode, errorMessage, apiUrl, triggerType) {
    // 只处理 4xx 和 5xx 错误
    if (statusCode < 400 || statusCode >= 600) {
      return { disabled: false }
    }

    logger.warn(`🚫 [Auto Disable] ${triggerType} - Account ${accountId} (${accountType}) encountered ${statusCode}, disabling`, {
      accountId,
      accountType,
      statusCode,
      errorMessage: errorMessage.substring(0, 200),
      apiUrl,
      triggerType
    })

    // 准备更新数据
    const updates = {
      schedulable: false,
      autoDisabledAt: new Date().toISOString(),
      autoDisabledReason: `HTTP ${statusCode}: ${errorMessage.substring(0, 200)}`,
      autoDisabledDetails: JSON.stringify({
        statusCode,
        errorMessage,
        apiUrl,
        triggerType,
        disabledAt: new Date().toISOString()
      })
    }

    // 根据账户类型更新账户数据
    await this._updateAccountByType(accountId, accountType, updates)

    // 添加到自动禁用索引
    await redis.sadd(`auto_disabled_accounts:${accountType}`, accountId)

    return { disabled: true, reason: updates.autoDisabledReason }
  }

  /**
   * 根据账户类型更新账户数据
   */
  async _updateAccountByType(accountId, accountType, updates) {
    switch (accountType) {
      case 'claude-official':
        await claudeAccountService.updateAccount(accountId, updates)
        break
      case 'claude-console':
        await claudeConsoleAccountService.updateAccount(accountId, updates)
        break
      case 'gemini':
        await geminiAccountService.updateAccount(accountId, updates)
        break
      case 'bedrock':
        await bedrockAccountService.updateAccount(accountId, updates)
        break
      case 'azure-openai':
        await azureOpenaiAccountService.updateAccount(accountId, updates)
        break
      case 'droid':
        await droidAccountService.updateAccount(accountId, updates)
        break
      case 'ccr':
        await ccrAccountService.updateAccount(accountId, updates)
        break
      case 'openai-responses':
        await openaiResponsesAccountService.updateAccount(accountId, updates)
        break
      default:
        throw new Error(`Unknown account type: ${accountType}`)
    }
  }
}

module.exports = new AccountAutoDisableService()
```

### 3. 集成到各个 RelayService

需要在以下位置调用 `accountAutoDisableService.handleErrorResponse()`：

#### 3.1 claudeRelayService.js

**非流式请求错误处理**（约在 649 行）：

```javascript
// 在现有的错误处理代码块中，添加统一的自动禁用逻辑
if (response.statusCode !== 200 && response.statusCode !== 201) {
  // ... 现有的特殊错误处理（401、403、429、529 等）...

  // 【新增】统一的 4xx/5xx 自动禁用逻辑
  if (response.statusCode >= 400 && response.statusCode < 600) {
    await accountAutoDisableService.handleErrorResponse(
      accountId,
      accountType,
      response.statusCode,
      this._extractErrorMessage(response.body),
      'https://api.anthropic.com/v1/messages',
      'request'
    )
  }
}
```

**流式请求错误处理**（约在 1981 行 `handleErrorResponse` 函数内）：

```javascript
const handleErrorResponse = async () => {
  // ... 现有的 401、403、529 等特殊处理 ...

  // 【新增】在函数最后添加统一的自动禁用逻辑
  if (res.statusCode >= 400 && res.statusCode < 600) {
    await accountAutoDisableService.handleErrorResponse(
      accountId,
      accountType,
      res.statusCode,
      'Stream error',
      'https://api.anthropic.com/v1/messages',
      'request'
    ).catch(err => {
      logger.error('❌ Failed to auto-disable account in stream:', err)
    })
  }
}
```

#### 3.2 claudeConsoleRelayService.js

在非流式和流式请求的错误处理部分添加：

```javascript
if (response.statusCode >= 400 && response.statusCode < 600) {
  await accountAutoDisableService.handleErrorResponse(
    accountId,
    'claude-console',
    response.statusCode,
    this._extractErrorMessage(response.body),
    account.apiUrl,
    'request'
  )
}
```

#### 3.3 其他 RelayService

类似地在以下服务中添加自动禁用逻辑：
- `geminiRelayService.js`
- `bedrockRelayService.js`
- `azureOpenaiRelayService.js`
- `droidRelayService.js`
- `ccrRelayService.js`
- `openaiResponsesRelayService.js`

#### 3.4 测试连接集成

**testPayloadHelper.js** - 通用测试工具（约在 204 行）：

```javascript
// 在记录错误日志之后，添加自动禁用逻辑
logger.warn('❌ [Test Connection Error Response]', { ... })

// 【新增】调用自动禁用服务
if (response.status >= 400 && response.status < 600) {
  // 需要从外部参数传入 accountId 和 accountType
  if (options.accountId && options.accountType) {
    await accountAutoDisableService.handleErrorResponse(
      options.accountId,
      options.accountType,
      response.status,
      errorMsg,
      apiUrl,
      'test'
    ).catch(err => {
      logger.error('❌ Failed to auto-disable account in test:', err)
    })
  }
}
```

**修改调用方**：需要在调用 `sendStreamTestRequest()` 时传入 `accountId` 和 `accountType`。

**bedrockAccountService.js** - Bedrock 测试（约在 610 行）：

```javascript
catch (error) {
  // 现有的错误日志记录 ...

  // 【新增】AWS SDK 错误处理
  const statusCode = error.$metadata?.httpStatusCode || 500

  if (statusCode >= 400 && statusCode < 600) {
    await accountAutoDisableService.handleErrorResponse(
      accountId,
      'bedrock',
      statusCode,
      error.message,
      'AWS Bedrock API',
      'test'
    ).catch(err => {
      logger.error('❌ Failed to auto-disable Bedrock account:', err)
    })
  }

  // ... 现有的错误响应处理 ...
}
```

### 4. 自动恢复定时任务

#### 新建自动恢复服务

创建 `src/services/autoRecoveryService.js`：

```javascript
const logger = require('../utils/logger')
const redis = require('../models/redis')
const claudeAccountService = require('./claudeAccountService')
const claudeConsoleAccountService = require('./claudeConsoleAccountService')
const geminiAccountService = require('./geminiAccountService')
const bedrockAccountService = require('./bedrockAccountService')
// ... 其他账户服务 ...

class AutoRecoveryService {
  constructor() {
    this.isRunning = false
    this.intervalHandle = null
    this.testInterval = 60 * 60 * 1000  // 1 小时，可配置
    this.testTimeoutSeconds = 30  // 测试超时时间
  }

  /**
   * 启动自动恢复定时任务
   */
  start() {
    if (this.isRunning) {
      logger.warn('⚠️ [Auto Recovery] Service is already running')
      return
    }

    logger.info(`🔄 [Auto Recovery] Starting service, interval: ${this.testInterval / 1000 / 60} minutes`)
    this.isRunning = true

    // 立即执行一次
    this.runRecoveryCheck().catch(err => {
      logger.error('❌ [Auto Recovery] Initial check failed:', err)
    })

    // 设置定时任务
    this.intervalHandle = setInterval(() => {
      this.runRecoveryCheck().catch(err => {
        logger.error('❌ [Auto Recovery] Scheduled check failed:', err)
      })
    }, this.testInterval)
  }

  /**
   * 停止自动恢复定时任务
   */
  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
    this.isRunning = false
    logger.info('🛑 [Auto Recovery] Service stopped')
  }

  /**
   * 执行一次完整的恢复检查
   */
  async runRecoveryCheck() {
    const startTime = Date.now()
    logger.info('🔄 [Auto Recovery] Starting recovery check for all disabled accounts')

    const accountTypes = [
      'claude-official',
      'claude-console',
      'gemini',
      'bedrock',
      'azure-openai',
      'droid',
      'ccr',
      'openai-responses'
    ]

    let totalChecked = 0
    let totalRecovered = 0
    let totalFailed = 0

    // 逐个类型处理
    for (const accountType of accountTypes) {
      try {
        const result = await this.checkAccountType(accountType)
        totalChecked += result.checked
        totalRecovered += result.recovered
        totalFailed += result.failed
      } catch (error) {
        logger.error(`❌ [Auto Recovery] Error checking ${accountType}:`, error)
      }
    }

    const duration = Date.now() - startTime
    logger.info(
      `✅ [Auto Recovery] Check completed: ${totalChecked} checked, ${totalRecovered} recovered, ${totalFailed} failed, duration: ${duration}ms`
    )

    return { totalChecked, totalRecovered, totalFailed, duration }
  }

  /**
   * 检查特定类型的所有禁用账户
   */
  async checkAccountType(accountType) {
    const disabledAccountIds = await redis.smembers(`auto_disabled_accounts:${accountType}`)

    if (!disabledAccountIds || disabledAccountIds.length === 0) {
      return { checked: 0, recovered: 0, failed: 0 }
    }

    logger.info(`🔄 [Auto Recovery] Checking ${disabledAccountIds.length} ${accountType} accounts`)

    let recovered = 0
    let failed = 0

    for (const accountId of disabledAccountIds) {
      try {
        // 更新最后尝试时间
        await this._updateLastRecoveryAttempt(accountId, accountType)

        // 执行测试连接
        const testResult = await this._testAccountConnection(accountId, accountType)

        if (testResult.success) {
          // 测试成功，恢复账户
          await this._recoverAccount(accountId, accountType)
          recovered++
        } else {
          // 测试失败，保持禁用状态
          logger.debug(
            `❌ [Auto Recovery] Account ${accountId} (${accountType}) test failed: ${testResult.error}`
          )
          failed++
        }
      } catch (error) {
        logger.error(`❌ [Auto Recovery] Error checking account ${accountId} (${accountType}):`, error)
        failed++
      }
    }

    return { checked: disabledAccountIds.length, recovered, failed }
  }

  /**
   * 测试账户连接（内部测试，不发送 SSE）
   */
  async _testAccountConnection(accountId, accountType) {
    try {
      // 根据账户类型调用相应的测试方法
      switch (accountType) {
        case 'claude-official':
          return await this._testClaudeOfficial(accountId)
        case 'claude-console':
          return await this._testClaudeConsole(accountId)
        case 'gemini':
          return await this._testGemini(accountId)
        case 'bedrock':
          return await this._testBedrock(accountId)
        // ... 其他类型
        default:
          throw new Error(`Unsupported account type: ${accountType}`)
      }
    } catch (error) {
      return { success: false, error: error.message }
    }
  }

  /**
   * 测试 Claude 官方账户（复用现有测试逻辑但不返回 SSE）
   */
  async _testClaudeOfficial(accountId) {
    // 实现：调用 Claude API 发送最小测试请求
    // 返回 { success: true/false, error: '...' }
  }

  // ... 其他类型的测试方法 ...

  /**
   * 恢复账户可调度状态
   */
  async _recoverAccount(accountId, accountType) {
    logger.info(`✅ [Auto Recovery] Recovering account ${accountId} (${accountType})`)

    const updates = {
      schedulable: true,
      autoDisabledAt: null,
      autoDisabledReason: null,
      autoDisabledDetails: null,
      lastAutoRecoveryAttempt: new Date().toISOString(),
      autoRecoveredAt: new Date().toISOString()
    }

    // 根据账户类型更新
    await this._updateAccountByType(accountId, accountType, updates)

    // 从自动禁用索引中移除
    await redis.srem(`auto_disabled_accounts:${accountType}`, accountId)

    logger.info(`✅ [Auto Recovery] Account ${accountId} (${accountType}) has been recovered`)
  }

  /**
   * 更新最后恢复尝试时间
   */
  async _updateLastRecoveryAttempt(accountId, accountType) {
    const updates = {
      lastAutoRecoveryAttempt: new Date().toISOString()
    }
    await this._updateAccountByType(accountId, accountType, updates)
  }

  /**
   * 根据账户类型更新账户数据
   */
  async _updateAccountByType(accountId, accountType, updates) {
    switch (accountType) {
      case 'claude-official':
        await claudeAccountService.updateAccount(accountId, updates)
        break
      case 'claude-console':
        await claudeConsoleAccountService.updateAccount(accountId, updates)
        break
      // ... 其他类型
    }
  }
}

module.exports = new AutoRecoveryService()
```

#### 启动自动恢复服务

在 `server.js` 或主入口文件中启动：

```javascript
const autoRecoveryService = require('./services/autoRecoveryService')

// 服务启动后启动自动恢复任务
autoRecoveryService.start()

// 优雅关闭
process.on('SIGTERM', () => {
  logger.info('🛑 Received SIGTERM, shutting down gracefully')
  autoRecoveryService.stop()
  // ... 其他清理逻辑
})

process.on('SIGINT', () => {
  logger.info('🛑 Received SIGINT, shutting down gracefully')
  autoRecoveryService.stop()
  // ... 其他清理逻辑
})
```

### 5. Web 界面增强

#### 5.1 账户列表显示

在账户列表/详情页面显示自动禁用状态：

```javascript
// 前端显示逻辑
if (account.schedulable === false && account.autoDisabledAt) {
  // 显示状态标签
  status = '🔴 不可调度（自动禁用）'

  // 显示详细信息
  disabledReason = account.autoDisabledReason  // "HTTP 404: page not found"
  disabledTime = formatTime(account.autoDisabledAt)  // "2026-01-15 12:00:00"

  // 计算下次检测时间（禁用时间 + 1小时）
  nextCheck = formatTime(addHours(account.lastAutoRecoveryAttempt || account.autoDisabledAt, 1))
}
```

#### 5.2 手动恢复功能

**新增 API 端点**：

```javascript
// POST /admin/:accountType/:accountId/recover
router.post('/:accountType/:accountId/recover', authenticateAdmin, async (req, res) => {
  const { accountType, accountId } = req.params

  try {
    // 获取账户
    const account = await getAccountByType(accountId, accountType)

    // 更新为可调度
    const updates = {
      schedulable: true,
      autoDisabledAt: null,
      autoDisabledReason: null,
      autoDisabledDetails: null,
      manualRecoveredAt: new Date().toISOString(),
      manualRecoveredBy: req.admin.username
    }

    await updateAccountByType(accountId, accountType, updates)

    // 从自动禁用索引中移除
    await redis.srem(`auto_disabled_accounts:${accountType}`, accountId)

    logger.info(`✅ [Manual Recovery] Account ${accountId} (${accountType}) recovered by ${req.admin.username}`)

    res.json({ success: true, message: 'Account recovered successfully' })
  } catch (error) {
    logger.error('❌ [Manual Recovery] Failed:', error)
    res.status(500).json({ error: error.message })
  }
})
```

**前端按钮**：

在账户详情页面添加"手动恢复调度"按钮，条件显示：
- `schedulable === false`
- `autoDisabledAt !== null`

#### 5.3 系统监控页面

**新增 API 端点**：

```javascript
// GET /admin/auto-disabled-accounts - 获取所有自动禁用的账户
router.get('/auto-disabled-accounts', authenticateAdmin, async (req, res) => {
  const accountTypes = ['claude-official', 'claude-console', 'gemini', 'bedrock', ...]
  const result = []

  for (const type of accountTypes) {
    const ids = await redis.smembers(`auto_disabled_accounts:${type}`)
    for (const id of ids) {
      const account = await getAccountByType(id, type)
      result.push({
        id,
        type,
        name: account.name,
        autoDisabledAt: account.autoDisabledAt,
        autoDisabledReason: account.autoDisabledReason,
        lastAutoRecoveryAttempt: account.lastAutoRecoveryAttempt
      })
    }
  }

  res.json({ accounts: result, total: result.length })
})

// POST /admin/auto-recovery/trigger - 手动触发一次恢复检查
router.post('/auto-recovery/trigger', authenticateAdmin, async (req, res) => {
  try {
    const result = await autoRecoveryService.runRecoveryCheck()
    res.json({ success: true, ...result })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})
```

### 6. 配置选项

在 `config/config.js` 或环境变量中添加：

```javascript
module.exports = {
  // ... 现有配置 ...

  autoRecovery: {
    enabled: process.env.AUTO_RECOVERY_ENABLED !== 'false',  // 默认启用
    intervalMinutes: parseInt(process.env.AUTO_RECOVERY_INTERVAL_MINUTES || '60', 10),  // 检测间隔（分钟）
    testTimeoutSeconds: parseInt(process.env.AUTO_RECOVERY_TEST_TIMEOUT_SECONDS || '30', 10)  // 测试超时（秒）
  }
}
```

环境变量示例（`.env`）：

```bash
# 自动恢复配置
AUTO_RECOVERY_ENABLED=true          # 是否启用自动恢复
AUTO_RECOVERY_INTERVAL_MINUTES=60   # 检测间隔（分钟）
AUTO_RECOVERY_TEST_TIMEOUT_SECONDS=30  # 测试超时时间（秒）
```

### 7. 日志和监控

#### 日志分类

```javascript
// 自动禁用日志
logger.warn('🚫 [Auto Disable]', {
  accountId,
  accountType,
  statusCode,
  triggerType: 'request' | 'test',
  timestamp
})

// 自动恢复开始日志
logger.info('🔄 [Auto Recovery] Starting check', {
  accountCount,
  accountTypes
})

// 恢复成功日志
logger.info('✅ [Auto Recovery] Account recovered', {
  accountId,
  accountType,
  disabledDuration: '2 hours',
  timestamp
})

// 恢复失败日志
logger.debug('❌ [Auto Recovery] Test failed', {
  accountId,
  accountType,
  error,
  timestamp
})

// 手动恢复日志
logger.info('✅ [Manual Recovery]', {
  accountId,
  accountType,
  recoveredBy: 'admin_username',
  timestamp
})
```

## 实现优先级

### Phase 1: 核心功能（必须）

1. ✅ 创建 `accountAutoDisableService.js`
2. ✅ 在各 RelayService 中集成自动禁用逻辑
3. ✅ 在测试连接中集成自动禁用逻辑
4. ✅ 创建 `autoRecoveryService.js`
5. ✅ 在服务启动时启动自动恢复任务

### Phase 2: 管理功能（重要）

6. ✅ 新增手动恢复 API 端点
7. ✅ 前端账户列表显示自动禁用状态
8. ✅ 前端手动恢复按钮

### Phase 3: 监控功能（可选）

9. ⚪ 系统监控页面（显示所有自动禁用账户）
10. ⚪ 手动触发恢复检查的管理接口

## 数据迁移

对于现有被手动设置为 `schedulable: false` 的账户：
- 不受自动恢复影响（因为 `autoDisabledAt` 为空）
- 仅对新的自动禁用账户生效

## 测试计划

### 单元测试

- `accountAutoDisableService.handleErrorResponse()` 各种状态码
- `autoRecoveryService._testAccountConnection()` 成功/失败场景
- `autoRecoveryService._recoverAccount()` 数据更新正确性

### 集成测试

1. 模拟 404 错误 → 验证账户被禁用
2. 模拟 500 错误 → 验证账户被禁用
3. 模拟测试连接 4xx → 验证账户被禁用
4. 等待 1 小时 → 验证自动恢复任务执行
5. 手动触发恢复 → 验证立即恢复

### 性能测试

- 100 个禁用账户的恢复检查耗时
- 并发请求触发自动禁用的性能影响

## 风险和注意事项

### 风险 1: 误禁用

**风险**: 临时网络故障可能导致账户被误禁用。
**缓解**: 1 小时自动恢复，减少影响时长。

### 风险 2: 恢复测试频率

**风险**: 每小时测试所有禁用账户可能造成 API 压力。
**缓解**:
- 测试使用最小 payload
- 按账户类型分批处理
- 可配置测试间隔

### 风险 3: Redis 索引不一致

**风险**: 账户恢复后 Redis Set 未及时清理。
**缓解**:
- 恢复时同时清理 Redis Set
- 定期扫描清理孤立索引

### 风险 4: 测试逻辑复杂

**风险**: 不同账户类型的测试方法各不相同，实现复杂。
**缓解**:
- 复用现有测试逻辑
- 每种账户类型独立实现测试方法

## 后续优化方向

1. **分级恢复策略**: 连续失败多次后延长恢复间隔（指数退避）
2. **Webhook 通知**: 账户被禁用/恢复时发送通知
3. **统计报表**: 展示账户可用率、禁用频率等指标
4. **智能调度**: 优先选择恢复成功率高的账户

## 总结

本设计提供了一个完整的自动账户调度管理方案，能够：
- ✅ 自动识别并禁用有问题的账户（4xx/5xx 错误）
- ✅ 定期自动测试和恢复被禁用的账户
- ✅ 支持手动恢复和监控
- ✅ 详细记录禁用原因和恢复历史
- ✅ 适用于所有账户类型

通过这个机制，系统能够自动隔离故障账户，减少对正常请求的影响，同时在账户恢复正常后自动重新启用，最大化账户利用率。
