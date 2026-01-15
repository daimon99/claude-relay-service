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
    // 从配置读取,默认 1 小时
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

        // 执行测试连接
        const testResult = await this._testAccountConnection(accountId, accountType)

        if (testResult.success) {
          // 测试成功,恢复账户
          await this._recoverAccount(accountId, accountType)
          recovered++
        } else {
          // 测试失败,保持禁用状态
          logger.debug(
            `❌ [Auto Recovery] Account ${accountId} (${accountType}) test failed: ${testResult.error}`
          )
          failed++
        }
      } catch (error) {
        logger.error(
          `❌ [Auto Recovery] Error checking account ${accountId} (${accountType}):`,
          error
        )
        failed++
      }
    }

    return { checked: disabledAccountIds.length, recovered, failed }
  }

  /**
   * 测试账户连接
   */
  async _testAccountConnection(accountId, accountType) {
    try {
      let result

      switch (accountType) {
        case 'claude-console':
          result = await claudeConsoleAccountService.testAccountConnection(accountId)
          break
        case 'bedrock':
          result = await bedrockAccountService.testAccountConnection(accountId)
          break
        default:
          return { success: false, error: `Test not implemented for ${accountType}` }
      }

      return { success: result.success, error: result.error }
    } catch (error) {
      logger.error(
        `❌ [Auto Recovery] Test connection failed for ${accountId} (${accountType}):`,
        error
      )
      return { success: false, error: error.message }
    }
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
