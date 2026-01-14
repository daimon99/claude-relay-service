# 账户优先级快捷调整功能设计文档

## 概述

在账户管理界面的优先级列中，为每个账户添加快捷调整按钮，允许用户直接通过 [+]/[−] 按钮增加或降低优先级。每次调整幅度为 10，页面按优先级数值排序（数值小的在前）。

## 设计方案：简单直接（方案A）

### 核心特性

- **立即保存**：点击按钮后立即发送API请求更新后端
- **自动排序**：更新成功后重新加载列表，触发自动排序
- **即时反馈**：显示loading状态，成功/失败有明确提示

---

## 第一部分：UI组件设计

### 优先级列布局结构

**当前显示：**
```
[进度条] 50
```

**修改后显示：**
```
[−] 50 [+]
```

### 组件层次

在 `AccountsView.vue` 的表格优先级单元格中（第531-542行区域）：

1. **替换现有内容**：移除或缩小进度条，改为按钮-数字-按钮横向布局
2. **添加两个按钮组件**：
   - **减少按钮 [−]**：圆形，深灰色图标，hover变蓝色
   - **增加按钮 [+]**：圆形，深灰色图标，hover变绿色
3. **优先级数字**：居中显示，加粗，字号稍大（便于识别）
4. **Loading状态**：请求进行中时，数字位置显示旋转的spinner图标

### 样式规范

- **按钮尺寸**：宽高 24px，圆形
- **图标**：使用 FontAwesome 的 `fa-minus`/`fa-plus`，大小 10px
- **间距**：按钮与数字间隔 8px
- **禁用状态**：opacity: 0.3，cursor: not-allowed，灰色
- **响应式**：移动端按钮增大到 32px，便于触摸

### 布局代码结构

```vue
<div class="flex items-center gap-2">
  <!-- 减少按钮 -->
  <button
    :disabled="isPriorityUpdating(account.id) || account.priority <= 1"
    @click="adjustPriority(account, -10)"
    class="priority-btn priority-btn-minus"
  >
    <i class="fas fa-minus" />
  </button>

  <!-- 优先级数字或Loading -->
  <span v-if="!isPriorityUpdating(account.id)" class="priority-value">
    {{ account.priority || 50 }}
  </span>
  <i v-else class="fas fa-spinner fa-spin text-gray-500" />

  <!-- 增加按钮 -->
  <button
    :disabled="isPriorityUpdating(account.id) || account.priority >= 100"
    @click="adjustPriority(account, +10)"
    class="priority-btn priority-btn-plus"
  >
    <i class="fas fa-plus" />
  </button>
</div>
```

---

## 第二部分：数据流和API集成

### API调用流程

**现有API端点：** `PUT /admin/claude-accounts/:id`（已支持priority字段）

**前端调用方法：**
```javascript
async function adjustPriority(account, delta) {
  // delta 是 +10 或 -10
  const currentPriority = account.priority || 50
  const newPriority = Math.max(1, Math.min(100, currentPriority + delta))

  // 添加到更新中的集合
  updatingPriorities.value.add(account.id)

  try {
    // 调用API（根据账户类型选择不同端点）
    const endpoint = getAccountUpdateEndpoint(account)
    await axios.put(`${endpoint}/${account.id}`, {
      priority: newPriority
    })

    // 刷新账户列表
    await loadAccounts()

    // 显示成功提示（可选）
    // showSuccessToast('优先级已更新')
  } catch (error) {
    showErrorToast(`更新优先级失败: ${error.message}`)
  } finally {
    // 移除更新中状态
    updatingPriorities.value.delete(account.id)
  }
}
```

### 支持的账户类型端点

根据账户的 `platform` 或 `type` 字段，调用不同的API端点：

- Claude官方：`PUT /admin/claude-accounts/:id`
- Claude Console：`PUT /admin/claude-console-accounts/:id`
- Gemini：`PUT /admin/gemini-accounts/:id`
- OpenAI Responses：`PUT /admin/openai-responses-accounts/:id`
- Bedrock：`PUT /admin/bedrock-accounts/:id`
- Azure OpenAI：`PUT /admin/azure-openai-accounts/:id`
- Droid：`PUT /admin/droid-accounts/:id`
- CCR：`PUT /admin/ccr-accounts/:id`

### 数据流转过程

1. **用户点击 [+] 按钮**
2. **前端处理**：
   - 计算新优先级 = (当前值 || 50) + 10
   - 边界检查（1-100范围）
   - 设置 loading 状态：`updatingPriorities.add(accountId)`
3. **发送API请求**：
   - PUT 对应的账户类型端点
   - Body: `{ priority: newPriority }`
4. **后端处理**：
   - 验证 priority 范围（1-100）
   - 更新 Redis 中的账户数据
   - 返回更新后的账户对象
