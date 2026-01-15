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
   * @param {string} triggerType - 触���类型："request" 或 "test"
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
