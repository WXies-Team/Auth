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

test('控制台展示安全评分与最近登录', async ({ page }) => {
  await mockApi(page)
  await page.goto('/web/console')
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible()
  await expect(page.getByText('账号安全')).toBeVisible()
  await expect(page.getByText('MacBook Pro · Chrome')).toBeVisible()
  await noSeriousA11y(page)
})

test('用户列表可搜索并打开详情入口', async ({ page }) => {
  await mockApi(page)
  await page.goto('/web/admin')
  await expect(page.getByRole('heading', { name: '用户' })).toBeVisible()
  await expect(page.getByText('hs@horatio.cn')).toBeVisible()
  await expect(page.getByRole('link', { name: '详情' })).toBeVisible()
  await noSeriousA11y(page)
})

test('深色模式控制台无严重无障碍问题', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await mockApi(page)
  await page.goto('/web/console')
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible()
  await noSeriousA11y(page)
})