5. **前端更新**：
   - 移除 loading 状态
   - 重新调用 `loadAccounts()` 获取完整列表
   - **自动触发排序**（如果当前按 priority 排序）

### 状态管理

在组件的 `<script setup>` 中添加：
```javascript
// 存储正在更新优先级的账户ID
const updatingPriorities = ref(new Set())

// 判断某账户是否正在更新
const isPriorityUpdating = (accountId) => {
  return updatingPriorities.value.has(accountId)
}
```

### 刷新策略

- **单账户更新**：只更新一个账户后，刷新整个列表（触发重新排序）
- **保持筛选状态**：刷新后保持当前的平台筛选、分组筛选、搜索关键词
- **保持排序设置**：如果用户已经选择"按优先级排序"，刷新后继续保持该排序

---

## 第三部分：错误处理和边界情况

### 边界值处理

**1. 优先级上限（100）**
- 当前优先级 ≥ 100 时，[+] 按钮禁用（视觉灰化，cursor: not-allowed）
- 计算公式：`newPriority = Math.min(100, current + 10)`
- 例如：90 → 100，100 → 100

**2. 优先级下限（1）**
- 当前优先级 ≤ 1 时，[−] 按钮禁用
- 计算公式：`newPriority = Math.max(1, current - 10)`
- 例如：5 → 1（不会变成负数）

**3. 默认值处理**
- 如果账户没有 priority 字段，显示默认值 50
- 首次点击时，从 50 开始计算：`const current = account.priority || 50`

### 按钮禁用逻辑

```javascript
// 减少按钮禁用条件
:disabled="isPriorityUpdating(account.id) || (account.priority || 50) <= 1"

// 增加按钮禁用条件
:disabled="isPriorityUpdating(account.id) || (account.priority || 50) >= 100"
```

### 错误场景处理

**1. 网络请求失败**
```javascript
catch (error) {
  showErrorToast(`更新优先级失败: ${error.message}`)
  // 保持原值，不改变显示
}
```

**2. 权限错误（401/403）**
- 显示提示："无权限修改账户优先级"
- 如果 token 过期，跳转到登录页

**3. 账户不存在（404）**
- 显示提示："账户已被删除"
- 自动刷新列表，移除该账户

**4. 并发冲突防护**
- 用户快速连续点击：第一次请求未完成时，禁用所有按钮
- 使用 `updatingPriorities` Set 追踪正在更新的账户
- 同一账户只能有一个优先级更新请求在进行

### 用户体验优化

**1. Loading 反馈**
- 点击按钮后，立即显示 spinner（替代数字显示）
- 两个按钮都禁用，防止重复点击
- 持续时间通常 < 500ms

**2. 成功反馈**
- 刷新列表后，如果排序改变，行会移动到新位置
- 可选：短暂高亮被修改的行（200ms绿色边框闪烁）

**3. 排序自动更新**
- 如果当前按 priority 排序（`accountsSortBy === 'priority'`），更新后行自动移动
- 如果按其他字段排序，行保持位置但数字更新
- 排序方向：优先级数值小的排在前面（升序，asc）

### 暗黑模式兼容

- 按钮基础样式：`bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-600`
- [−] hover: `hover:bg-blue-50 hover:border-blue-300 dark:hover:bg-blue-500/20 dark:hover:border-blue-400`
- [+] hover: `hover:bg-green-50 hover:border-green-300 dark:hover:bg-green-500/20 dark:hover:border-green-400`
- 禁用状态图标：`text-gray-400 dark:text-gray-600`
- Loading spinner：`text-gray-500 dark:text-gray-400`

---

## 实现清单

### 前端修改（AccountsView.vue）

**1. 数据状态添加**
```javascript
// 在 <script setup> 中添加
const updatingPriorities = ref(new Set())

const isPriorityUpdating = (accountId) => {
  return updatingPriorities.value.has(accountId)
}
```

**2. 优先级调整方法**
```javascript
const adjustPriority = async (account, delta) => {
  const currentPriority = account.priority || 50
  const newPriority = Math.max(1, Math.min(100, currentPriority + delta))

  updatingPriorities.value.add(account.id)

  try {
    const endpoint = getAccountUpdateEndpoint(account)
    await axios.put(`${endpoint}/${account.id}`, { priority: newPriority })
    await loadAccounts() // 刷新列表
  } catch (error) {
    showErrorToast(`更新优先级失败: ${error.message}`)
  } finally {
    updatingPriorities.value.delete(account.id)
  }
}

const getAccountUpdateEndpoint = (account) => {
  const platformMap = {
    'claude': '/admin/claude-accounts',
    'claude-console': '/admin/claude-console-accounts',
    'gemini': '/admin/gemini-accounts',
    'openai-responses': '/admin/openai-responses-accounts',
    'bedrock': '/admin/bedrock-accounts',
    'azure-openai': '/admin/azure-openai-accounts',
    'droid': '/admin/droid-accounts',
    'ccr': '/admin/ccr-accounts'
  }
  return platformMap[account.platform] || '/admin/claude-accounts'
}
```

