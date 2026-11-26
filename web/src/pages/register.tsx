import * as React from 'react'
import { Link, Navigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { AuthLayout } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { OtpInput } from '@/components/ui/otp-input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { useI18n } from '@/lib/i18n'

// 自助注册页（默认关闭）：只有配置中心 allow_self_register=1 时后端才接受。
// 页面本身也先查一次开关——关闭时直接显示「邀请制」说明，不让人白填。
export default function RegisterPage() {
  const { t } = useI18n()
  const { session, loading, refresh } = useAuth()
  const [enabled, setEnabled] = React.useState<boolean | null>(null)
  const [email, setEmail] = React.useState('')
  const [code, setCode] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')

  React.useEffect(() => {
    void api
      .get<{ enabled: boolean }>('/web/register/config', { reauth: false })
      .then((r) => setEnabled(r.enabled))
      .catch(() => setEnabled(false))
  }, [])

  if (!loading && session) return <Navigate to="/web/console" replace />

  async function sendCode() {
    if (!email.trim()) {
      setError('请先填写邮箱')
      return
    }
    setError('')
    try {
      await api.post('/web/register/send-code', { email: email.trim() }, { reauth: false })
      setNotice('验证码已发送，5 分钟内有效；没收到可查看垃圾箱')
      window.setTimeout(() => setNotice(''), 6000)
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败，请重试')
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password.length < 8) {
      setError('密码至少 8 位')
      return
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy(true)
    try {
      await api.post('/web/register', { email: email.trim(), code: code.trim(), password }, { reauth: false })
      await refresh()
      window.location.assign('/web/console')
    } catch (err) {
      setError(err instanceof Error ? err.message : '注册失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle asChild className="text-xl">
            <h1>{t('register.title')}</h1>
          </CardTitle>
          <CardDescription>
            {enabled === false ? t('register.closed') : t('register.subtitle')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {notice && (
            <Alert variant="success">
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}

          {enabled === false ? (
            <Button asChild className="w-full">
              <Link to="/web/login">{t('register.back')}</Link>
            </Button>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="reg-email">邮箱</Label>
                <Input
                  id="reg-email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg-code">验证码</Label>
                <div className="flex gap-2">
                  <OtpInput id="reg-code" value={code} onChange={setCode} className="flex-1" />
                  <Button type="button" variant="outline" onClick={() => void sendCode()} disabled={enabled === null}>
                    获取验证码
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg-pw">密码</Label>
                <PasswordInput
                  id="reg-pw"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg-pw2">确认密码</Label>
                <PasswordInput
                  id="reg-pw2"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
              <p className="text-muted-foreground text-xs">至少 8 位；已知泄露的密码会被拒绝。</p>
              <Button type="submit" className="w-full" disabled={busy || enabled === null || !code}>
                {busy && <Loader2 className="animate-spin" />} {t('register.submit')}
              </Button>
            </form>
          )}

          <Separator />
          <p className="text-muted-foreground text-center text-xs">
            {t('register.hasAccount')}<Link to="/web/login" className="text-foreground underline-offset-4 hover:underline">{t('register.login')}</Link>
          </p>
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
