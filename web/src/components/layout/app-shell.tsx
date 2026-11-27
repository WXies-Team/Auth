import * as React from 'react'
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Activity,
  AppWindow,
  ChartColumn,
  ChevronDown,
  HeartPulse,
  Fingerprint,
  Languages,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  Monitor,
  Moon,
  ScrollText,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth'
import { useI18n, type Lang } from '@/lib/i18n'
import { api } from '@/lib/api'
import { useTheme, type Theme } from '@/lib/theme'
import { AVATAR_PALETTE, avatarDataUrl, roleLabel, initials } from '@/lib/format'
import { useProfile } from '@/lib/queries'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

type NavItem = { to: string; labelKey: string; icon: React.ComponentType<{ className?: string }> }

const userNav: NavItem[] = [
  { to: '/web/console', labelKey: 'nav.console', icon: LayoutDashboard },
  { to: '/web/console/sessions', labelKey: 'nav.sessions', icon: Monitor },
  { to: '/web/console/passkeys', labelKey: 'nav.passkeys', icon: Fingerprint },
  { to: '/web/console/security', labelKey: 'nav.security', icon: ShieldCheck },
  { to: '/web/console/connections', labelKey: 'nav.connections', icon: AppWindow },
  { to: '/web/console/activity', labelKey: 'nav.activity', icon: Activity },
  { to: '/web/console/account', labelKey: 'nav.account', icon: Settings },
]

const adminNav: NavItem[] = [
  { to: '/web/admin', labelKey: 'nav.users', icon: Users },
  { to: '/web/admin/access', labelKey: 'nav.access', icon: Lock },
  { to: '/web/admin/sessions', labelKey: 'nav.adminSessions', icon: Monitor },
  { to: '/web/admin/audit', labelKey: 'nav.audit', icon: ScrollText },
  { to: '/web/admin/config', labelKey: 'nav.config', icon: SlidersHorizontal },
  { to: '/web/admin/ai-usage', labelKey: 'nav.ai', icon: ChartColumn },
  { to: '/web/admin/system', labelKey: 'nav.system', icon: HeartPulse },
]

function isNavActive(pathname: string, to: string): boolean {
  if (to === '/web/console') return pathname === '/web/console'
  // 用户详情属于「用户」分区，否则停在 /web/admin/users/:uid 时没有任何高亮。
  if (to === '/web/admin') return pathname === '/web/admin' || pathname.startsWith('/web/admin/users')
  return pathname === to || pathname.startsWith(to + '/')
}

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const { pathname } = useLocation()
  const { t } = useI18n()
  return (
    <nav className="space-y-0.5">
      {items.map((item) => {
        const active = isNavActive(pathname, item.to)
        return (
          <Link
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-sidebar-accent text-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
            )}
          >
            <item.icon className="size-4" />
            {t(item.labelKey)}
          </Link>
        )
      })}
    </nav>
  )
}

function Brand() {
  return (
    <Link to="/web/console" className="flex items-center gap-2 px-2 py-1">
      <img src="/favicon.svg" alt="" className="size-7" />
      <span className="text-base font-semibold tracking-tight">Auth</span>
    </Link>
  )
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const { session } = useAuth()
  const { t } = useI18n()
  const location = useLocation()
  const inAdmin = location.pathname.startsWith('/web/admin')
  const isAdmin = session?.role === 'super' || session?.role === 'admin'
  const isSuper = session?.role === 'super'
  const items = inAdmin
    ? adminNav.filter((i) => isSuper || !['/web/admin', '/web/admin/config', '/web/admin/system'].includes(i.to))
    : userNav

  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <Brand />
      <div className="flex-1 overflow-y-auto">
        <p className="text-muted-foreground px-2.5 pb-2 text-xs font-medium">
          {inAdmin ? t('nav.adminSection') : t('nav.consoleSection')}
        </p>
        <NavList items={items} onNavigate={onNavigate} />
      </div>
      <div className="space-y-2">
        <Separator />
        {inAdmin ? (
          <Link
            to="/web/console"
            onClick={onNavigate}
            className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium"
          >
            <LayoutDashboard className="size-4" /> {t('nav.backConsole')}
          </Link>
        ) : (
          isAdmin && (
            <Link
              to={session?.role === 'super' ? '/web/admin' : '/web/admin/sessions'}
              onClick={onNavigate}
              className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium"
            >
              <ShieldCheck className="size-4" /> {t('nav.adminConsole')}
              {!session?.totpEnabled && (session?.passkeyCount ?? 0) === 0 && (
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                  待绑定 MFA
                </span>
              )}
            </Link>
          )
        )}
      </div>
    </div>
  )
}

