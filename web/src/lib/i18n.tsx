import * as React from 'react'

// 轻量 i18n（W13）：不引第三方库（~2KB 自实现），只覆盖「账号台外壳 + 登录/注册
// /邀请/404」这些入口面；控制台内页正文仍为中文，后续按页增量接 t() 即可。
//
// 口径：
//   - 缺省中文；英文缺失键回退中文，再回退键名（永不显示空白）；
//   - 语言存 localStorage（auth.lang），首次按浏览器语言猜一次；
//   - <html lang> 同步，读屏与断词规则跟着走。
export type Lang = 'zh' | 'en'

type Dict = Record<string, string>

const zh: Dict = {
  'nav.console': '概览',
  'nav.sessions': '登录会话',
  'nav.passkeys': 'Passkey',
  'nav.security': '两步验证',
  'nav.connections': '已授权应用',
  'nav.activity': '安全活动',
  'nav.account': '账号',
  'nav.users': '用户',
  'nav.access': '项目访问',
  'nav.adminSessions': '会话总览',
  'nav.audit': '审计日志',
  'nav.config': '配置中心',
  'nav.ai': 'AI 用量',
  'nav.system': '系统状态',
  'nav.consoleSection': '控制台',
  'nav.adminSection': '管理后台',
  'nav.backConsole': '返回控制台',
  'nav.adminConsole': '管理后台',
  'shell.logout': '退出登录',
  'shell.theme': '切换主题',
  'shell.themeLight': '亮色',
  'shell.themeDark': '暗色',
  'shell.themeSystem': '跟随系统',
  'shell.language': '语言',
  'shell.langZh': '中文',
  'shell.langEn': 'English',
  'shell.searchPlaceholder': '搜索页面，回车跳转',
  'shell.noResults': '没有匹配的页面',
  'shell.paletteTitle': '快速跳转',
  'shell.rootAdmin': '根管理员',
  'login.title': '登录 Auth',
  'login.subtitle': '使用密码、邮箱验证码或 Passkey 登录。',
  'login.tabPassword': '密码',
  'login.tabCode': '邮箱验证码',
  'login.tabReset': '找回密码',
  'login.email': '邮箱',
  'login.password': '密码',
  'login.login': '登录',
  'login.code': '验证码',
  'login.getCode': '获取验证码',
  'login.newPassword': '新密码',
  'login.confirmPassword': '确认新密码',
  'login.resetPassword': '重置密码',
  'login.passkey': '使用 Passkey 登录',
  'login.totpTitle': '两步验证',
  'login.totpSubtitle': '输入验证器上的 6 位验证码，或改用恢复码 / 邮箱验证码。',
  'login.forceTitle': '设置新密码',
  'login.forceSubtitle': '管理员要求你设置新密码后才能继续。',
  'login.saveContinue': '保存并继续',
  'login.noAccount': '没有账号？',
  'login.inviteHint': '没有账号？联系管理员获取邀请链接。',
  'login.create': '创建一个',
  'register.title': '创建账号',
  'register.subtitle': '用邮箱验证码注册，创建后直接登录。',
  'register.closed': '当前为邀请制，请使用管理员发来的邀请链接。',
  'register.submit': '创建账号',
  'register.back': '返回登录',
  'register.hasAccount': '已有账号？',
  'register.login': '直接登录',
  'notfound.title': '页面不存在',
  'notfound.description': '链接可能已失效，或你输入了一个不存在的地址。',
  'notfound.back': '返回控制台',
}

const en: Dict = {
  'nav.console': 'Overview',
  'nav.sessions': 'Sessions',
  'nav.passkeys': 'Passkeys',
  'nav.security': 'Two-factor',
  'nav.connections': 'Connected apps',
  'nav.activity': 'Security activity',
  'nav.account': 'Account',
  'nav.users': 'Users',
  'nav.access': 'Project access',
  'nav.adminSessions': 'All sessions',
  'nav.audit': 'Audit log',
  'nav.config': 'Configuration',
  'nav.ai': 'AI usage',
  'nav.system': 'System status',
  'nav.consoleSection': 'Console',
  'nav.adminSection': 'Admin',
  'nav.backConsole': 'Back to console',
  'nav.adminConsole': 'Admin console',
  'shell.logout': 'Sign out',
  'shell.theme': 'Toggle theme',
  'shell.themeLight': 'Light',
  'shell.themeDark': 'Dark',
  'shell.themeSystem': 'System',
  'shell.language': 'Language',
  'shell.langZh': '中文',
  'shell.langEn': 'English',
  'shell.searchPlaceholder': 'Search pages, Enter to jump',
  'shell.noResults': 'No matching pages',
  'shell.paletteTitle': 'Quick jump',
  'shell.rootAdmin': 'Root admin',
  'login.title': 'Sign in to Auth',
  'login.subtitle': 'Use a password, an email code, or a passkey.',
  'login.tabPassword': 'Password',
  'login.tabCode': 'Email code',
  'login.tabReset': 'Reset password',
  'login.email': 'Email',
  'login.password': 'Password',
  'login.login': 'Sign in',
  'login.code': 'Code',
  'login.getCode': 'Send code',
  'login.newPassword': 'New password',
  'login.confirmPassword': 'Confirm password',
  'login.resetPassword': 'Reset password',
  'login.passkey': 'Sign in with a passkey',
  'login.totpTitle': 'Two-factor verification',
  'login.totpSubtitle': 'Enter the 6-digit code from your authenticator, or use a recovery code / email code.',
  'login.forceTitle': 'Set a new password',
  'login.forceSubtitle': 'An administrator requires a new password before you continue.',
  'login.saveContinue': 'Save and continue',
  'login.noAccount': 'No account?',
  'login.inviteHint': 'No account? Ask an administrator for an invite link.',
  'login.create': 'Create one',
  'register.title': 'Create an account',
  'register.subtitle': 'Register with an email code and sign in right away.',
  'register.closed': 'Registration is invite-only right now. Use the invite link from your administrator.',
  'register.submit': 'Create account',
  'register.back': 'Back to sign in',
  'register.hasAccount': 'Already have an account?',
  'register.login': 'Sign in',
  'notfound.title': 'Page not found',
  'notfound.description': 'The link may have expired, or the address does not exist.',
  'notfound.back': 'Back to console',
}

const messages: Record<Lang, Dict> = { zh, en }

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (key: string) => string }

const I18nContext = React.createContext<Ctx | null>(null)

function guessLang(): Lang {
  // 不按浏览器语言自动切换：本服务面向中文用户，默认中文，语言由用户显式选择后持久化。
  // （自动猜语言会让同一份文档的标题/导航随访问者环境漂移，E2E 与截图都不可复现。）
  const saved = window.localStorage.getItem('auth.lang')
  return saved === 'en' ? 'en' : 'zh'
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = React.useState<Lang>(() => {
    try {
      return guessLang()
    } catch {
      return 'zh'
    }
  })

  React.useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  const setLang = React.useCallback((l: Lang) => {
    setLangState(l)
    try {
      window.localStorage.setItem('auth.lang', l)
    } catch {
      // 隐私模式：本次会话内生效
    }
  }, [])

  const t = React.useCallback((key: string) => messages[lang][key] ?? messages.zh[key] ?? key, [lang])

  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>
}

export function useI18n(): Ctx {
  const ctx = React.useContext(I18nContext)
  if (!ctx) throw new Error('useI18n 必须在 I18nProvider 内使用')
  return ctx
}
