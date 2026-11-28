import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Loader2, MailWarning } from 'lucide-react'
import { api } from '@/lib/api'
import type { SetupInfo } from '@/lib/types'
import { AuthLayout } from '@/components/layout/app-shell'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { useLoadingSkeleton } from '@/lib/use-loading'

export default function SetupPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const navigate = useNavigate()
  const [password, setPassword] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')

  const info = useQuery({
    queryKey: ['setup-info', token],
    queryFn: () => api.get<SetupInfo>(`/web/setup-password/info?token=${encodeURIComponent(token)}`),
    retry: false,
    enabled: !!token,
  })
  const infoSkeleton = useLoadingSkeleton(info.isLoading)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password.length < 8) return setError('密码至少 8 位')
    if (password !== confirm) return setError('两次输入的密码不一致')
    setBusy(true)
    try {
      await api.post('/web/setup-password', { token, password })
      toast.success('密码已设置，请用新密码登录')
      navigate('/web/login', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : '设置失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">设置新密码</CardTitle>
          <CardDescription>
            {info.data ? `为 ${info.data.email} 设置新密码，完成后回到登录页。` : '设置新密码后回到登录页。'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!token ? (
            <Alert variant="destructive">
              <AlertDescription>链接缺少凭证，请从邮件重新打开。</AlertDescription>
            </Alert>
          ) : infoSkeleton ? (
            <div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : info.error ? (
            <div className="space-y-3">
              <Alert variant="destructive">
                <MailWarning className="size-4" />
                <AlertDescription>{info.error.message}</AlertDescription>
              </Alert>
              <Button variant="outline" className="w-full" onClick={() => navigate('/web/login')}>
                返回登录
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <div className="space-y-2">
                <Label htmlFor="setup-email">邮箱</Label>
                <Input id="setup-email" value={info.data?.email ?? ''} readOnly disabled />
              </div>
              <div className="space-y-2">
                <Label htmlFor="setup-pw">新密码</Label>
                <PasswordInput id="setup-pw" autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="setup-pw2">确认新密码</Label>
                <PasswordInput id="setup-pw2" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </div>
              <Button type="submit" className="w-full" disabled={busy || password.length < 8}>
                {busy && <Loader2 className="animate-spin" />} 设置密码
              </Button>
              <p className="text-muted-foreground text-xs">链接一次性有效，设置成功后需要重新登录。</p>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
