#!/usr/bin/env node

/**
 * 测试脚本：验证 API 返回的账户数据是否包含自动禁用字段
 */

const claudeConsoleAccountService = require('../src/services/claudeConsoleAccountService')
const { formatAccountExpiry } = require('../src/routes/admin/utils')

const ACCOUNT_ID = '2381be85-ee26-4454-a898-0324d53e8ef2'

;(async () => {
  try {
    console.log('========================================')
    console.log('测试 API 返回的自动禁用字段')
    console.log('========================================')
    console.log(`账户 ID: ${ACCOUNT_ID}`)
    console.log('')

    // 1. 从服务获取账户数据
    console.log('1️⃣ 从 claudeConsoleAccountService 获取原始数据...')
    const account = await claudeConsoleAccountService.getAccount(ACCOUNT_ID)

    if (!account) {
      console.log('❌ 账户不存在')
      process.exit(1)
    }

    console.log('✅ 原始账户数据:')
    console.log('   schedulable:', account.schedulable)
    console.log('   autoDisabledAt:', account.autoDisabledAt || '(空)')
    console.log('   autoDisabledReason:', account.autoDisabledReason || '(空)')
    console.log('   autoDisabledDetails:', account.autoDisabledDetails ? '(有数据)' : '(空)')
    console.log('')

    // 2. 格式化数据（模拟 API 处理）
    console.log('2️⃣ 经过 formatAccountExpiry 格式化...')
    const formatted = formatAccountExpiry(account)

    console.log('✅ 格式化后的数据（API 会返回这个）:')
    console.log('   schedulable:', formatted.schedulable)
    console.log('   autoDisabledAt:', formatted.autoDisabledAt || '(空)')
    console.log('   autoDisabledReason:', formatted.autoDisabledReason || '(空)')
    console.log('   autoDisabledDetails:', formatted.autoDisabledDetails ? '(有数据)' : '(空)')
    console.log('')

    // 3. 模拟 API 路由的完整处理
    console.log('3️⃣ 模拟 API 路由完整处理（包含 schedulable 转换）...')
    const apiResponse = {
      ...formatted,
      // 转换schedulable为布尔值（API路由会这样做）
      schedulable: account.schedulable === 'true' || account.schedulable === true
    }

    console.log('✅ API 最终返回的数据:')
    console.log('   schedulable:', apiResponse.schedulable, `(类型: ${typeof apiResponse.schedulable})`)
    console.log('   autoDisabledAt:', apiResponse.autoDisabledAt || '(空)')
    console.log('   autoDisabledReason:', apiResponse.autoDisabledReason || '(空)')
    console.log('   autoDisabledDetails:', apiResponse.autoDisabledDetails ? '(有数据)' : '(空)')
    console.log('')

    // 4. 判断前端应该显示什么
    console.log('4️⃣ 前端判断逻辑:')
    if (apiResponse.schedulable !== false) {
      console.log('   ✅ schedulable !== false，前端会显示为"可调度"')
    } else {
      console.log('   ❌ schedulable === false，前端会显示为"不可调度"')

      if (apiResponse.autoDisabledAt) {
        console.log('   🤖 有 autoDisabledAt 字段，应该显示为"自动禁用"（琥珀色）')
        console.log(`      禁用时间: ${apiResponse.autoDisabledAt}`)
        console.log(`      禁用原因: ${apiResponse.autoDisabledReason}`)
      } else {
        console.log('   ⏸  没有 autoDisabledAt 字段，应该显示为"不可调度"（灰色）')
      }
    }
    console.log('')

    console.log('========================================')
    console.log('✅ 测试完成')
    console.log('========================================')
    process.exit(0)
  } catch (error) {
    console.error('❌ 测试失败:', error)
    process.exit(1)
  }
})()
