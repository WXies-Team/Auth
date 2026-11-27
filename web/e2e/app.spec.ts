import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const session = {
  uid: 1,
  email: 'hs@horatio.cn',
  role: 'super',
  csrfToken: 'demo',
  totpEnabled: true,
  passkeyCount: 1,
  passwordSet: true,
  isRoot: true,
}

const profile = { nickname: 'Horatio', avatarColor: 0, avatarImage: null, updatedAt: 0, loginNotify: true }
const sessions = {
  sessions: [
    {
      id: '1',
      app: 'web',
      device: 'MacBook Pro · Chrome',
      ip: '114.114.114.114',
      ipRegion: '江苏 南京',
      createdAt: 1764000000000,
      lastSeenAt: 1764100000000,
      current: true,
    },
  ],
}

async function mockApi(page: Page, signedIn = true) {
  await page.route('**/web/session', (route) =>
    signedIn ? route.fulfill({ json: session }) : route.fulfill({ status: 401, json: { message: '未登录' } }),
  )
  await page.route('**/api/sessions', (route) => route.fulfill({ json: sessions }))
  await page.route('**/api/passkeys', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/totp', (route) =>
    route.fulfill({ json: { enabled: true, createdAt: 1762000000000, recoveryTotal: 10, recoveryLeft: 7 } }),
  )
  await page.route('**/api/profile', (route) => route.fulfill({ json: profile }))
  await page.route('**/api/connected-apps', (route) =>
    route.fulfill({
      json: [
        {
          app: 'CalorieDiary',
          name: '热量日记',
          scopes: ['uid', 'email'],
          createdAt: 1763000000000,
          lastUsedAt: 1764100000000,
        },
      ],
    }),
  )
  await page.route('**/api/security-log**', (route) => route.fulfill({ json: { items: [], total: 0 } }))
  await page.route('**/admin/users/invites**', (route) => route.fulfill({ json: { invites: [] } }))
  await page.route('**/admin/users**', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            uid: 1,
            email: 'hs@horatio.cn',
            role: 'super',
            createdAt: 1760000000000,
            totpEnabled: true,
            passkeyCount: 1,
            scopeCount: 0,
            nickname: 'Horatio',
            avatarColor: 0,
            hasAvatar: false,
            isRoot: true,
          },
        ],
        total: 1,
      },
    }),
  )
}

async function noSeriousA11y(page: Page) {
  const result = await new AxeBuilder({ page }).analyze()
  const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(bad, bad.map((v) => `${v.id}: ${v.help}`).join('\n')).toEqual([])
}

test('登录页可渲染且无严重无障碍问题', async ({ page }) => {
  await mockApi(page, false)
  await page.goto('/web/login')
  await expect(page.getByRole('heading', { name: '登录 Auth' })).toBeVisible()
  await noSeriousA11y(page)
})

test('邮箱验证码输入：单输入框分格展示且无严重无障碍问题', async ({ page }) => {
  await mockApi(page, false)
  await page.goto('/web/login')
  await page.getByRole('tab', { name: '邮箱验证码' }).click()
  const otp = page.getByRole('textbox', { name: '验证码' })
  // 视觉上是六格，但真实控件只有一个 —— 粘贴/一次性验证码自动填充/读屏都只面对一个 input。
  await expect(otp).toHaveCount(1)
  await otp.click()
  await otp.fill('123456')
  await expect(otp).toHaveValue('123456')
  await noSeriousA11y(page)
})

test('控制台展示安全评分与最近登录', async ({ page }) => {
  await mockApi(page)
  await page.goto('/web/console')
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible()
  await expect(page.getByText('账号安全')).toBeVisible()
  await expect(page.getByText('MacBook Pro · Chrome')).toBeVisible()
  await noSeriousA11y(page)
})

test('管理员未绑定 MFA 时展示绑定引导而不是空表', async ({ page }) => {
  await mockApi(page, true)
  await page.route('**/web/session', (route) =>
    route.fulfill({ json: { ...session, totpEnabled: false, passkeyCount: 0 } }),
  )
  // 登录后先在控制台看到常驻提醒（Google Workspace 式「登录即提醒」），
  // 而不是点进后台才发现被拦。
  await page.goto('/web/console')
  await expect(page.getByText(/管理后台暂不可用/)).toBeVisible()
  await expect(page.getByRole('link', { name: '去绑定' })).toHaveAttribute('href', '/web/console/security')
  await expect(page.getByText('待绑定 MFA')).toBeVisible()

  await page.goto('/web/admin')
  await expect(page.getByText('管理后台需要两步验证', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: /去绑定两步验证/ })).toHaveAttribute('href', '/web/console/security')
})

