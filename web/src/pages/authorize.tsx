import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ArrowLeftRight, CheckCircle2, Loader2, ShieldAlert } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import type { OAuthInfo } from '@/lib/types'
import { useAuth } from '@/lib/auth'
import { useProfile } from '@/lib/queries'
import { AVATAR_PALETTE, avatarDataUrl, initials } from '@/lib/format'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { AuthLayout } from '@/components/layout/app-shell'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { useLoadingSkeleton } from '@/lib/use-loading'

function submitDecision(tx: string, decision: 'allow' | 'deny') {
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = '/oauth/authorize/confirm'
  for (const [name, value] of Object.entries({ tx, decision })) {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    input.value = value
    form.appendChild(input)
  }
  document.body.appendChild(form)
  form.submit()
}

function initial(value: string): string {
  return (value.trim()[0] ?? 'A').toUpperCase()
}

// 失败时「返回」的去处：授权请求里 redirect_uri 的 origin（只认 http/https）。
// 拿不到就回 Auth 控制台——回登录页是死路：tx 已失效，重新登录也续不上。
function appReturn(search: string): { origin: string; host: string } | null {
  const raw = new URLSearchParams(search).get('redirect_uri')
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return { origin: u.origin, host: u.host }
  } catch {
    return null
  }
}

