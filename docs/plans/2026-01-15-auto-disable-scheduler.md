# 自动账户调度禁用和恢复 - 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标**: 实现 4xx/5xx 错误自动禁用账户调度，每小时自动测试恢复

**架构**: 创建统一的自动禁用服务和自动恢复定时任务，集成到所有 RelayService 和测试连接中

**技术栈**: Node.js, Redis (Set 索引), 定时任务 (setInterval)

---

## Phase 1: 核心功能实现

### Task 1: 创建账户自动禁用服务

**Files:**
- Create: `src/services/accountAutoDisableService.js`

**Step 1: 创建基本服务结构**

```javascript
// src/services/accountAutoDisableService.js
const logger = require('../utils/logger')
const redis = require('../models/redis')
const claudeAccountService = require('./claudeAccountService')
const claudeConsoleAccountService = require('./claudeConsoleAccountService')
const geminiAccountService = require('./geminiAccountService')
const bedrockAccountService = require('./bedrockAccountService')
const azureOpenaiAccountService = require('./azureOpenaiAccountService')
const droidAccountService = require('./droidAccountService')
const ccrAccountService = require('./ccrAccountService')
const openaiResponsesAccountService = require('./openaiResponsesAccountService')

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

    logger.warn(
      `🚫 [Auto Disable] ${triggerType} - Account ${accountId} (${accountType}) encountered ${statusCode}, disabling`,
      {
        accountId,
        accountType,
        statusCode,
        errorMessage: errorMessage.substring(0, 200),
        apiUrl,
        triggerType
      }
    )

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

    try {
      // 根据账户类型更新账户数据
      await this._updateAccountByType(accountId, accountType, updates)

      // 添加到自动禁用索引
      await redis.sadd(`auto_disabled_accounts:${accountType}`, accountId)

      return { disabled: true, reason: updates.autoDisabledReason }
    } catch (error) {
      logger.error(`❌ [Auto Disable] Failed to disable account ${accountId}:`, error)
      return { disabled: false, error: error.message }
    }
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

**Step 2: 验证语法**

```bash
node -c src/services/accountAutoDisableService.js
```

Expected: 无输出（语法正确）

**Step 3: 格式化代码**

```bash
npx prettier --write src/services/accountAutoDisableService.js
```

**Step 4: 提交**

```bash
git add src/services/accountAutoDisableService.js
git commit -m "feat: add account auto-disable service

- Handle 4xx/5xx errors and disable account scheduling
- Support all account types
- Add Redis Set index for auto-disabled accounts

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 2: 集成到 Claude RelayService（非流式）

**Files:**
- Modify: `src/services/claudeRelayService.js:649-820`

**Step 1: 添加服务引用**

在 `src/services/claudeRelayService.js` 顶部添加：

```javascript
const accountAutoDisableService = require('./accountAutoDisableService')
```

**Step 2: 集成到非流式错误处理**

在 `claudeRelayService.js` 约 649 行，`if (response.statusCode !== 200 && response.statusCode !== 201)` 代码块的末尾添加：

```javascript
// 在所有现有错误处理之后，添加统一的自动禁用逻辑
if (response.statusCode >= 400 && response.statusCode < 600) {
  try {
    await accountAutoDisableService.handleErrorResponse(
      accountId,
      accountType,
      response.statusCode,
      this._extractErrorMessage(response.body),
      'https://api.anthropic.com/v1/messages',
      'request'
    )
  } catch (autoDisableError) {
    logger.error('❌ Failed to auto-disable account:', autoDisableError)
  }
}
```

**Step 3: 验证语法**

```bash
node -c src/services/claudeRelayService.js
```

**Step 4: 格式化代码**

```bash
npx prettier --write src/services/claudeRelayService.js
```

**Step 5: 提交**