test('切换控制台页面外壳保持，导航不出现第二套骨架', async ({ page }) => {
  await mockApi(page, true)
  await page.goto('/web/console')
  await expect(page.getByRole('link', { name: '概览' })).toBeVisible()
  await page.getByRole('link', { name: '登录会话' }).click()
  // 页面模块已随主包加载，导航不再经过 chunk 兜底：外壳与标题立即可见。
  await expect(page.getByRole('heading', { name: '登录会话' })).toBeVisible()
  await expect(page.getByRole('link', { name: '概览' })).toBeVisible()
  await expect(page.getByRole('main')).toBeVisible()
})

test('用户列表可搜索并打开详情入口', async ({ page }) => {
  await mockApi(page)
  await page.goto('/web/admin')
  await expect(page.getByRole('heading', { name: '用户' })).toBeVisible()
  await expect(page.getByText('hs@horatio.cn')).toBeVisible()
  await expect(page.getByRole('link', { name: '详情' })).toBeVisible()
  await noSeriousA11y(page)
})

test('配置中心用类型化控件，项目级策略在项目访问页', async ({ page }) => {
  await mockApi(page, true)
  await page.route((url) => url.pathname === '/admin/config', (route) =>
    route.fulfill({
      json: [
        { key: 'allow_self_register', secret: false, configured: false, value: '', hint: '' },
        { key: 'audit_retention_days', secret: false, configured: true, value: '90' },
        { key: 'llm_base_url', secret: false, configured: true, value: 'https://llm.example.com/v1/chat/completions' },
        { key: 'llm_model', secret: false, configured: true, value: 'gpt-x' },
        { key: 'llm_api_key', secret: true, configured: true, value: '', hint: 'abcd' },
        { key: 'password_breach_check', secret: false, configured: true, value: '0' },
        { key: 'ai_concurrency_global', secret: false, configured: true, value: '80' },
        { key: 'push_admin_token', secret: true, configured: true, value: '', hint: '9xyz' },
      ],
    }),
  )
  await page.route((url) => url.pathname === '/admin/projects', (route) =>
    route.fulfill({
      json: { projects: [
        {
          app: 'CalorieDiary',
          name: '热量日记',
          restricted: false,
          mfaRequired: true,
          allowedDomains: [],
          sessionDays: 30,
          legacyUpgrade: false,
          members: [],
          admins: [],
          clientId: '',
          redirectUris: null,
        },
      ] },
    }),
  )

  await page.goto('/web/admin/config')
  // 配置按频率分三档：常规 / 集成 / 高级。
  for (const section of ['常规', '集成', '高级']) {
    await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible()
  }
  // 未配置的开关显示实际默认值，并用「默认值」徽标与显式设置区分。
  await expect(page.getByText('默认关闭', { exact: true })).toBeVisible()
  await expect(page.getByText('默认值', { exact: true }).first()).toBeVisible()
  // 项目级开关已从全局配置中心移除，避免与项目访问页重复。
  await expect(page.getByText('强制 2FA 项目')).toHaveCount(0)
  // 显式关闭的布尔开关必须如实显示「已关闭」，不能因名字含 password 被当凭据掩码。
  await expect(page.getByText('已关闭', { exact: true })).toBeVisible()
  // 布尔项直接拨开关（没有编辑弹窗）：先把关闭的开关拨开，确认写的是 1。
  const breachSwitch = page.getByRole('switch', { name: '密码泄露库校验开关' })
  await expect(breachSwitch).not.toBeChecked()
  let savedBool: string | null = null
  await page.route((url) => url.pathname === '/admin/config/password_breach_check', async (route) => {
    if (route.request().method() === 'PUT') {
      savedBool = (route.request().postDataJSON() as { value: string }).value
    }
    await route.fulfill({ json: { ok: true, hotWithinSeconds: 10 } })
  })
  await breachSwitch.click()
  await expect.poll(() => savedBool).toBe('1')
  // 全站并发与推送令牌都是可运营的键，不能只在库里改。
  await expect(page.getByText('全站并发', { exact: true })).toBeVisible()
  await expect(page.getByText('推送管理令牌', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '编辑 审计保留天数' }).click()
  const num = page.getByRole('dialog').locator('#cfg-value')
  await expect(num).toHaveAttribute('type', 'number')
  await expect(num).toHaveAttribute('min', '7')
  await expect(num).toHaveAttribute('max', '365')
  await page.keyboard.press('Escape')

  // 未设置的布尔项同样直接出开关，按默认值展示（默认关闭）。
  await expect(page.getByRole('switch', { name: '开放自助注册开关' })).not.toBeChecked()
  // 布尔项不应再有编辑按钮。
  await expect(page.getByRole('button', { name: '编辑 开放自助注册' })).toHaveCount(0)

  // LLM 大模型三键必须回到配置中心：地址 / 模型 / 密钥（密钥只回末 4 位）。
  await expect(page.getByText('LLM 大模型')).toBeVisible()
  await expect(page.getByText('接口地址', { exact: true })).toBeVisible()
  await expect(page.getByText('gpt-x')).toBeVisible()
  await expect(page.getByText('末 4 位 abcd', { exact: true })).toBeVisible()

  let savedLLM: string | null = null
  await page.route((url) => url.pathname === '/admin/config/llm_base_url', async (route) => {
    if (route.request().method() === 'PUT') {
      savedLLM = (route.request().postDataJSON() as { value: string }).value
    }
    await route.fulfill({ json: {} })
  })
  await page.getByRole('button', { name: '编辑 接口地址' }).click()
  const urlInput = page.getByRole('dialog').locator('#cfg-value')
  await expect(urlInput).toHaveValue('https://llm.example.com/v1/chat/completions')
  await urlInput.fill('ftp://llm.example.com/v1')
  await page.getByRole('dialog').getByRole('button', { name: '保存' }).click()
  // 非 http(s) 就地拦下，不发请求也不关弹窗。
  expect(savedLLM).toBeNull()
  await expect(page.getByRole('dialog')).toBeVisible()
  await urlInput.fill('https://llm.example.com/v1')
  await page.getByRole('dialog').getByRole('button', { name: '保存' }).click()
  await expect.poll(() => savedLLM).toBe('https://llm.example.com/v1')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // 项目策略（要求 MFA / 旧客户端升级）归项目访问页，一个项目一组开关。
  await page.goto('/web/admin/access')
  await expect(page.getByText('要求 MFA')).toBeVisible()
  await page.getByRole('button', { name: '配置' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('switch', { name: /要求两步验证/ })).toBeChecked()
  await expect(dialog.getByRole('switch', { name: /旧版客户端强制升级/ })).not.toBeChecked()
  await expect(dialog.getByRole('switch')).toHaveCount(2)
})

test('骨架屏立即可见且最少展示 300ms，加载完成不闪', async ({ page }) => {
  // 不走 mockApi 的共享 /api/sessions 路由，确保这里的延迟一定生效。
  await page.route('**/web/session', (r) => r.fulfill({ json: session }))
  await page.route('**/api/profile', (r) => r.fulfill({ json: profile }))
  await page.route('**/api/totp', (r) => r.fulfill({ json: { enabled: true } }))
  await page.route('**/api/passkeys', (r) => r.fulfill({ json: [] }))
  await page.route('**/api/sessions', async (r) => {
    await new Promise((x) => setTimeout(x, 200))
    await r.fulfill({ json: sessions })
  })
  await page.goto('/web/console')
  // 立即可见：点进页面就有占位反馈，而不是先白屏。
  const skeleton = page.locator('main .skeleton').first()
  await expect(skeleton).toBeAttached()
  await expect(skeleton.evaluate((el) => getComputedStyle(el).opacity)).resolves.not.toBe('0')
  // 数据 200ms 就到了，但骨架最少展示 300ms：期间不消失，避免“闪一下就没了”。
  await page.waitForTimeout(120)
  await expect(skeleton).toBeAttached()
  await page.waitForTimeout(400)
  // 最少展示期结束后内容接管，骨架消失。
  await expect(skeleton).toHaveCount(0)
  await expect(page.getByText('MacBook Pro · Chrome')).toBeVisible()
})

test('深色模式控制台无严重无障碍问题', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await mockApi(page)
  await page.goto('/web/console')
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible()
  await noSeriousA11y(page)
})

test('移动端 390px 无横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockApi(page)
  await page.goto('/web/console')
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  expect(overflow).toBeTruthy()
  await noSeriousA11y(page)
})
