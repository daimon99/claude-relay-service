const crypto = require('crypto')
const accountAutoDisableService = require('../services/accountAutoDisableService')

/**
 * 生成随机十六进制字符串
 * @param {number} bytes - 字节数
 * @returns {string} 十六进制字符串
 */
function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex')
}

/**
 * 生成 Claude Code 风格的会话字符串
 * @returns {string} 会话字符串，格式: user_{64位hex}_account__session_{uuid}
 */
function generateSessionString() {
  const hex64 = randomHex(32) // 32 bytes => 64 hex characters
  const uuid = crypto.randomUUID()
  return `user_${hex64}_account__session_${uuid}`
}

/**
 * 生成 Claude 测试请求体
 * @param {string} model - 模型名称
 * @param {object} options - 可选配置
 * @param {boolean} options.stream - 是否流式（默认false）
 * @param {string} options.prompt - 自定义提示词（默认 'hi'）
 * @param {number} options.maxTokens - 最大输出 token（默认 1000）
 * @returns {object} 测试请求体
 */
function createClaudeTestPayload(model = 'claude-sonnet-4-5-20250929', options = {}) {
  const { stream, prompt = 'hi', maxTokens = 1000 } = options
  const payload = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: prompt,
            cache_control: {
              type: 'ephemeral'
            }
          }
        ]
      }
    ],
    system: [
      {
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: {
          type: 'ephemeral'
        }
      }
    ],
    metadata: {
      user_id: generateSessionString()
    },
    max_tokens: maxTokens,
    temperature: 1
  }

  if (stream) {
    payload.stream = true
  }

  return payload
}

/**
 * 发送流式测试请求并处理SSE响应
 * @param {object} options - 配置选项
 * @param {string} options.apiUrl - API URL
 * @param {string} options.authorization - Authorization header值
 * @param {object} options.responseStream - Express响应流
 * @param {object} [options.payload] - 请求体（默认使用createClaudeTestPayload）
 * @param {object} [options.proxyAgent] - 代理agent
 * @param {number} [options.timeout] - 超时时间（默认30000）
 * @param {object} [options.extraHeaders] - 额外的请求头
 * @param {string} [options.accountId] - 账户ID（用于自动禁用）
 * @param {string} [options.accountType] - 账户类型（用于自动禁用）
 * @returns {Promise<void>}
 */