```bash
git add src/services/claudeRelayService.js
git commit -m "feat: integrate auto-disable to Claude non-streaming requests

- Call accountAutoDisableService for 4xx/5xx errors
- Gracefully handle auto-disable failures

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 3: 集成到 Claude RelayService（流式）

**Files:**
- Modify: `src/services/claudeRelayService.js:1980-2040`

**Step 1: 集成到流式错误处理**

在 `claudeRelayService.js` 约 1980 行，`const handleErrorResponse = async () => {` 函数的末尾添加：

```javascript
// 在函数最后，所有现有错误处理之后
if (res.statusCode >= 400 && res.statusCode < 600) {
  accountAutoDisableService
    .handleErrorResponse(
      accountId,
      accountType,
      res.statusCode,
      'Stream error',
      'https://api.anthropic.com/v1/messages',
      'request'
    )
    .catch((err) => {
      logger.error('❌ Failed to auto-disable account in stream:', err)
    })
}
```

**Step 2: 验证语法**

```bash
node -c src/services/claudeRelayService.js
```

**Step 3: 格式化代码**

```bash
npx prettier --write src/services/claudeRelayService.js
```

**Step 4: 提交**

```bash
git add src/services/claudeRelayService.js
git commit -m "feat: integrate auto-disable to Claude streaming requests

- Call accountAutoDisableService for streaming 4xx/5xx errors
- Use non-blocking catch to avoid disrupting error response

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 4: 集成到 Claude Console RelayService

**Files:**
- Modify: `src/services/claudeConsoleRelayService.js`

**Step 1: 添加服务引用并查找错误处理位置**

```bash
# 查找错误处理位置
grep -n "statusCode !== 200" src/services/claudeConsoleRelayService.js | head -5
```

**Step 2: 在文件顶部添加引用**

```javascript
const accountAutoDisableService = require('./accountAutoDisableService')
```

**Step 3: 在非流式错误处理中集成**

找到类似 `if (response.statusCode !== 200)` 的错误处理代码块，在其末尾添加：

```javascript
// 自动禁用逻辑
if (response.statusCode >= 400 && response.statusCode < 600) {
  accountAutoDisableService
    .handleErrorResponse(
      accountId,
      'claude-console',
      response.statusCode,
      errorMessage || 'Unknown error',
      account?.apiUrl || 'Unknown URL',
      'request'
    )
    .catch((err) => {
      logger.error('❌ Failed to auto-disable Claude Console account:', err)
    })
}
```

**Step 4: 在流式错误处理中集成（如果有）**

类似地在流式错误处理代码中添加相同逻辑。

**Step 5: 验证和格式化**

```bash
node -c src/services/claudeConsoleRelayService.js
npx prettier --write src/services/claudeConsoleRelayService.js
```

**Step 6: 提交**

```bash
git add src/services/claudeConsoleRelayService.js
git commit -m "feat: integrate auto-disable to Claude Console relay service

- Handle 4xx/5xx errors in both streaming and non-streaming
- Use non-blocking error handling

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 5: 集成到测试连接（testPayloadHelper.js）

**Files:**
- Modify: `src/utils/testPayloadHelper.js:204-227`

**Step 1: 添加服务引用**

在 `src/utils/testPayloadHelper.js` 顶部添加：

```javascript
const accountAutoDisableService = require('../services/accountAutoDisableService')
```

**Step 2: 修改 sendStreamTestRequest 函数签名**

在函数参数中添加 `accountId` 和 `accountType`：

```javascript
async function sendStreamTestRequest(options) {
  const {
    apiUrl,
    authorization,
    responseStream,
    payload = createClaudeTestPayload('claude-sonnet-4-5-20250929', { stream: true }),
    proxyAgent = null,
    timeout = 30000,
    extraHeaders = {},
    accountId = null,  // 新增
    accountType = null  // 新增
  } = options
```

**Step 3: 在错误处理中集成自动禁用**

在约 204 行，记录错误日志之后添加：

```javascript
// 记录错误详情
logger.warn('❌ [Test Connection Error Response]', {
  type: 'Connection Test',
  apiUrl,
  statusCode: response.status,
  errorMessage: errorMsg,
  headers: relevantHeaders,
  bodyPreview,
  fullError: parsedError
})

// 【新增】调用自动禁用服务
if (response.status >= 400 && response.status < 600) {
  if (accountId && accountType) {
    accountAutoDisableService
      .handleErrorResponse(accountId, accountType, response.status, errorMsg, apiUrl, 'test')
      .catch((err) => {
        logger.error('❌ Failed to auto-disable account in test:', err)
      })
  }
}
```

**Step 4: 验证和格式化**

```bash
node -c src/utils/testPayloadHelper.js
npx prettier --write src/utils/testPayloadHelper.js
```

**Step 5: 提交**

```bash
git add src/utils/testPayloadHelper.js
git commit -m "feat: integrate auto-disable to test connection helper

- Accept accountId and accountType parameters
- Call auto-disable service for test failures

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 6: 更新测试连接调用方（Claude Console）

**Files:**
- Modify: `src/services/claudeConsoleRelayService.js:1408-1414`

**Step 1: 传递账户信息到测试函数**

找到调用 `sendStreamTestRequest` 的位置（约 1408 行），添加 `accountId` 和 `accountType` 参数：

```javascript
await sendStreamTestRequest({
  apiUrl,
  authorization: `Bearer ${account.apiKey}`,
  responseStream,
  proxyAgent: claudeConsoleAccountService._createProxyAgent(account.proxy),
  extraHeaders: account.userAgent ? { 'User-Agent': account.userAgent } : {},
  accountId,  // 新增
  accountType: 'claude-console'  // 新增
})
```

**Step 2: 验证和格式化**

```bash
node -c src/services/claudeConsoleRelayService.js
npx prettier --write src/services/claudeConsoleRelayService.js
```

**Step 3: 提交**

```bash
git add src/services/claudeConsoleRelayService.js
git commit -m "feat: pass account info to test connection helper

- Enable auto-disable for Claude Console test failures

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 7: 集成到 Bedrock 测试连接

**Files:**
- Modify: `src/services/bedrockAccountService.js:609-650`

**Step 1: 添加服务引用**

在 `src/services/bedrockAccountService.js` 顶部添加：

```javascript
const accountAutoDisableService = require('./accountAutoDisableService')
```

**Step 2: 在错误处理中集成**

在约 609 行，catch 块中的错误日志之后添加：

```javascript
} catch (error) {
  // 现有的错误日志记录
  const errorDetails = {
    // ... 现有代码 ...
  }

  logger.error(`❌ Test Bedrock account connection failed:`, errorDetails)

  // 【新增】自动禁用逻辑
  const statusCode = error.$metadata?.httpStatusCode || 500

  if (statusCode >= 400 && statusCode < 600) {
    accountAutoDisableService
      .handleErrorResponse(accountId, 'bedrock', statusCode, error.message, 'AWS Bedrock API', 'test')
      .catch((err) => {
        logger.error('❌ Failed to auto-disable Bedrock account:', err)
      })
  }

  // 发送错误事件给前端
  // ... 现有代码 ...
}
```

**Step 3: 验证和格式化**

```bash
node -c src/services/bedrockAccountService.js
npx prettier --write src/services/bedrockAccountService.js
```

**Step 4: 提交**

```bash
git add src/services/bedrockAccountService.js
git commit -m "feat: integrate auto-disable to Bedrock test connection

- Handle AWS SDK errors and auto-disable on 4xx/5xx

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 8: 创建自动恢复服务（基础结构）

**Files:**
- Create: `src/services/autoRecoveryService.js`

**Step 1: 创建服务基础结构**

```javascript
// src/services/autoRecoveryService.js
const logger = require('../utils/logger')
const redis = require('../models/redis')
const config = require('../../config/config')
const claudeAccountService = require('./claudeAccountService')
const claudeConsoleAccountService = require('./claudeConsoleAccountService')
const geminiAccountService = require('./geminiAccountService')
const bedrockAccountService = require('./bedrockAccountService')
const azureOpenaiAccountService = require('./azureOpenaiAccountService')
const droidAccountService = require('./droidAccountService')
const ccrAccountService = require('./ccrAccountService')
const openaiResponsesAccountService = require('./openaiResponsesAccountService')

class AutoRecoveryService {
  constructor() {
    this.isRunning = false
    this.intervalHandle = null
    // 从配置读取，默认 1 小时
    const intervalMinutes = config.autoRecovery?.intervalMinutes || 60
    this.testInterval = intervalMinutes * 60 * 1000
    this.testTimeoutSeconds = config.autoRecovery?.testTimeoutSeconds || 30
  }

  /**
   * 启动自动恢复定时任务
   */
  start() {
    if (this.isRunning) {
      logger.warn('⚠️ [Auto Recovery] Service is already running')
      return
    }

    if (config.autoRecovery?.enabled === false) {
      logger.info('⚠️ [Auto Recovery] Service is disabled in config')
      return
    }

    logger.info(
      `🔄 [Auto Recovery] Starting service, interval: ${this.testInterval / 1000 / 60} minutes`
    )
    this.isRunning = true

    // 立即执行一次
    this.runRecoveryCheck().catch((err) => {
      logger.error('❌ [Auto Recovery] Initial check failed:', err)
    })

    // 设置定时任务
    this.intervalHandle = setInterval(() => {
      this.runRecoveryCheck().catch((err) => {
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

        // 执行测试连接（暂时返回 false，后续实现）
        const testResult = { success: false, error: 'Not implemented yet' }

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

module.exports = new AutoRecoveryService()
```

**Step 2: 验证语法**

```bash
node -c src/services/autoRecoveryService.js
```

**Step 3: 格式化代码**

```bash
npx prettier --write src/services/autoRecoveryService.js
```

**Step 4: 提交**

```bash
git add src/services/autoRecoveryService.js
git commit -m "feat: add auto recovery service (basic structure)

- Periodic recovery check every 1 hour
- Support all account types
- Test connection not implemented yet (placeholder)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 9: 添加配置选项

**Files:**
- Modify: `config/config.js`

**Step 1: 添加自动恢复配置**

在 `config/config.js` 中添加：

```javascript
module.exports = {
  // ... 现有配置 ...

  // 自动恢复配置
  autoRecovery: {
    enabled: process.env.AUTO_RECOVERY_ENABLED !== 'false', // 默认启用
    intervalMinutes: parseInt(process.env.AUTO_RECOVERY_INTERVAL_MINUTES || '60', 10), // 检测间隔（分钟）
    testTimeoutSeconds: parseInt(process.env.AUTO_RECOVERY_TEST_TIMEOUT_SECONDS || '30', 10) // 测试超时（秒）
  }
}
```

**Step 2: 验证语法**

```bash
node -c config/config.js
```

**Step 3: 更新 .env.example**

在 `.env.example` 中添加：

```bash
# 自动恢复配置
AUTO_RECOVERY_ENABLED=true
AUTO_RECOVERY_INTERVAL_MINUTES=60
AUTO_RECOVERY_TEST_TIMEOUT_SECONDS=30
```

**Step 4: 提交**

```bash
git add config/config.js .env.example
git commit -m "feat: add auto recovery configuration options

- Add AUTO_RECOVERY_ENABLED flag
- Add AUTO_RECOVERY_INTERVAL_MINUTES (default 60)
- Add AUTO_RECOVERY_TEST_TIMEOUT_SECONDS (default 30)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 10: 启动自动恢复服务

**Files:**
- Modify: `server.js` 或 `src/server.js` 或主入口文件

**Step 1: 查找主入口文件**

```bash
# 查找主入口
ls -la server.js src/server.js src/app.js app.js 2>/dev/null | head -5
```

**Step 2: 添加服务引用和启动逻辑**

在主入口文件中添加：

```javascript
// 在文件顶部添加引用
const autoRecoveryService = require('./services/autoRecoveryService')
// 或 const autoRecoveryService = require('./src/services/autoRecoveryService')

// 在服务启动后添加（在 app.listen 或类似代码之后）
// 启动自动恢复服务
autoRecoveryService.start()

// 在优雅关闭逻辑中添加（如果没有则创建）
process.on('SIGTERM', () => {
  logger.info('🛑 Received SIGTERM, shutting down gracefully')
  autoRecoveryService.stop()
  // ... 其他清理逻辑
  process.exit(0)
})

process.on('SIGINT', () => {
  logger.info('🛑 Received SIGINT, shutting down gracefully')
  autoRecoveryService.stop()
  // ... 其他清理逻辑
  process.exit(0)
})
```

**Step 3: 验证语法**

```bash
node -c server.js
# 或
node -c src/server.js
```

**Step 4: 提交**

```bash
git add server.js
# 或 git add src/server.js
git commit -m "feat: start auto recovery service on startup

- Start service after server initialization
- Add graceful shutdown handlers (SIGTERM, SIGINT)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Phase 1 完成检查清单

- [x] Task 1: 创建 accountAutoDisableService
- [x] Task 2: 集成到 Claude 非流式
- [x] Task 3: 集成到 Claude 流式
- [x] Task 4: 集成到 Claude Console
- [x] Task 5: 集成到测试连接 helper
- [x] Task 6: 更新测试连接调用方
- [x] Task 7: 集成到 Bedrock 测试
- [x] Task 8: 创建 autoRecoveryService（基础）
- [x] Task 9: 添加配置选项
- [x] Task 10: 启动自动恢复服务

## Phase 1 测试验证

**手动测试步骤**:

1. 启动服务，确认自动恢复服务已启动
2. 模拟 404 错误，验证账户被禁用
3. 检查 Redis：`redis-cli SMEMBERS auto_disabled_accounts:claude-console`
4. 检查账户数据，确认 `schedulable: false` 和 `autoDisabledAt` 已设置
5. 等待 1 小时或手动触发恢复检查

---

## 后续任务（Phase 2 & 3）

### Phase 2: 管理功能

- Task 11: 实现自动恢复服务的测试连接逻辑
- Task 12: 新增手动恢复 API 端点
- Task 13: 前端显示自动禁用状态
- Task 14: 前端手动恢复按钮

### Phase 3: 监控功能

- Task 15: 系统监控页面
- Task 16: 手动触发恢复检查接口

---

## 注意事项

1. **兼容性**: 所有修改不影响现有手动设置的 `schedulable: false` 账户
2. **错误处理**: 所有自动禁用调用都使用 try-catch 或 .catch() 避免阻塞主流程
3. **日志记录**: 所有关键操作都有详细日志，便于调试和监控
4. **Redis 清理**: 恢复账户时必须同时清理 Redis Set 索引
5. **配置优先**: 通过环境变量可以禁用自动恢复功能

## 实施建议

- 按任务顺序逐个实现，每个任务都测试验证后再进行下一个
- 频繁提交，每个小功能点都提交一次
- 遇到问题立即修复，不要积累问题
- 保持代码风格一致，使用 Prettier 格式化
