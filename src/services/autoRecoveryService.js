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
  // 已禁用：自动禁用机制已关闭，不再需要自动恢复
  start() {
    logger.info('ℹ️ [Auto Recovery] Service is disabled (auto-disable feature removed)')
    return
  }

  /**
   * 清理所有数据不一致的账户（启动时调用）
   */
  async cleanupInconsistentData() {
    logger.info('🧹 [Auto Recovery] Starting data consistency cleanup...')

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

    let totalCleaned = 0

    for (const accountType of accountTypes) {
      try {
        const disabledAccountIds = await redis.smembers(`auto_disabled_accounts:${accountType}`)

        if (!disabledAccountIds || disabledAccountIds.length === 0) {
          continue
        }

        logger.info(
          `🔍 [Auto Recovery] Checking ${disabledAccountIds.length} ${accountType} accounts for data consistency`
        )

        for (const accountId of disabledAccountIds) {
          try {
            const isValid = await this._validateAccountData(accountId, accountType)

            if (!isValid) {
              await this._cleanupInconsistentAccount(accountId, accountType)
              totalCleaned++
            }
          } catch (error) {
            logger.error(
              `❌ [Auto Recovery] Error cleaning account ${accountId} (${accountType}):`,
              error
            )
          }
        }
      } catch (error) {
        logger.error(`❌ [Auto Recovery] Error cleaning ${accountType}:`, error)
      }
    }

    if (totalCleaned > 0) {
      logger.info(`✅ [Auto Recovery] Cleaned ${totalCleaned} inconsistent accounts`)
    } else {
      logger.info('✅ [Auto Recovery] No inconsistent data found')
    }

    return { totalCleaned }
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
    let totalCleaned = 0

    // 逐个类型处理
    for (const accountType of accountTypes) {
      try {
        const result = await this.checkAccountType(accountType)
        totalChecked += result.checked
        totalRecovered += result.recovered
        totalFailed += result.failed
        totalCleaned += result.cleaned
      } catch (error) {
        logger.error(`❌ [Auto Recovery] Error checking ${accountType}:`, error)
      }
    }

    const duration = Date.now() - startTime
    let logMessage = `✅ [Auto Recovery] Check completed: ${totalChecked} checked, ${totalRecovered} recovered, ${totalFailed} failed`
    if (totalCleaned > 0) {
      logMessage += `, ${totalCleaned} cleaned (data inconsistency)`
    }
    logMessage += `, duration: ${duration}ms`
    logger.info(logMessage)

    return { totalChecked, totalRecovered, totalFailed, totalCleaned, duration }
  }

  /**
   * 检查特定类型的所有禁用账户
   */
  async checkAccountType(accountType) {
    const disabledAccountIds = await redis.smembers(`auto_disabled_accounts:${accountType}`)

    if (!disabledAccountIds || disabledAccountIds.length === 0) {
      return { checked: 0, recovered: 0, failed: 0, cleaned: 0 }
    }

    logger.info(`🔄 [Auto Recovery] Checking ${disabledAccountIds.length} ${accountType} accounts`)

    let recovered = 0
    let failed = 0
    let cleaned = 0

    for (const accountId of disabledAccountIds) {
      try {
        // 先验证数据完整性
        const isValid = await this._validateAccountData(accountId, accountType)

        if (!isValid) {
          // 数据不一致，自动清理
          await this._cleanupInconsistentAccount(accountId, accountType)
          cleaned++
          continue
        }

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

    return { checked: disabledAccountIds.length, recovered, failed, cleaned }
  }

  /**
   * 验证账户数据完整性
   */
  async _validateAccountData(accountId, accountType) {
    try {
      const account = await this._getAccountByType(accountId, accountType)

      if (!account) {
        logger.warn(
          `⚠️ [Auto Recovery] Account ${accountId} (${accountType}) not found, will clean up`
        )
        return false
      }

      // 检查必要的自动禁用字段
      if (!account.autoDisabledAt || !account.autoDisabledReason) {
        logger.warn(
          `⚠️ [Auto Recovery] Account ${accountId} (${accountType}) missing required fields (autoDisabledAt: ${!!account.autoDisabledAt}, autoDisabledReason: ${!!account.autoDisabledReason}), will clean up`
        )
        return false
      }

      return true
    } catch (error) {
      logger.error(
        `❌ [Auto Recovery] Error validating account ${accountId} (${accountType}):`,
        error
      )
      return false
    }
  }

  /**
   * 清理数据不一致的账户
   */
  async _cleanupInconsistentAccount(accountId, accountType) {
    logger.info(`🧹 [Auto Recovery] Cleaning up inconsistent account ${accountId} (${accountType})`)

    try {
      // 从自动禁用索引中移除
      await redis.srem(`auto_disabled_accounts:${accountType}`, accountId)

      logger.info(
        `✅ [Auto Recovery] Removed inconsistent account ${accountId} (${accountType}) from auto-disabled index`
      )
    } catch (error) {
      logger.error(
        `❌ [Auto Recovery] Failed to cleanup inconsistent account ${accountId} (${accountType}):`,
        error
      )
    }
  }

  /**
   * 根据账户类型获取账户数据
   */
  async _getAccountByType(accountId, accountType) {
    switch (accountType) {
      case 'claude-official':
        return await claudeAccountService.getAccount(accountId)
      case 'claude-console':
        return await claudeConsoleAccountService.getAccount(accountId)
      case 'gemini':
        return await geminiAccountService.getAccount(accountId)
      case 'bedrock':
        return await bedrockAccountService.getAccount(accountId)
      case 'azure-openai':
        return await azureOpenaiAccountService.getAccount(accountId)
      case 'droid':
        return await droidAccountService.getAccount(accountId)
      case 'ccr':
        return await ccrAccountService.getAccount(accountId)
      case 'openai-responses':
        return await openaiResponsesAccountService.getAccount(accountId)
      default:
        throw new Error(`Unknown account type: ${accountType}`)
    }
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
  /**
   * 从自动禁用状态恢复账户（手动测试成功后调用）
   * @param {string} accountId - 账户 ID
   * @param {string} accountType - 账户类型
   * @returns {Promise<Object>} { recovered: boolean, reason: string }
   */
  async recoverAccountFromTest(accountId, accountType) {
    try {
      // 检查账户是否在自动禁用索引中
      const isAutoDisabled = await redis.sIsMember(
        `auto_disabled_accounts:${accountType}`,
        accountId
      )

      if (!isAutoDisabled) {
        logger.debug(
          `[Auto Recovery] Account ${accountId} (${accountType}) is not in auto-disabled index, skipping recovery`
        )
        return { recovered: false, reason: 'not_auto_disabled' }
      }

      // 恢复账户
      await this._recoverAccount(accountId, accountType)

      logger.info(
        `✅ [Manual Recovery] Account ${accountId} (${accountType}) recovered from test connection success`
      )

      return { recovered: true, reason: 'test_success' }
    } catch (error) {
      logger.error(`❌ [Manual Recovery] Failed to recover account ${accountId}:`, error)
      return { recovered: false, reason: 'error', error: error.message }
    }
  }

  /**
   * 恢复账户（内部方法）
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
