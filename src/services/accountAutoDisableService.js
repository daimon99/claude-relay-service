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

    // 🔥 用户手动测试时：强制禁用，不检查白名单
    // 因为这是用户主动确认的测试结果，应该严格处理
    const forceDisable = triggerType === 'test'

    // 检查是否应该跳过自动禁用（白名单）
    // 但如果是用户手动测试，则忽略白名单
    if (!forceDisable) {
      const skipCheck = this._shouldSkipAutoDisable(errorMessage, statusCode, apiUrl)
      if (skipCheck.shouldSkip) {
        logger.info(
          `ℹ️ [Auto Disable] Skipping auto-disable for account ${accountId} (${accountType}) - ${skipCheck.reason}`,
          {
            accountId,
            accountType,
            statusCode,
            errorMessage: errorMessage.substring(0, 200),
            apiUrl,
            triggerType,
            skipReason: skipCheck.reason
          }
        )
        return { disabled: false, skipped: true, reason: skipCheck.reason }
      }
    } else {
      logger.info(
        `🔥 [Auto Disable] Force disable (user test) for account ${accountId} (${accountType}) - bypassing whitelist`,
        {
          accountId,
          accountType,
          statusCode,
          errorMessage: errorMessage.substring(0, 200),
          apiUrl,
          triggerType
        }
      )
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
   * 检查是否应该跳过自动禁用（白名单检测）
   * @param {string} errorMessage - 错误消息
   * @param {number} statusCode - HTTP 状态码
   * @param {string} apiUrl - 请求的 API URL
   * @returns {Object} { shouldSkip: boolean, reason: string }
   */
  _shouldSkipAutoDisable(errorMessage, statusCode, apiUrl) {
    // 优先级1：检查 HTTP 522 (连接超时)、HTTP 524 (超时) 和 HTTP 525 (SSL 握手失败)
    if (statusCode === 522) {
      return {
        shouldSkip: true,
        reason: '错误类型为 HTTP 522 (连接超时)，通常是临时网络问题，账户本身正常'
      }
    }

    if (statusCode === 524) {
      return {
        shouldSkip: true,
        reason: '错误类型为 HTTP 524 (超时)，通常是临时问题，账户本身正常'
      }
    }

    if (statusCode === 525) {
      return {
        shouldSkip: true,
        reason: '错误类型为 HTTP 525 (SSL握手失败)，通常是临时网络/证书问题，账户本身正常'
      }
    }

    // 检查是否包含 "连接AI服务失败" 或 "relay: 连接AI服务失败"
    if (errorMessage.includes('连接AI服务失败') || errorMessage.includes('relay: 连接AI服务失败')) {
      return {
        shouldSkip: true,
        reason: '错误类型为连接AI服务失败（临时网络问题，账户本身正常）'
      }
    }

    // 检查是否包含 "Forbidden"
    if (errorMessage.includes('Forbidden')) {
      return {
        shouldSkip: true,
        reason: '错误类型为 Forbidden（模型类型不支持等，账户本身正常）'
      }
    }

    // 检查是否包含 "model_not_found"
    if (errorMessage.includes('model_not_found')) {
      return {
        shouldSkip: true,
        reason: '错误类型为 model_not_found（模型渠道不可用，账户本身正常）'
      }
    }

    // 检查是否包含 "invalid_request_error"
    if (errorMessage.includes('invalid_request_error')) {
      return {
        shouldSkip: true,
        reason: '错误类型为 invalid_request_error（请求参数错误，账户本身正常）'
      }
    }

    // 检查是否包含 "未知模型" 或 "请检查模型名称是否正确"
    if (errorMessage.includes('未知模型') || errorMessage.includes('请检查模型名称是否正确')) {
      return {
        shouldSkip: true,
        reason: '错误类型为未知模型（模型名称错误，账户本身正常）'
      }
    }

    return { shouldSkip: false }
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