async function sendStreamTestRequest(options) {
  const axios = require('axios')
  const logger = require('./logger')

  const {
    apiUrl,
    authorization,
    responseStream,
    payload = createClaudeTestPayload('claude-sonnet-4-5-20250929', { stream: true }),
    proxyAgent = null,
    timeout = 30000,
    extraHeaders = {},
    accountId = null,
    accountType = null
  } = options

  const sendSSE = (type, data = {}) => {
    if (!responseStream.destroyed && !responseStream.writableEnded) {
      try {
        responseStream.write(`data: ${JSON.stringify({ type, ...data })}\n\n`)
      } catch {
        // ignore
      }
    }
  }

  const endTest = (success, error = null) => {
    if (!responseStream.destroyed && !responseStream.writableEnded) {
      try {
        responseStream.write(
          `data: ${JSON.stringify({ type: 'test_complete', success, error: error || undefined })}\n\n`
        )
        responseStream.end()
      } catch {
        // ignore
      }
    }
  }

  // 设置响应头
  if (!responseStream.headersSent) {
    responseStream.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
  }

  sendSSE('test_start', { message: 'Test started' })

  const requestConfig = {
    method: 'POST',
    url: apiUrl,
    data: payload,
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'User-Agent': 'claude-cli/2.0.52 (external, cli)',
      authorization,
      ...extraHeaders
    },
    timeout,
    responseType: 'stream',
    validateStatus: () => true
  }

  if (proxyAgent) {
    requestConfig.httpAgent = proxyAgent
    requestConfig.httpsAgent = proxyAgent
    requestConfig.proxy = false
  }

  try {
    const response = await axios(requestConfig)
    logger.debug(`🌊 Test response status: ${response.status}`)

    // 📝 记录测试请求的基本信息（无论成功失败）
    const relevantHeaders = {}
    const headerKeys = [
      'content-type',
      'anthropic-ratelimit-unified-reset',
      'anthropic-ratelimit-requests-remaining',
      'anthropic-ratelimit-requests-limit',
      'anthropic-ratelimit-tokens-remaining',
      'anthropic-ratelimit-tokens-limit',
      'retry-after',
      'x-should-retry'
    ]

    if (response.headers && typeof response.headers === 'object') {
      headerKeys.forEach((key) => {
        const value = response.headers[key]
        if (value !== undefined) {
          relevantHeaders[key] = value
        }
      })
    }

    // 处理非200响应
    if (response.status !== 200) {
      return new Promise((resolve) => {
        const chunks = []
        response.data.on('data', (chunk) => chunks.push(chunk))
        response.data.on('end', () => {
          const errorData = Buffer.concat(chunks).toString()

          // 提取错误消息
          let errorMsg = `API Error: ${response.status}`
          let parsedError = null
          try {
            const json = JSON.parse(errorData)
            parsedError = json
            errorMsg = json.message || json.error?.message || json.error || errorMsg
          } catch {
            if (errorData.length < 200) {
              errorMsg = errorData || errorMsg
            }
          }

          // 截断过长的响应体用于日志
          const bodyPreview =
            errorData.length > 1000 ? errorData.substring(0, 1000) + '...[truncated]' : errorData

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

          // 调用自动禁用服务
          if (response.status >= 400 && response.status < 600) {
            if (accountId && accountType) {
              accountAutoDisableService
                .handleErrorResponse(
                  accountId,
                  accountType,
                  response.status,
                  errorMsg,
                  apiUrl,
                  'test'
                )
                .catch((err) => {
                  logger.error('❌ Failed to auto-disable account in test:', err)
                })
            }
          }

          endTest(false, errorMsg)
          resolve()
        })
        response.data.on('error', (err) => {
          logger.error('❌ [Test Connection Stream Error]', {
            type: 'Connection Test',
            apiUrl,
            error: err.message
          })
          endTest(false, err.message)
          resolve()
        })
      })
    }

    // 处理成功的流式响应
    logger.info('✅ [Test Connection Success]', {
      type: 'Connection Test',
      apiUrl,
      statusCode: response.status,
      headers: relevantHeaders
    })

    return new Promise((resolve) => {
      let buffer = ''

      response.data.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data:')) {
            continue
          }
          const jsonStr = line.substring(5).trim()
          if (!jsonStr || jsonStr === '[DONE]') {
            continue
          }

          try {
            const data = JSON.parse(jsonStr)

            if (data.type === 'content_block_delta' && data.delta?.text) {
              sendSSE('content', { text: data.delta.text })
            }
            if (data.type === 'message_stop') {
              sendSSE('message_stop')
            }
            if (data.type === 'error' || data.error) {
              const errMsg = data.error?.message || data.message || data.error || 'Unknown error'
              sendSSE('error', { error: errMsg })
            }
          } catch {
            // ignore parse errors
          }
        }
      })

      response.data.on('end', () => {
        // 测试成功，尝试恢复账户（如果之前被自动禁用）
        if (accountId && accountType) {
          const autoRecoveryService = require('../services/autoRecoveryService')
          autoRecoveryService
            .recoverAccountFromTest(accountId, accountType)
            .then((result) => {
              if (result.recovered) {
                logger.info(
                  `✅ [Test Recovery] Account ${accountId} (${accountType}) recovered after successful test`
                )
              }
            })
            .catch((err) => {
              logger.error('❌ Failed to recover account after test success:', err)
            })
        }

        if (!responseStream.destroyed && !responseStream.writableEnded) {
          endTest(true)
        }
        resolve()
      })

      response.data.on('error', (err) => {
        endTest(false, err.message)
        resolve()
      })
    })
  } catch (error) {
    logger.error('❌ Stream test request failed:', error.message)
    endTest(false, error.message)
  }
}

/**
 * 生成 Gemini 测试请求体
 * @param {string} model - 模型名称
 * @param {object} options - 可选配置
 * @param {string} options.prompt - 自定义提示词（默认 'hi'）
 * @param {number} options.maxTokens - 最大输出 token（默认 100）
 * @returns {object} 测试请求体
 */
function createGeminiTestPayload(_model = 'gemini-2.5-pro', options = {}) {
  const { prompt = 'hi', maxTokens = 100 } = options
  return {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 1
    }
  }
}

/**
 * 生成 OpenAI Responses 测试请求体
 * @param {string} model - 模型名称
 * @param {object} options - 可选配置
 * @param {string} options.prompt - 自定义提示词（默认 'hi'）
 * @param {number} options.maxTokens - 最大输出 token（默认 100）
 * @returns {object} 测试请求体
 */
function createOpenAITestPayload(model = 'gpt-5', options = {}) {
  const { prompt = 'hi', maxTokens = 100 } = options
  return {
    model,
    input: [
      {
        role: 'user',
        content: prompt
      }
    ],
    max_output_tokens: maxTokens,
    stream: true
  }
}

module.exports = {
  randomHex,
  generateSessionString,
  createClaudeTestPayload,
  createGeminiTestPayload,
  createOpenAITestPayload,
  sendStreamTestRequest
}