// 应用图标用品牌登记表里的站内图标（/brand/<App>-v1.png），加载失败再退回首字方块。
function AppBadge({ icon, name }: { icon?: string; name: string }) {
  const [failed, setFailed] = React.useState(false)
  if (icon && !failed) {
    return (
      <img
        src={icon}
        alt=""
        width={44}
        height={44}
        className="size-11 shrink-0 rounded-xl"
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <div className="bg-primary/10 text-primary grid size-11 shrink-0 place-items-center rounded-xl text-lg font-semibold">
      {initial(name)}
    </div>
  )
}

function AccountRow({
  email,
  name,
  avatarImage,
  color,
  onSwitch,
  switching = false,
}: {
  email: string
  name: string
  avatarImage?: string
  color: string
  onSwitch?: () => void
  switching?: boolean
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <Avatar className="size-8">
        <AvatarImage src={avatarImage} alt="" />
        <AvatarFallback style={{ background: color, color: '#fff' }}>{initials(name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-xs">当前账号</p>
        <p className="truncate text-sm font-medium">{email}</p>
      </div>
      {onSwitch && (
        <Button variant="ghost" size="sm" onClick={onSwitch} disabled={switching}>
          {switching ? <Loader2 className="animate-spin" /> : <ArrowLeftRight />}
          切换账号
        </Button>
      )}
    </div>
  )
}

export function ConsentCard({
  data,
  isLoading,
  error,
  next,
}: {
  data?: OAuthInfo
  isLoading: boolean
  error: Error | null
  next: string
}) {
  const showSkeleton = useLoadingSkeleton(isLoading)
  const { session, logout } = useAuth()
  const { data: profile } = useProfile()
  const [switching, setSwitching] = React.useState(false)

  // 换账号 = 结束会话后重放当前授权地址：没有会话时服务端会新建 tx 并 302 到登录页，
  // 登录成功按 tx 续跑；同意仍由新登录的人做（tx 只存请求参数，不绑定用户）。
  // 这样在「没有访问权限」页（拿不到 tx）也能用同一个动作。
  async function switchAccount() {
    if (switching) return
    setSwitching(true)
    try {
      await logout()
    } finally {
      window.location.assign(next)
    }
  }

  const appName = data?.appName || data?.app
  const back = appReturn(next.includes('?') ? next.slice(next.indexOf('?') + 1) : '')
  const errInfo = error instanceof ApiError ? error : null
  // 错误回执带上了事务里的应用身份：拒绝页也按「应用名」返回，而不是裸域名。
  const errName = errInfo?.appName || errInfo?.app || ''
  const errHost = errInfo?.redirectHost || back?.host || ''
  const errOrigin = back?.origin ?? (errInfo?.redirectHost ? `https://${errInfo.redirectHost}` : null)
  // 返回按钮一律用应用名；没有应用名（无效客户端等）才退到域名，再没有就回控制台。
  const backLabel = errName || errHost
  // 账号头像沿用控制台那一套：有图用图，没图用昵称首字 + 主题色。
  const email = data?.email || session?.email || ''
  const avatarName = profile?.nickname?.trim() || email.split('@')[0] || ''
  const avatarColor = AVATAR_PALETTE[profile?.avatarColor ?? 0] ?? AVATAR_PALETTE[0]
  const avatarImage = avatarDataUrl(profile?.avatarImage)
  // 403 = 被门禁挡住（封禁 / 项目白名单 / 策略），不是表单或网络错误：
  // 单独一套「无权限」说明，而不是把红色报错塞在授权卡片里。
  const denied = errInfo?.status === 403 || errInfo?.reason === 'policy'
  const needsLogin = errInfo?.status === 401

  return (
    <AuthLayout wide>
      <Card>
        <CardHeader>
          {appName ? (
            <div className="flex items-center gap-3">
              <AppBadge icon={data?.icon} name={appName} />
              <div className="min-w-0">
                <CardTitle className="text-xl">{appName}</CardTitle>
                <CardDescription>请求访问你的账号</CardDescription>
              </div>
            </div>
          ) : denied ? (
            <div className="flex items-center gap-3">
              <div className="bg-muted text-muted-foreground grid size-11 shrink-0 place-items-center rounded-xl">
                <ShieldAlert className="size-5" />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-xl">没有访问权限</CardTitle>
                <CardDescription>当前账号不能登录该应用。</CardDescription>
              </div>
            </div>
          ) : (
            <>
              <CardTitle className="text-xl">授权登录</CardTitle>
              <CardDescription>确认是否允许该应用使用你的账号。</CardDescription>
            </>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {showSkeleton ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : error ? (
            needsLogin ? (
              <div className="space-y-3">
                <Alert variant="destructive">
                  <ShieldAlert className="size-4" />
                  <AlertDescription>{error.message}</AlertDescription>
                </Alert>
                <Button asChild className="w-full">
                  <Link to={`/web/login?next=${encodeURIComponent(next)}`}>先登录再继续</Link>
                </Button>
              </div>
            ) : denied ? (
              <div className="space-y-4">
                <p className="bg-muted/50 rounded-md border px-3 py-2.5 text-sm">{error.message}</p>
                <AccountRow email={email} name={avatarName} avatarImage={avatarImage} color={avatarColor} />
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  {errOrigin ? (
                    <Button variant="outline" asChild>
                      <a href={errOrigin}>返回 {backLabel}</a>
                    </Button>
                  ) : (
                    <Button variant="outline" asChild>
                      <Link to="/web/console">返回 Auth 控制台</Link>
                    </Button>
                  )}
                  <Button onClick={() => void switchAccount()} disabled={switching}>
                    {switching ? <Loader2 className="animate-spin" /> : <ArrowLeftRight />}
                    换个账号登录
                  </Button>
                </div>
                <p className="text-muted-foreground text-center text-xs">
                  权限由管理员分配；换一个已获授权的账号，或联系管理员。
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <Alert variant="destructive">
                  <ShieldAlert className="size-4" />
                  <AlertDescription>{error.message}</AlertDescription>
                </Alert>
                {errOrigin ? (
                  <Button asChild className="w-full">
                    <a href={errOrigin}>返回 {backLabel} 重新发起</a>
                  </Button>
                ) : (
                  <Button variant="outline" className="w-full" asChild>
                    <Link to="/web/console">返回 Auth 控制台</Link>
                  </Button>
                )}
              </div>
            )
          ) : data ? (
            <>
              <AccountRow
                email={email}
                name={avatarName}
                avatarImage={avatarImage}
                color={avatarColor}
                onSwitch={() => void switchAccount()}
                switching={switching}
              />

              <div className="space-y-2">
                <p className="text-sm font-medium">该应用将获得</p>
                <ul className="space-y-2">
                  {(data.scopes?.length ? data.scopes : ['你的账号标识（uid）', '你的邮箱地址']).map((s) => (
                    <li key={s} className="flex items-start gap-2 text-sm">
                      <CheckCircle2 className="text-success mt-0.5 size-4 shrink-0" />
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground text-xs">
                  只用于在你登录该应用时识别身份，不会用于其它用途。
                </p>
              </div>

              <Alert variant="warning">
                <ShieldAlert className="size-4" />
                <AlertDescription>
                  <p>
                    完成后会回到 <span className="text-foreground font-medium">{appName}</span>（
                    <span className="font-mono [overflow-wrap:anywhere]">{data.redirectHost}</span>），它不是本站域名。
                  </p>
                  <p className="mt-1">请确认这是你信任的应用。</p>
                </AlertDescription>
              </Alert>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={() => submitDecision(data.tx, 'deny')}>
                  取消
                </Button>
                <Button onClick={() => submitDecision(data.tx, 'allow')}>允许授权</Button>
              </div>

              <p className="text-muted-foreground text-center text-xs">
                授权长期有效，可随时在「已授权应用」中撤销。
              </p>
            </>
          ) : null}
        </CardContent>
      </Card>
    </AuthLayout>
  )
}

export default function AuthorizePage() {
  const search = window.location.search.replace(/^\?/, '')
  const { data, isLoading, error } = useQuery({
    queryKey: ['oauth-info', search],
    queryFn: () => api.get<OAuthInfo>(`/oauth/authorize?format=json&${search}`, { reauth: false }),
    retry: false,
    enabled: !!search,
  })

  if (!search) {
    return (
      <AuthLayout>
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">授权链接不完整</CardTitle>
            <CardDescription>请从应用重新发起登录。</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" asChild>
              <Link to="/web/console">返回 Auth 控制台</Link>
            </Button>
          </CardContent>
        </Card>
      </AuthLayout>
    )
  }

  return (
    <ConsentCard
      data={data}
      isLoading={isLoading}
      error={error as Error | null}
      next={`/oauth/authorize?${search}`}
    />
  )
}
