#!/usr/bin/env node

/**
 * 测试 getAccount 方法返回的字段
 */

const claudeConsoleAccountService = require('../src/services/claudeConsoleAccountService')

const ACCOUNT_ID = '2381be85-ee26-4454-a898-0324d53e8ef2'

;(async () => {
  try {
    console.log('========================================')
    console.log('测试 getAccount 返回的字段')
    console.log('========================================')
    console.log(`账户 ID: ${ACCOUNT_ID}`)
    console.log('')

    const account = await claudeConsoleAccountService.getAccount(ACCOUNT_ID)

    if (!account) {
      console.log('❌ 账户不存在')
      process.exit(1)
    }

    console.log('✅ getAccount 返回的账户数据:')
    console.log('   schedulable:', account.schedulable)
    console.log('   autoDisabledAt:', account.autoDisabledAt || '(空)')
    console.log('   autoDisabledReason:', account.autoDisabledReason || '(空)')
    console.log('   autoDisabledDetails:', account.autoDisabledDetails || '(空)')
    console.log('   lastAutoRecoveryAttempt:', account.lastAutoRecoveryAttempt || '(空)')
    console.log('')

    console.log('所有字段:')
    console.log(Object.keys(account).sort())
    console.log('')

    if (account.autoDisabledAt) {
      console.log('✅ autoDisabledAt 字段存在于返回数据中')
    } else {
      console.log('❌ autoDisabledAt 字段不存在于返回数据中')
      console.log('   这说明 getAccount 没有返回该字段')
    }

    process.exit(0)
  } catch (error) {
    console.error('❌ 测试失败:', error)
    process.exit(1)
  }
})()