**3. 模板修改（替换优先级列单元格内容）**

定位到第531-542行区域，替换为：
```vue
<td class="px-3 py-4">
  <div v-if="account.priority !== undefined" class="flex items-center justify-center gap-2">
    <!-- 减少按钮 -->
    <button
      :disabled="isPriorityUpdating(account.id) || (account.priority || 50) <= 1"
      @click.stop="adjustPriority(account, -10)"
      class="flex h-6 w-6 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-600 transition-all hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-30 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-blue-400 dark:hover:bg-blue-500/20 dark:hover:text-blue-400"
      title="降低优先级 (-10)"
    >
      <i class="fas fa-minus text-xs" />
    </button>

    <!-- 优先级数字或Loading -->
    <span
      v-if="!isPriorityUpdating(account.id)"
      class="min-w-[28px] text-center text-sm font-bold text-gray-700 dark:text-gray-200"
    >
      {{ account.priority || 50 }}
    </span>
    <i
      v-else
      class="fas fa-spinner fa-spin min-w-[28px] text-center text-gray-500 dark:text-gray-400"
    />

    <!-- 增加按钮 -->
    <button
      :disabled="isPriorityUpdating(account.id) || (account.priority || 50) >= 100"
      @click.stop="adjustPriority(account, +10)"
      class="flex h-6 w-6 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-600 transition-all hover:border-green-300 hover:bg-green-50 hover:text-green-600 disabled:cursor-not-allowed disabled:opacity-30 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-green-400 dark:hover:bg-green-500/20 dark:hover:text-green-400"
      title="提高优先级 (+10)"
    >
      <i class="fas fa-plus text-xs" />
    </button>
  </div>
  <div v-else class="text-center text-sm text-gray-400">
    <span class="text-xs">N/A</span>
  </div>
</td>
```

**4. 响应式样式调整**

添加移动端优化（在同一个按钮class中）：
```vue
class="... sm:h-6 sm:w-6 h-8 w-8 ..."
```

**5. Toast提示方法**

确保已有 `showErrorToast` 方法，如果没有则添加：
```javascript
const showErrorToast = (message) => {
  // 使用现有的 toast 系统，例如 element-plus 或自定义实现
  console.error(message)
  // ElMessage.error(message) // 如果使用 element-plus
}
```

### 后端验证

**确认所有账户类型的 PUT 端点都支持 priority 字段：**

已验证的端点（从路由文件确认）：
- ✅ `/admin/claude-accounts/:id` - 已支持（第667-678行）
- ✅ `/admin/claude-console-accounts/:id`
- ✅ `/admin/gemini-accounts/:id`
- ✅ `/admin/openai-responses-accounts/:id`
- ✅ `/admin/bedrock-accounts/:id`
- ✅ `/admin/azure-openai-accounts/:id`
- ✅ `/admin/droid-accounts/:id`
- ✅ `/admin/ccr-accounts/:id`

所有端点验证逻辑：priority 必须是 1-100 之间的数字。

### 排序默认设置（可选）

如果希望页面默认按优先级排序，修改初始排序配置：
```javascript
const accountsSortBy = ref('priority') // 从 'name' 改为 'priority'
const accountsSortOrder = ref('asc') // 升序：数值小的在前
```

---

## 实现注意事项

1. **代码格式化**：完成后运行 `npx prettier --write web/admin-spa/src/views/AccountsView.vue`
2. **暗黑模式测试**：在明亮/暗黑模式下都测试按钮样式和可见性
3. **响应式测试**：在移动端（375px）、平板（768px）、桌面（1920px）下测试布局
4. **防止事件冒泡**：按钮点击使用 `@click.stop` 防止触发行选择
5. **保持现有功能**：不影响列头点击排序、下拉菜单排序、筛选器等现有功能

---

## 未来优化方向（可选）

1. **平滑排序动画**：使用 `<TransitionGroup>` 实现行移动动画
2. **批量调整**：支持选中多个账户后批量调整优先级
3. **拖拽排序**：支持拖拽改变优先级顺序
4. **优先级预设**：提供快捷按钮（高/中/低优先级）
5. **撤销功能**：支持撤销最近一次优先级修改

---

## 总结

本设计采用方案A（简单直接），特点：
- ✅ 实现简单，改动最小
- ✅ 用户反馈即时，体验直观
- ✅ 立即保存，数据可靠
- ✅ 自动排序，符合预期
- ✅ 支持所有账户类型
- ✅ 完整的错误处理和边界保护
- ✅ 暗黑模式和响应式兼容

核心修改文件：`web/admin-spa/src/views/AccountsView.vue`

预计开发时间：2-4小时（包括测试和调试）
