#!/usr/bin/env node

/**
 * 费用数据修复脚本
 *
 * 用于修复因定价数据缺失导致的费用计算错误
 * 会从历史 token 使用数据重新计算费用，并更新 usage:cost:total
 *
 * 使用方法:
 *   node scripts/fix-cost-data.js                     # 检查所有 API Key（dry-run 模式）
 *   node scripts/fix-cost-data.js --fix               # 修复所有 API Key
 *   node scripts/fix-cost-data.js --key <keyId>       # 检查指定 API Key
 *   node scripts/fix-cost-data.js --key <keyId> --fix # 修复指定 API Key
 *   node scripts/fix-cost-data.js --name <keyName>    # 按名称查找并检查
 *   node scripts/fix-cost-data.js --name <keyName> --fix # 按名称查找并修复
 */

const redis = require('../src/models/redis')
const CostCalculator = require('../src/utils/costCalculator')
const logger = require('../src/utils/logger')

// 解析命令行参数
const args = process.argv.slice(2)
const dryRun = !args.includes('--fix')
const keyIdArg = args.includes('--key') ? args[args.indexOf('--key') + 1] : null
const keyNameArg = args.includes('--name') ? args[args.indexOf('--name') + 1] : null

const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheCreateTokens',
  'cacheReadTokens',
  'allTokens',
  'requests'
]

/**
 * 使用 SCAN 获取匹配的 keys
 */
async function scanKeys(client, pattern) {
  const allKeys = []
  let cursor = '0'

  do {
    const [newCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 500)
    cursor = newCursor
    allKeys.push(...keys)
  } while (cursor !== '0')

  return [...new Set(allKeys)] // 去重
}

/**
 * 按名称查找 API Key ID
 */
async function findKeyIdByName(client, name) {
  const keyIds = await scanKeys(client, 'apikey:*')
  const apiKeyIds = keyIds.map((k) => k.replace('apikey:', '')).filter((k) => k.length === 36) // UUID 格式

  for (const keyId of apiKeyIds) {
    const keyName = await client.hget(`apikey:${keyId}`, 'name')
    if (keyName && keyName.includes(name)) {
      console.log(`Found API Key: ${keyName} (${keyId})`)
      return keyId
    }
  }
  return null
}

/**
 * 计算单个 API Key 的正确费用
 */
async function calculateCorrectCost(client, apiKeyId) {
  // 获取所有模型使用数据（monthly 数据更完整，daily 有 30 天 TTL）
  const monthlyKeys = await scanKeys(client, `usage:${apiKeyId}:model:monthly:*:*`)
  const dailyKeys = await scanKeys(client, `usage:${apiKeyId}:model:daily:*:*`)

  // 如果有 monthly 数据，优先使用（避免重复计算）
  // 如果没有，用 daily 数据
  const useMonthly = monthlyKeys.length > 0
  const modelKeys = useMonthly ? monthlyKeys : dailyKeys

  if (modelKeys.length === 0) {
    return { totalCost: 0, details: [], source: 'no data' }
  }

  // 批量获取数据
  const pipeline = client.pipeline()
  for (const key of modelKeys) {
    pipeline.hgetall(key)
  }
  const results = await pipeline.exec()

  // 按模型汇总
  const modelUsageMap = new Map()
  const details = []

  for (let i = 0; i < results.length; i++) {
    const [err, data] = results[i]
    if (err || !data || Object.keys(data).length === 0) continue

    const key = modelKeys[i]
    // 解析模型名和时间
    const match = key.match(/usage:.+:model:(monthly|daily):(.+):(\d{4}-\d{2}(?:-\d{2})?)$/)
    if (!match) continue

    const [, period, model, dateStr] = match

    const usage = {
      input_tokens: parseInt(data.inputTokens) || 0,
      output_tokens: parseInt(data.outputTokens) || 0,
      cache_creation_input_tokens: parseInt(data.cacheCreateTokens) || 0,
      cache_read_input_tokens: parseInt(data.cacheReadTokens) || 0
    }

    const totalTokens =
      usage.input_tokens +
      usage.output_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens

    if (totalTokens === 0) continue

    // 使用 CostCalculator 计算费用（会回退到 unknown 价格）
    const costResult = CostCalculator.calculateCost(usage, model)
    const cost = costResult.costs.total

    // 汇总到模型
    if (!modelUsageMap.has(model)) {
      modelUsageMap.set(model, { usage: { ...usage }, cost: 0, requests: 0 })
    }
    const modelData = modelUsageMap.get(model)
    modelData.usage.input_tokens += usage.input_tokens
    modelData.usage.output_tokens += usage.output_tokens
    modelData.usage.cache_creation_input_tokens += usage.cache_creation_input_tokens
    modelData.usage.cache_read_input_tokens += usage.cache_read_input_tokens
    modelData.cost += cost
    modelData.requests += parseInt(data.requests) || 0

    details.push({
      key,
      model,
      dateStr,
      usage,
      cost,
      usingDynamicPricing: costResult.usingDynamicPricing
    })
  }

  // 计算总费用
  let totalCost = 0
  for (const [model, data] of modelUsageMap) {
    totalCost += data.cost
  }

  return {
    totalCost,
    modelUsageMap,
    details,
    source: useMonthly ? 'monthly' : 'daily'
  }
}

