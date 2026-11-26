import * as React from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Fingerprint, Loader2, Mail } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { loginWithPasskey } from '@/lib/webauthn'
import { browserSupportsWebAuthnAutofill, startAuthentication } from '@simplewebauthn/browser'
import type { LoginResponse } from '@/lib/types'
import { AuthLayout } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { OtpInput } from '@/components/ui/otp-input'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

type Tab = 'password' | 'code' | 'reset'
type Step = 'credentials' | 'totp' | 'force-pw'
type SecondFactor = 'code' | 'recovery' | 'email'

function safeNext(raw: string | null): string {
  // 只允许站内控制台/授权两类路径：挡住 //evil、/\evil 与任意站内跳转。
  if (!raw || !/^\/(web|oauth)\//.test(raw) || raw.startsWith('//') || raw.startsWith('/\\')) {
    return '/web/console'
  }
  return raw
}

export default function LoginPage() {
  const { session, loading, refresh } = useAuth()
  const [params] = useSearchParams()
  const tx = params.get('tx')
  const next = tx ? `/oauth/resume?tx=${encodeURIComponent(tx)}` : safeNext(params.get('next'))

  const [tab, setTab] = React.useState<Tab>('password')
  const [step, setStep] = React.useState<Step>('credentials')
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [code, setCode] = React.useState('')
  const [newPassword, setNewPassword] = React.useState('')
  const [confirmPassword, setConfirmPassword] = React.useState('')
  const [pending, setPending] = React.useState<{ loginToken: string; methods: string[] } | null>(null)
  const [factor, setFactor] = React.useState<SecondFactor>('code')
  const [trustDevice, setTrustDevice] = React.useState(false)
  const stepRef = React.useRef(step)
  const tabRef = React.useRef(tab)
  stepRef.current = step
  tabRef.current = tab
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')

  // 条件式 Passkey：浏览器把本机 passkey 填进邮箱框的自动填充建议，
  // 用户零点击选中即登录；不支持/没有 passkey 时静默跳过。
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!(await browserSupportsWebAuthnAutofill())) return
      try {
        const opts = await api.post<{ publicKey: unknown; ceremonyId: number }>('/webauthn/login/options', {}, { reauth: false })
        const response = await startAuthentication({ optionsJSON: opts.publicKey as never, useBrowserAutofill: true })
        if (cancelled || stepRef.current !== 'credentials' || tabRef.current !== 'password') return
        const res = await api.post<LoginResponse>('/webauthn/login/finish', {
          ceremonyId: opts.ceremonyId,
          response,
        })
        if (res.mustChangePassword) setStep('force-pw')
        else finish(res)
      } catch {
        // 用户取消/浏览器不支持条件式 UI：按钮仍可用
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!loading && session) return <Navigate to={next} replace />

  function finish(res: LoginResponse) {
    if (res.deletePendingCancelled) toast.success('已撤销待执行的注销申请')
    void refresh().finally(() => window.location.assign(next))
  }

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : '操作失败，请重试')
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const res = await api.post<LoginResponse>(
        '/web/login/password',
        { email: email.trim(), password },
        { reauth: false },
      )
      if (res.status === '2fa_required' && res.loginToken) {
        setPending({ loginToken: res.loginToken, methods: res.methods ?? [] })
        setFactor('code')
        setStep('totp')
        return
      }
      if (res.mustChangePassword) {
        setStep('force-pw')
        return
      }
      finish(res)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function submitSecondFactor(e: React.FormEvent) {
    e.preventDefault()
    if (!pending) return
    setError('')
    setBusy(true)
    try {
      const body: Record<string, string | boolean> = { loginToken: pending.loginToken, trustDevice }
      if (factor === 'recovery') body.recoveryCode = code.trim()
      else if (factor === 'email') body.emailCode = code.trim()
      else body.code = code.trim()
      const res = await api.post<LoginResponse>('/web/login/totp', body, { reauth: false })
      if (res.mustChangePassword) {
        setStep('force-pw')
        return
      }
      finish(res)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function submitEmailCode(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const res = await api.post<LoginResponse>(
        '/web/login/email-code',
        { email: email.trim(), code: code.trim() },
        { reauth: false },
      )
      if (res.mustChangePassword) {
        setStep('force-pw')
        return
      }
      finish(res)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await api.post('/auth/reset-password', {
        email: email.trim(),
        code: code.trim(),
        password: newPassword,
      })
      setNotice('密码已重置，请用新密码登录')
      setTab('password')
      setCode('')
      setPassword('')
      setNewPassword('')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function submitForcePassword(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (newPassword.length < 8) {
      setError('新密码至少 8 位')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致')
      return
    }
    setBusy(true)
    try {
      await api.post('/auth/change-password', { oldPassword: password, newPassword })
      toast.success('密码已更新')
      const res = await api.post<LoginResponse>('/web/session', {}, { reauth: false }).catch(() => null)
      if (res) await refresh()
      window.location.assign(next)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function sendCode(purpose: 'login' | 'login_2fa' | 'reset') {
    if (!email.trim()) {
      setError('请先填写邮箱')
      return
    }
    setError('')
    try {
      await api.post('/auth/send-code', { email: email.trim(), purpose })
      setNotice('验证码已发送，5 分钟内有效；没收到可查看垃圾箱')
      window.setTimeout(() => setNotice(''), 6000)
    } catch (err) {
      fail(err)
    }
  }

  async function byPasskey() {
    setError('')
    setBusy(true)
    try {
      const res = await loginWithPasskey()
      if (res.mustChangePassword) {
        setStep('force-pw')
        return
      }
      finish(res)
    } catch (err) {
      const name = (err as DOMException)?.name
      if (name !== 'NotAllowedError' && name !== 'AbortError') fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <Card>
        <CardHeader>
          <CardTitle asChild className="text-xl">
            <h1>{step === 'totp' ? '两步验证' : step === 'force-pw' ? '设置新密码' : '登录 Auth'}</h1>
          </CardTitle>
          <CardDescription>
            {step === 'totp'
              ? '输入验证器上的 6 位验证码，或改用恢复码 / 邮箱验证码。'
              : step === 'force-pw'
                ? '管理员要求你设置新密码后才能继续。'
                : '使用密码、邮箱验证码或 Passkey 登录。'}
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

          {step === 'totp' && (
            <form onSubmit={submitSecondFactor} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="otp">{factor === 'recovery' ? '恢复码' : factor === 'email' ? '邮箱验证码' : '两步验证码'}</Label>
                <OtpInput
                  id="otp"
                  autoFocus
                  value={code}
                  onChange={setCode}
                  length={factor === 'recovery' ? 32 : 6}
                  numeric={factor !== 'recovery'}
                  className={factor === 'recovery' ? 'tracking-normal text-base' : undefined}
                />
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {factor !== 'code' && (
                  <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => { setFactor('code'); setCode('') }}>
                    使用验证器验证码
                  </Button>
                )}
                {factor !== 'recovery' && (
                  <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => { setFactor('recovery'); setCode('') }}>
                    使用恢复码
                  </Button>
                )}
                {factor !== 'email' && (
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 text-xs"
                    onClick={() => {
                      setFactor('email')
                      setCode('')
                      void sendCode('login_2fa')
                    }}
                  >
                    发送邮箱验证码
                  </Button>
                )}
              </div>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={trustDevice}
                  onCheckedChange={(v) => setTrustDevice(v === true)}
                  className="mt-0.5"
                />
                <span>
                  在此设备上信任 30 天
                  <span className="text-muted-foreground block text-xs">下次登录跳过两步验证；换浏览器或清除 cookie 后失效。</span>
                </span>
              </label>
              <Button type="submit" className="w-full" disabled={busy || !code.trim()}>
                {busy && <Loader2 className="animate-spin" />} 验证并登录
              </Button>
              <Button type="button" variant="ghost" className="w-full" onClick={() => { setStep('credentials'); setPending(null); setCode('') }}>
                返回
              </Button>
            </form>
          )}

          {step === 'force-pw' && (
            <form onSubmit={submitForcePassword} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="new-pw">新密码</Label>
                <PasswordInput id="new-pw" autoFocus autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-pw2">确认新密码</Label>
                <PasswordInput id="new-pw2" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
              </div>
              <p className="text-muted-foreground text-xs">至少 8 位。改密后其它设备会被登出。</p>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy && <Loader2 className="animate-spin" />} 保存并继续
              </Button>
            </form>
          )}

          {step === 'credentials' && (
            <>
              <Tabs value={tab} onValueChange={(v) => { setTab(v as Tab); setError(''); setNotice('') }}>
                <TabsList className="w-full">
                  <TabsTrigger value="password">密码</TabsTrigger>
                  <TabsTrigger value="code">邮箱验证码</TabsTrigger>
                  <TabsTrigger value="reset">找回密码</TabsTrigger>
                </TabsList>

                <TabsContent value="password">
                  <form onSubmit={submitPassword} className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="email">邮箱</Label>
                      <Input id="email" type="email" autoComplete="username webauthn" required value={email} onChange={(e) => setEmail(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="password">密码</Label>
                      <PasswordInput id="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                    </div>
                    <Button type="submit" className="w-full" disabled={busy}>
                      {busy && <Loader2 className="animate-spin" />} 登录
                    </Button>
                  </form>
                </TabsContent>

                <TabsContent value="code">
                  <form onSubmit={submitEmailCode} className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="code-email">邮箱</Label>
                      <Input id="code-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="code">验证码</Label>
                      <div className="flex gap-2">
                        <OtpInput id="code" value={code} onChange={setCode} className="flex-1" />
                        <Button type="button" variant="outline" onClick={() => void sendCode('login')}>
                          获取验证码
                        </Button>
                      </div>
                    </div>
                    <Button type="submit" className="w-full" disabled={busy || !code}>
                      {busy && <Loader2 className="animate-spin" />} 登录
                    </Button>
                  </form>
                </TabsContent>

                <TabsContent value="reset">
                  <form onSubmit={submitReset} className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="reset-email">邮箱</Label>
                      <Input id="reset-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="reset-code">验证码</Label>
                      <div className="flex gap-2">
                        <OtpInput id="reset-code" value={code} onChange={setCode} className="flex-1" />
                        <Button type="button" variant="outline" onClick={() => void sendCode('reset')}>
                          获取验证码
                        </Button>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="reset-pw">新密码</Label>
                      <PasswordInput id="reset-pw" autoComplete="new-password" required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                    </div>
                    <Button type="submit" className="w-full" disabled={busy || !code || newPassword.length < 8}>
                      {busy && <Loader2 className="animate-spin" />} 重置密码
                    </Button>
                  </form>
                </TabsContent>
              </Tabs>

              <div className="relative">
                <Separator />
                <span className="bg-card text-muted-foreground absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 px-2 text-xs">
                  或
                </span>
              </div>

              <Button type="button" variant="outline" className="w-full" onClick={byPasskey} disabled={busy || !window.PublicKeyCredential}>
                <Fingerprint /> 使用 Passkey 登录
              </Button>

              <p className="text-muted-foreground flex items-center justify-center gap-1.5 text-center text-xs">
                <Mail className="size-3.5" />
                没有账号？联系管理员获取邀请链接。
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
