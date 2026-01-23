/**
 * 定价数据管理路由
 */
const express = require('express')
const router = express.Router()
const pricingService = require('../../services/pricingService')
const logger = require('../../utils/logger')
const { authenticateAdmin } = require('../../middleware/auth')

// 获取所有定价数据
router.get('/pricing', authenticateAdmin, async (req, res) => {
  try {
    const pricingData = pricingService.getAllPricingData()
    res.json({
      success: true,
      data: pricingData
    })
  } catch (error) {
    logger.error('❌ Failed to get pricing data:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// 获取定价服务状态
router.get('/pricing/status', authenticateAdmin, async (req, res) => {
  try {
    const status = pricingService.getStatus()
    res.json({
      success: true,
      data: status
    })
  } catch (error) {
    logger.error('❌ Failed to get pricing status:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// 强制更新定价数据
router.post('/pricing/refresh', authenticateAdmin, async (req, res) => {
  try {
    const result = await pricingService.forceUpdate()
    res.json({
      success: result.success,
      message: result.message,
      data: result.success ? pricingService.getStatus() : null
    })
  } catch (error) {
    logger.error('❌ Failed to refresh pricing data:', error)
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

module.exports = router
