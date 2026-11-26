import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { CheckCircle2, Loader2, ShieldAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { AuthLayout } from '@/components/layout/app-shell'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { useLoadingSkeleton } from '@/lib/use-loading'

export default function DeleteCancelPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [busy, setBusy] = React.useState(false)
  const [done, setDone] = React.useState(false)
  const [error, setError] = React.useState('')

  const info = useQuery({
    queryKey: ['delete-cancel-info', token],
    queryFn: () => api.get<{ email: string }>(`/web/delete-cancel/info?token=${encodeURIComponent(token)}`, { reauth: false }),
    retry: false,
    enabled: !!token,
  })
  const infoSkeleton = useLoadingSkeleton(info.isLoading)

  async function cancel() {
    setBusy(true)
    setError('')
    try {
      await api.post('/web/delete-cancel', { token }, { reauth: false })
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '撤销失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">撤销注销申请</CardTitle>
          <CardDescription>
            {done
              ? '注销申请已撤销，账号会保留。'
              : info.data
                ? `确认保留 ${info.data.email} 这个账号？`
                : '确认撤销这次注销申请。'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!token ? (
            <Alert variant="destructive">
              <AlertDescription>链接缺少凭证，请从注销确认邮件重新打开。</AlertDescription>
            </Alert>
          ) : done ? (
            <div className="space-y-3">
              <Alert variant="success">
                <CheckCircle2 className="size-4" />
                <AlertDescription>注销已撤销。你可以继续用原密码登录。</AlertDescription>
              </Alert>
              <Button className="w-full" asChild>
                <Link to="/web/login">去登录</Link>
              </Button>
            </div>
          ) : infoSkeleton ? (
            <Skeleton className="h-16 w-full" />
          ) : info.error ? (
            <div className="space-y-3">
              <Alert variant="destructive">
                <ShieldAlert className="size-4" />
                <AlertDescription>{info.error.message}</AlertDescription>
              </Alert>
              <Button variant="outline" className="w-full" asChild>
                <Link to="/web/login">返回登录</Link>
              </Button>
            </div>
          ) : (
            <>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Alert variant="warning">
                <ShieldAlert className="size-4" />
                <AlertDescription>
                  撤销后账号与两个日记 App 的数据都会保留；7 天宽限期过后就不能再撤销了。
                </AlertDescription>
              </Alert>
              <Button className="w-full" onClick={cancel} disabled={busy}>
                {busy && <Loader2 className="animate-spin" />} 保留我的账号
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