/**
 * 修复单个 API Key 的费用数据
 */
async function fixApiKeyCost(client, apiKeyId, dryRun = true) {
  // 获取 API Key 信息
  const keyName = await client.hget(`apikey:${apiKeyId}`, 'name')
  const isDeleted = await client.hget(`apikey:${apiKeyId}`, 'isDeleted')

  if (isDeleted === 'true') {
    console.log(`⏭️  Skipping deleted API Key: ${apiKeyId}`)
    return null
  }

  // 获取当前记录的总费用
  const currentTotalCost = parseFloat((await client.get(`usage:cost:total:${apiKeyId}`)) || '0')

  // 重新计算正确的费用
  const { totalCost: correctTotalCost, modelUsageMap, source } = await calculateCorrectCost(
    client,
    apiKeyId
  )

  const diff = correctTotalCost - currentTotalCost
  const diffPercent = currentTotalCost > 0 ? ((diff / currentTotalCost) * 100).toFixed(1) : 'N/A'

  // 只显示有差异的
  if (Math.abs(diff) > 0.01) {
    console.log(`\n📊 API Key: ${keyName || 'Unknown'} (${apiKeyId})`)
    console.log(`   Data source: ${source}`)
    console.log(`   Current total cost:  $${currentTotalCost.toFixed(6)}`)
    console.log(`   Calculated cost:     $${correctTotalCost.toFixed(6)}`)
    console.log(`   Difference:          $${diff.toFixed(6)} (${diffPercent}%)`)

    // 显示各模型的费用明细
    if (modelUsageMap && modelUsageMap.size > 0) {
      console.log(`   By model:`)
      for (const [model, data] of modelUsageMap) {
        console.log(
          `     - ${model}: $${data.cost.toFixed(4)} (${data.requests} reqs, ${(data.usage.input_tokens + data.usage.output_tokens + data.usage.cache_creation_input_tokens + data.usage.cache_read_input_tokens).toLocaleString()} tokens)`
        )
      }
    }

    if (!dryRun) {
      // 更新总费用
      await client.set(`usage:cost:total:${apiKeyId}`, correctTotalCost.toString())
      console.log(`   ✅ Fixed! Updated total cost to $${correctTotalCost.toFixed(6)}`)
    } else {
      console.log(`   ℹ️  Dry-run mode, no changes made. Use --fix to apply.`)
    }

    return { apiKeyId, keyName, currentTotalCost, correctTotalCost, diff }
  }

  return null
}

/**
 * 主函数
 */
async function main() {
  try {
    // 连接 Redis
    await redis.connect()
    const client = redis.getClientSafe()

    console.log('=' .repeat(60))
    console.log('💰 费用数据修复工具')
    console.log('=' .repeat(60))
    console.log(`Mode: ${dryRun ? 'DRY-RUN (检查模式)' : 'FIX (修复模式)'}`)

    let targetKeyIds = []

    if (keyIdArg) {
      // 指定 Key ID
      targetKeyIds = [keyIdArg]
      console.log(`Target: API Key ID ${keyIdArg}`)
    } else if (keyNameArg) {
      // 按名称查找
      console.log(`Searching for API Key with name containing: ${keyNameArg}`)
      const foundKeyId = await findKeyIdByName(client, keyNameArg)
      if (!foundKeyId) {
        console.error(`❌ No API Key found with name containing: ${keyNameArg}`)
        process.exit(1)
      }
      targetKeyIds = [foundKeyId]
    } else {
      // 所有 API Key
      console.log('Target: All API Keys')
      const allKeyIds = await scanKeys(client, 'apikey:*')
      targetKeyIds = allKeyIds.map((k) => k.replace('apikey:', '')).filter((k) => k.length === 36)
      console.log(`Found ${targetKeyIds.length} API Keys`)
    }

    console.log('=' .repeat(60))

    const fixedKeys = []

    for (const keyId of targetKeyIds) {
      const result = await fixApiKeyCost(client, keyId, dryRun)
      if (result) {
        fixedKeys.push(result)
      }
    }

    console.log('\n' + '=' .repeat(60))
    console.log('📊 Summary')
    console.log('=' .repeat(60))
    console.log(`Total API Keys checked: ${targetKeyIds.length}`)
    console.log(`Keys with cost discrepancy: ${fixedKeys.length}`)

    if (fixedKeys.length > 0) {
      const totalDiff = fixedKeys.reduce((sum, k) => sum + k.diff, 0)
      console.log(`Total cost difference: $${totalDiff.toFixed(6)}`)

      if (dryRun) {
        console.log('\n⚠️  This was a dry-run. Run with --fix to apply changes.')
      } else {
        console.log('\n✅ All cost data has been fixed!')
      }
    } else {
      console.log('\n✅ All cost data is correct, no fixes needed.')
    }

    process.exit(0)
  } catch (error) {
    console.error('❌ Error:', error)
    process.exit(1)
  }
}

main()
