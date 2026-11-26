import * as React from 'react'
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom'
import {
  Activity,
  AppWindow,
  ChartColumn,
  ChevronDown,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  Monitor,
  Moon,
  ScrollText,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'

type NavItem = { to: string; label: string; icon: React.ComponentType<{ className?: string }> }

const userNav: NavItem[] = [
  { to: '/web/console', label: '概览', icon: LayoutDashboard },
  { to: '/web/console/sessions', label: '登录会话', icon: Monitor },
  { to: '/web/console/passkeys', label: 'Passkey', icon: KeyRound },
  { to: '/web/console/security', label: '两步验证', icon: ShieldCheck },
  { to: '/web/console/connections', label: '已授权应用', icon: AppWindow },
  { to: '/web/console/activity', label: '安全活动', icon: Activity },
  { to: '/web/console/account', label: '账号', icon: Settings },
]

const adminNav: NavItem[] = [
  { to: '/web/admin', label: '用户', icon: Users },
  { to: '/web/admin/access', label: '项目访问', icon: Lock },
  { to: '/web/admin/sessions', label: '会话总览', icon: Monitor },
  { to: '/web/admin/audit', label: '审计日志', icon: ScrollText },
  { to: '/web/admin/config', label: '配置中心', icon: SlidersHorizontal },
  { to: '/web/admin/ai-usage', label: 'AI 用量', icon: ChartColumn },
  { to: '/web/admin/system', label: '系统状态', icon: Activity },
]

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <nav className="space-y-0.5">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/web/console'}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-sidebar-accent text-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
            )
          }
        >
          <item.icon className="size-4" />
          {item.label}
        </NavLink>
      ))}
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
        <p className="text-muted-foreground px-2.5 pb-2 text-xs font-medium">{inAdmin ? '管理后台' : '控制台'}</p>
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
            <LayoutDashboard className="size-4" /> 返回控制台
          </Link>
        ) : (
          isAdmin && (
            <Link
              to={session?.role === 'super' ? '/web/admin' : '/web/admin/sessions'}
              onClick={onNavigate}
              className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium"
            >
              <ShieldCheck className="size-4" /> 管理后台
            </Link>
          )
        )}
      </div>
    </div>
  )
}

function ThemeMenu() {
  const { theme, setTheme } = useTheme()
  const icon = theme === 'dark' ? <Moon /> : theme === 'light' ? <Sun /> : <Monitor />
  const choose = (t: Theme) => setTheme(t)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="切换主题">
          {icon}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => choose('light')}>
          <Sun /> 亮色
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => choose('dark')}>
          <Moon /> 暗色
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => choose('system')}>
          <Monitor /> 跟随系统
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AccountMenu() {
  const { session, logout } = useAuth()
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
          <LogOut /> 退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Topbar() {
  const location = useLocation()
  const { session } = useAuth()
  const inAdmin = location.pathname.startsWith('/web/admin')
  const title = inAdmin ? '管理后台' : '控制台'
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
      {session?.isRoot && <span className="text-muted-foreground hidden text-xs sm:inline">根管理员</span>}
      <ThemeMenu />
      <AccountMenu />
    </header>
  )
}

export function AppShell() {
  return (
    <div className="min-h-dvh">
      <aside className="bg-sidebar fixed inset-y-0 left-0 z-20 hidden w-60 border-r min-[900px]:block">
        <SidebarBody />
      </aside>
      <div className="min-[900px]:pl-60">
        <Topbar />
        <main className="mx-auto w-full max-w-6xl p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export function RequireAuth() {
  const { session, loading } = useAuth()
  const location = useLocation()
  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="w-full max-w-sm space-y-3">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    )
  }
  if (!session) {
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/web/login?next=${next}`} replace />
  }
  return <Outlet />
}

export function RequireAdmin() {
  const { session } = useAuth()
  if (!session) return null
  if (session.role !== 'admin' && session.role !== 'super') {
    return <Navigate to="/web/console" replace />
  }
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
      <p className="text-muted-foreground mt-8 text-xs">Horatio 统一账号</p>
    </div>
  )
}
