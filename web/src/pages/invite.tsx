import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Loader2, MailWarning } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import type { InviteInfo } from '@/lib/types'
import { AuthLayout } from '@/components/layout/app-shell'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { useLoadingSkeleton } from '@/lib/use-loading'

export default function InvitePage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const navigate = useNavigate()
  const { refresh } = useAuth()
  const [password, setPassword] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [nickname, setNickname] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')

  const info = useQuery({
    queryKey: ['invite-info', token],
    queryFn: () => api.get<InviteInfo>(`/web/invite/info?token=${encodeURIComponent(token)}`),
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
      await api.post('/web/invite', { token, password, nickname: nickname.trim() })
      await refresh()
      toast.success('账号已开通')
      navigate('/web/console', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : '接受邀请失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">接受邀请</CardTitle>
          <CardDescription>
            {infoSkeleton ? (
              <span className="block space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </span>
            ) : info.data ? (
              <>
                为 <span className="text-foreground font-medium">{info.data.email}</span> 设置密码
                {info.data.appName ? `，开通 ${info.data.appName} 的访问权限。` : '。'}
              </>
            ) : (
              '设置密码后即可登录。'
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!token ? (
            <Alert variant="destructive">
              <AlertDescription>邀请链接缺少凭证，请从邮件重新打开。</AlertDescription>
            </Alert>
          ) : infoSkeleton ? (
            // 与真实表单同构（4 个字段组 + 按钮 + 说明），高度对得上，加载完不跳。
            <div aria-busy="true" className="space-y-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ))}
              <Skeleton className="h-9 w-full" />
              <Skeleton className="mx-auto h-3 w-2/3" />
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
                <Label htmlFor="invite-email">邮箱</Label>
                <Input id="invite-email" value={info.data?.email ?? ''} readOnly disabled />
              </div>
              <div className="space-y-2">
                <Label htmlFor="invite-pw">设置密码</Label>
                <PasswordInput id="invite-pw" autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="invite-pw2">确认密码</Label>
                <PasswordInput id="invite-pw2" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="invite-nick">昵称（可选）</Label>
                <Input id="invite-nick" value={nickname} maxLength={64} onChange={(e) => setNickname(e.target.value)} />
              </div>
              <Button type="submit" className="w-full" disabled={busy || password.length < 8}>
                {busy && <Loader2 className="animate-spin" />} 创建账号并登录
              </Button>
              <p className="text-muted-foreground text-xs">邀请链接 24 小时内有效，只能使用一次。</p>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
