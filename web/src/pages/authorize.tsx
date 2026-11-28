import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ArrowLeftRight, CheckCircle2, Loader2, ShieldAlert } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import type { OAuthInfo } from '@/lib/types'
import { useAuth } from '@/lib/auth'
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
  const { logout } = useAuth()
  const [switching, setSwitching] = React.useState(false)

  // 换账号 = 结束当前会话，再带着同一个 tx 回登录页；登录成功后按 tx 续跑授权，
  // 同意仍由新登录的人做（tx 只存请求参数，不绑定用户）。
  async function switchAccount() {
    if (!data || switching) return
    setSwitching(true)
    try {
      await logout()
    } finally {
      window.location.assign(`/web/login?tx=${encodeURIComponent(data.tx)}`)
    }
  }

  const appName = data?.appName || data?.app

  return (
    <AuthLayout wide>
      <Card>
        <CardHeader>
          {appName ? (
            <div className="flex items-center gap-3">
              <div className="bg-primary/10 text-primary grid size-11 shrink-0 place-items-center rounded-xl text-lg font-semibold">
                {initial(appName)}
              </div>
              <div className="min-w-0">
                <CardTitle className="text-xl">{appName}</CardTitle>
                <CardDescription>请求访问你的账号</CardDescription>
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
            <div className="space-y-3">
              <Alert variant="destructive">
                <ShieldAlert className="size-4" />
                <AlertDescription>{error.message}</AlertDescription>
              </Alert>
              {error instanceof ApiError && error.status === 401 ? (
                <Button asChild className="w-full">
                  <Link to={`/web/login?next=${encodeURIComponent(next)}`}>先登录再继续</Link>
                </Button>
              ) : (
                <Button variant="outline" className="w-full" asChild>
                  <Link to="/web/login">返回登录</Link>
                </Button>
              )}
            </div>
          ) : data ? (
            <>
              <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                <div className="bg-primary text-primary-foreground grid size-8 shrink-0 place-items-center rounded-full text-xs font-medium">
                  {initial(data.email)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-muted-foreground text-xs">当前账号</p>
                  <p className="truncate text-sm font-medium">{data.email}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => void switchAccount()} disabled={switching}>
                  {switching ? <Loader2 className="animate-spin" /> : <ArrowLeftRight />}
                  切换账号
                </Button>
              </div>

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
                  <p>完成后会回到下面的地址（不是本站域名）：</p>
                  <p className="mt-1 font-mono text-sm font-medium [overflow-wrap:anywhere]">{data.redirectHost}</p>
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
              <Link to="/web/login">返回登录</Link>
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
