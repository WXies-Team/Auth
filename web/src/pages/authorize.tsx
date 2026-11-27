import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { CheckCircle2, ShieldAlert } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import type { OAuthInfo } from '@/lib/types'
import { AuthLayout } from '@/components/layout/app-shell'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { useLoadingSkeleton } from '@/lib/use-loading'
import { Separator } from '@/components/ui/separator'

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
  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">授权登录</CardTitle>
          <CardDescription>
            {data ? (
              <>
                <span className="text-foreground font-medium">{data.appName || data.app}</span> 请求使用你的账号
              </>
            ) : (
              '确认是否允许该应用使用你的账号。'
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {showSkeleton ? (
            <div className="space-y-2">
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
              <div className="bg-muted rounded-lg p-4 text-sm">
                <p className="text-muted-foreground text-xs">登录为</p>
                <p className="font-medium">{data.email}</p>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">授权后它可以：</p>
                <ul className="space-y-1.5 text-sm">
                  {(data.scopes?.length ? data.scopes : ['读取你的账号标识（uid）', '读取你的邮箱地址']).map((s) => (
                    <li key={s} className="flex items-start gap-2">
                      <CheckCircle2 className="mt-0.5 size-4 text-success" />
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <Separator />
              <Alert variant="warning">
                <ShieldAlert className="size-4" />
                <AlertDescription>
                  完成后会回到 <span className="font-mono">{data.redirectHost}</span>，那不是本站域名。确认这个域名是你信任的。
                </AlertDescription>
              </Alert>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Button variant="outline" onClick={() => submitDecision(data.tx, 'deny')}>
                  拒绝并返回
                </Button>
                <Button onClick={() => submitDecision(data.tx, 'allow')}>继续授权</Button>
              </div>
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
