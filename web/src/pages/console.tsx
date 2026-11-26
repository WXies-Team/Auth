import { Link } from 'react-router-dom'
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  KeyRound,
  Lock,
  MonitorSmartphone,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'
import { useAuth } from '@/lib/auth'
import { usePasskeys, useSessions, useTotp } from '@/lib/queries'
import { appLabel, dateTime, relativeTime, roleLabel } from '@/lib/format'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'

export default function ConsolePage() {
  const { session, logout } = useAuth()
  const totp = useTotp()
  const passkeys = usePasskeys()
  const sessions = useSessions()

  if (!session) return null

  const totpOn = !!totp.data?.enabled
  const passkeyCount = passkeys.data?.length ?? 0
  const methods = [session.passwordSet, totpOn, passkeyCount > 0].filter(Boolean).length
  const score = Math.round((methods / 3) * 100)
  const recent = sessions.data?.sessions?.[0]

  const items = [
    {
      title: '密码',
      desc: session.passwordSet ? '已设置，可用于登录' : '未设置，只能用验证码或 Passkey',
      on: session.passwordSet,
      href: '/web/console/account',
      icon: Lock,
    },
    {
      title: '两步验证',
      desc: totpOn ? `已开启${totp.data?.recoveryLeft != null ? ` · 恢复码剩 ${totp.data.recoveryLeft} 枚` : ''}` : '未开启，建议绑定验证器',
      on: totpOn,
      href: '/web/console/security',
      icon: ShieldCheck,
    },
    {
      title: 'Passkey',
      desc: passkeyCount > 0 ? `${passkeyCount} 把，可用于免密登录` : '未添加，登录更慢一步',
      on: passkeyCount > 0,
      href: '/web/console/passkeys',
      icon: KeyRound,
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="概览"
        description={`${session.email} · ${roleLabel(session.role)}`}
        actions={
          <Button variant="outline" onClick={() => void logout().then(() => window.location.assign('/web/login'))}>
            退出登录
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>账号安全</CardTitle>
            <CardDescription>三种登录方式至少保留一种，否则会无法登录。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">安全评分</span>
                <span className="text-muted-foreground tabular-nums">{score}%</span>
              </div>
              <Progress value={score} aria-label="安全评分" />
              <p className="text-muted-foreground text-xs">
                {methods === 3
                  ? '三种方式都已启用，账号恢复能力完整。'
                  : '建议补齐未启用的方式，降低单点丢失导致无法登录的风险。'}
              </p>
            </div>
            <Separator />
            <div className="space-y-1">
              {items.map((it) => (
                <Link
                  key={it.title}
                  to={it.href}
                  className="hover:bg-muted -mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5"
                >
                  <div className="bg-muted flex size-9 items-center justify-center rounded-md">
                    <it.icon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {it.title}
                      {it.on ? (
                        <Badge variant="success">
                          <CheckCircle2 className="size-3" /> 已启用
                        </Badge>
                      ) : (
                        <Badge variant="warning">
                          <TriangleAlert className="size-3" /> 未启用
                        </Badge>
                      )}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">{it.desc}</p>
                  </div>
                  <ArrowRight className="text-muted-foreground size-4" />
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>最近登录</CardTitle>
            <CardDescription>发现陌生设备时立即退出。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {sessions.isLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : recent ? (
              <>
                <div className="flex items-center gap-2">
                  <MonitorSmartphone className="text-muted-foreground size-4" />
                  <p className="text-sm font-medium">{recent.device || '未知设备'}</p>
                  {recent.current && <Badge variant="secondary">本机</Badge>}
                </div>
                <p className="text-muted-foreground text-xs">
                  {relativeTime(recent.lastSeenAt)} · {recent.ip}
                  {recent.ipRegion ? ` · ${recent.ipRegion}` : ''}
                </p>
                <p className="text-muted-foreground text-xs">
                  {appLabel(recent.app)} · 首次登录 {dateTime(recent.createdAt)}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">只有当前设备处于登录状态。</p>
            )}
            <Separator />
            <Button variant="outline" className="w-full" asChild>
              <Link to="/web/console/sessions">
                <MonitorSmartphone /> 管理已登录设备
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Link to="/web/console/passkeys" className="group">
          <Card className="hover:border-primary/40 h-full transition-colors">
            <CardHeader>
              <KeyRound className="text-muted-foreground size-5" />
              <CardTitle>添加 Passkey</CardTitle>
              <CardDescription>用指纹、面容或安全密钥免密登录。</CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link to="/web/console/security" className="group">
          <Card className="hover:border-primary/40 h-full transition-colors">
            <CardHeader>
              <ShieldCheck className="text-muted-foreground size-5" />
              <CardTitle>开启两步验证</CardTitle>
              <CardDescription>验证器 App + 一次性恢复码。</CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link to="/web/console/activity" className="group">
          <Card className="hover:border-primary/40 h-full transition-colors">
            <CardHeader>
              <Activity className="text-muted-foreground size-5" />
              <CardTitle>查看安全活动</CardTitle>
              <CardDescription>登录、改密、凭证变更的时间线。</CardDescription>
            </CardHeader>
          </Card>
        </Link>
      </div>
    </div>
  )
}