function LanguageMenu() {
  const { lang, setLang } = useI18n()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={lang === 'zh' ? '切换语言' : 'Change language'}>
          <Languages />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(['zh', 'en'] as Lang[]).map((l) => (
          <DropdownMenuItem key={l} onClick={() => setLang(l)}>
            {l === 'zh' ? '中文' : 'English'}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ThemeMenu() {
  const { theme, setTheme } = useTheme()
  const { t } = useI18n()
  const icon = theme === 'dark' ? <Moon /> : theme === 'light' ? <Sun /> : <Monitor />
  const choose = (t: Theme) => setTheme(t)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('shell.theme')}>
          {icon}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => choose('light')}>
          <Sun /> {t('shell.themeLight')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => choose('dark')}>
          <Moon /> {t('shell.themeDark')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => choose('system')}>
          <Monitor /> {t('shell.themeSystem')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AccountMenu() {
  const { session, logout } = useAuth()
  const { t } = useI18n()
  const { data: profile } = useProfile()
  if (!session) return null
  const name = profile?.nickname?.trim() || session.email.split('@')[0]
  const color = AVATAR_PALETTE[profile?.avatarColor ?? 0] ?? AVATAR_PALETTE[0]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-9 gap-2 px-1.5">
          <Avatar className="size-7">
            <AvatarImage src={avatarDataUrl(profile?.avatarImage)} alt="" />
            <AvatarFallback style={{ background: color, color: '#fff' }}>{initials(name)}</AvatarFallback>
          </Avatar>
          <span className="hidden max-w-40 truncate text-sm sm:inline">{name}</span>
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <p className="truncate text-sm font-medium">{session.email}</p>
          <p className="text-muted-foreground text-xs">{roleLabel(session.role)}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/web/console/account">
            <Settings /> 账号设置
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/web/console/security">
            <ShieldCheck /> 安全设置
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => {
            void logout().then(() => window.location.assign('/web/login'))
          }}
        >
          <LogOut /> {t('shell.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Topbar() {
  const location = useLocation()
  const { session } = useAuth()
  const { t } = useI18n()
  const inAdmin = location.pathname.startsWith('/web/admin')
  const title = inAdmin ? t('nav.adminSection') : t('nav.consoleSection')
  return (
    <header className="bg-background/80 sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 backdrop-blur-md">
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="min-[900px]:hidden" aria-label="打开导航">
            <Menu />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="p-0">
          <SheetTitle className="sr-only">导航</SheetTitle>
          <SidebarBody />
        </SheetContent>
      </Sheet>
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-xs">{title}</p>
      </div>
      {session?.isRoot && <span className="text-muted-foreground hidden text-xs sm:inline">{t('shell.rootAdmin')}</span>}
      <ThemeMenu />
      <LanguageMenu />
      <AccountMenu />
    </header>
  )
}

// 模拟登录横幅：固定在页面顶部（占布局高度，不遮内容），只提供「退出模拟」。
// 其它写操作入口由服务端只读闸兜底，这里只负责让身份一眼可见。
function ImpersonationBanner() {
  const { session } = useAuth()
  const [busy, setBusy] = React.useState(false)
  if (!session?.impersonatorUid) return null
  const stop = async () => {
    setBusy(true)
    try {
      await api.post('/api/impersonation/stop', {})
    } finally {
      window.location.assign('/web/console')
    }
  }
  return (
    <div className="sticky top-0 z-40 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-500 px-3 py-1.5 text-center text-xs font-medium text-amber-950">
      <span>
        模拟查看中：{session.email} · 由 {session.impersonatorEmail || '平台管理员'} 发起 · 只读，15 分钟后自动结束
      </span>
      <button
        type="button"
        onClick={() => void stop()}
        disabled={busy}
        className="rounded border border-amber-900/40 px-2 py-0.5 font-semibold hover:bg-amber-400 disabled:opacity-60"
      >
        {busy ? '退出中…' : '退出模拟'}
      </button>
    </div>
  )
}

function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { session } = useAuth()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [q, setQ] = React.useState('')
  const items = React.useMemo(() => {
    const all = [...userNav]
    if (session?.role === 'super' || session?.role === 'admin') all.push(...adminNav)
    return all.filter((i) => !q.trim() || t(i.labelKey).toLowerCase().includes(q.trim().toLowerCase()))
  }, [q, session?.role, t])

  React.useEffect(() => {
    if (open) setQ('')
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[20%] max-w-lg translate-y-0 p-0" showClose={false}>
        <DialogTitle className="sr-only">{t('shell.paletteTitle')}</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="text-muted-foreground size-4" />
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('shell.searchPlaceholder')}
            className="border-0 shadow-none focus-visible:ring-0"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && items[0]) {
                onOpenChange(false)
                navigate(items[0].to)
              }
            }}
          />
          <kbd className="text-muted-foreground rounded border px-1.5 py-0.5 text-[10px]">Esc</kbd>
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {items.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm">{t('shell.noResults')}</p>
          ) : (
            items.map((item) => (
              <button
                key={item.to}
                type="button"
                className="hover:bg-accent flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
                onClick={() => {
                  onOpenChange(false)
                  navigate(item.to)
                }}
              >
                <item.icon className="size-4" />
                {t(item.labelKey)}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function AppShell() {
  const { pathname } = useLocation()
  const mainRef = React.useRef<HTMLElement>(null)
  const [palette, setPalette] = React.useState(false)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  React.useEffect(() => {
    window.scrollTo(0, 0)
    // 路由切换后把焦点交给主内容，读屏不会还停在旧页的链接上。
    mainRef.current?.focus({ preventScroll: true })
  }, [pathname])

  return (
    <div className="min-h-dvh">
      <ImpersonationBanner />
      <aside className="bg-sidebar fixed inset-y-0 left-0 z-20 hidden w-60 border-r min-[900px]:block">
        <SidebarBody />
      </aside>
      <div className="min-[900px]:pl-60">
        <Topbar />
        <AdminMfaNotice />
        <main ref={mainRef} tabIndex={-1} className="relative mx-auto w-full max-w-6xl p-4 outline-none sm:p-6">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} />
    </div>
  )
}

// 首次进入控制台时的骨架：**按真实外壳排版**（侧栏 + 顶栏 + 内容区），
// 不再用一个居中的小卡片冒充整页——否则加载完成会看到布局整体跳一次。
// 启动/会话探测期的品牌屏：**不是骨架**。整页只有一个视觉状态（Logo），
// 会话一到就直接进真实外壳 + 页面自己的唯一骨架；不再出现「外壳骨架 → 页面骨架」
// 的第二次切换。公开页（登录/邀请…）的 chunk 兜底也复用它。
export function BootSplash() {
  return (
    <div className="boot-splash bg-background flex min-h-dvh flex-col items-center justify-center gap-3">
      <div className="flex items-center gap-2">
        <img src="/favicon.svg" alt="" className="size-8" />
        <span className="text-lg font-semibold tracking-tight">Auth</span>
      </div>
      <span className="bg-muted relative h-0.5 w-24 overflow-hidden rounded-full">
        <span className="bg-primary absolute inset-y-0 w-1/3 rounded-full motion-safe:animate-[boot-slide_1.2s_ease-in-out_infinite]" />
      </span>
    </div>
  )
}

export function RequireAuth() {
  const { session, loading } = useAuth()
  const location = useLocation()
  if (loading) return <BootSplash />
  if (!session) {
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/web/login?next=${next}`} replace />
  }
  return <Outlet />
}

// 管理员未绑 MFA 的常驻提醒：参考 Google Workspace 的做法——在管理员登录后的
// 控制台顶部持续提醒，而不是等他点进后台才发现被拦。绑定后立即消失。
function AdminMfaNotice() {
  const { session } = useAuth()
  if (!session || (session.role !== 'admin' && session.role !== 'super')) return null
  if (session.totpEnabled || session.passkeyCount > 0) return null
  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 text-sm sm:px-6">
        <ShieldAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="min-w-0 flex-1">
          你是{session.role === 'super' ? '平台管理员' : '项目管理员'}，但尚未绑定两步验证：
          <span className="font-medium">管理后台暂不可用</span>，绑定后立即恢复。
        </p>
        <Button size="sm" asChild>
          <Link to="/web/console/security">去绑定</Link>
        </Button>
      </div>
    </div>
  )
}

// 管理员强制 MFA 的落地面：有管理角色但还没绑 TOTP/Passkey 时，后端会拒绝所有
// /admin/* 数据（mfa_required）。旧前端把 403 吞成空表，管理员只看到「没有数据」。
// 这里在进页面之前就把原因和下一步说清楚（OWASP 对管理接口的强制 MFA 建议）。
function AdminMFARequired() {
  return (
    <div className="mx-auto w-full max-w-lg py-6">
      <Card>
        <CardHeader>
          <CardTitle>管理后台需要两步验证</CardTitle>
          <CardDescription>
            你已拥有管理权限，但管理后台涉及全站用户数据，必须先绑定两步验证或 Passkey 才能访问。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-sm">
            绑定后回到这里即可查看用户、会话与审计数据。两步验证同时保护你的账号：即使密码泄露，攻击者也无法直接进入后台。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to="/web/console/security">
                <ShieldCheck /> 去绑定两步验证
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/web/console">返回控制台</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export function RequireAdmin() {
  const { session } = useAuth()
  if (!session) return null
  if (session.role !== 'admin' && session.role !== 'super') {
    return <Navigate to="/web/console" replace />
  }
  if (!session.totpEnabled && session.passkeyCount === 0) {
    return <AdminMFARequired />
  }
  return <Outlet />
}

export function RequireSuper() {
  const { session } = useAuth()
  if (!session) return null
  if (session.role !== 'super') return <Navigate to="/web/admin/sessions" replace />
  return <Outlet />
}

export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-bg flex min-h-dvh flex-col items-center justify-center p-4">
      <div className="mb-6 flex items-center gap-2">
        <img src="/favicon.svg" alt="" className="size-8" />
        <span className="text-lg font-semibold tracking-tight">Auth</span>
      </div>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  )
}
