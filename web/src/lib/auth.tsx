import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, setReauthHandler } from './api'
import type { WebSession } from './types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { reauthWithPasskey } from './webauthn'

type AuthState = {
  session: WebSession | null
  loading: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = React.createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      try {
        return await api.post<WebSession>('/web/session', {}, { reauth: false })
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return null
        throw err
      }
    },
    retry: false,
    staleTime: 30_000,
  })

  // 定期轮换 cookie 会话；失败不打扰用户，401 由页面守卫处理。
  React.useEffect(() => {
    if (!query.data) return
    const rotate = () => {
      void api.post('/web/session/refresh', {}, { reauth: false }).catch(() => {})
    }
    const timer = window.setInterval(rotate, 30 * 60 * 1000)
    const onVisible = () => {
      if (!document.hidden) rotate()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [query.data])

  const refresh = React.useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['session'] })
  }, [qc])

  const logout = React.useCallback(async () => {
    try {
      await api.post('/web/logout', {})
    } finally {
      qc.setQueryData(['session'], null)
      qc.clear()
    }
  }, [qc])

  return (
    <AuthContext.Provider
      value={{ session: query.data ?? null, loading: query.isLoading, refresh, logout }}
    >
      <ReauthProvider>{children}</ReauthProvider>
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = React.useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}

const ReauthContext = React.createContext<() => Promise<boolean>>(async () => false)

export function useReauth() {
  return React.useContext(ReauthContext)
}

function ReauthProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const resolver = React.useRef<((ok: boolean) => void) | null>(null)
  const pending = React.useRef<Promise<boolean> | null>(null)

  const request = React.useCallback(() => {
    if (pending.current) return pending.current
    pending.current = new Promise<boolean>((resolve) => {
      resolver.current = resolve
      setOpen(true)
    })
    return pending.current
  }, [])

  React.useEffect(() => {
    setReauthHandler(request)
    return () => setReauthHandler(null)
  }, [request])

  const close = (ok: boolean) => {
    setOpen(false)
    const resolve = resolver.current
    resolver.current = null
    pending.current = null
    resolve?.(ok)
  }

  return (
    <ReauthContext.Provider value={request}>
      {children}
      <ReauthDialog open={open} onClose={close} />
    </ReauthContext.Provider>
  )
}

function ReauthDialog({ open, onClose }: { open: boolean; onClose: (ok: boolean) => void }) {
  const { session } = useAuth()
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [mode, setMode] = React.useState<'code' | 'recovery'>('code')
  const [value, setValue] = React.useState('')
  const [password, setPassword] = React.useState('')

  React.useEffect(() => {
    if (!open) return
    setError('')
    setValue('')
    setPassword('')
    setMode('code')
  }, [open])

  const hasPasskey = !!session && session.passkeyCount > 0
  const hasTotp = !!session?.totpEnabled

  async function submitCode(e: React.FormEvent) {
    e.preventDefault()
    if (!value.trim()) return
    setBusy(true)
    setError('')
    try {
      await api.post(
        '/web/reauth',
        mode === 'code' ? { totpCode: value.trim() } : { recoveryCode: value.trim() },
        { reauth: false },
      )
      onClose(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault()
    if (!password) return
    setBusy(true)
    setError('')
    try {
      await api.post('/web/reauth', { password }, { reauth: false })
      onClose(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  async function byPasskey() {
    setBusy(true)
    setError('')
    try {
      await reauthWithPasskey()
      onClose(true)
    } catch (err) {
      const name = (err as DOMException)?.name
      if (name !== 'NotAllowedError' && name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'Passkey 验证失败，请重试')
      }
    } finally {
      setBusy(false)
    }
  }

  const onlyPassword = !hasPasskey && !hasTotp

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重新验证身份</DialogTitle>
          <DialogDescription>敏感操作需要确认是你本人。验证通过后 2 小时内不再重复询问。</DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {hasPasskey && (
          <Button type="button" onClick={byPasskey} disabled={busy} className="w-full">
            {busy ? <Loader2 className="animate-spin" /> : <KeyRound />} 使用 Passkey 验证
          </Button>
        )}

        {hasTotp && (
          <form onSubmit={submitCode} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="reauth-code">{mode === 'code' ? '两步验证码' : '恢复码'}</Label>
              <Input
                id="reauth-code"
                autoFocus={!hasPasskey}
                inputMode={mode === 'code' ? 'numeric' : 'text'}
                autoComplete="one-time-code"
                maxLength={mode === 'code' ? 6 : 32}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={mode === 'code' ? '输入验证器上的 6 位验证码' : '输入一枚未使用的恢复码'}
              />
            </div>
            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-xs"
                onClick={() => {
                  setMode(mode === 'code' ? 'recovery' : 'code')
                  setValue('')
                }}
              >
                {mode === 'code' ? '使用恢复码' : '改用两步验证码'}
              </Button>
              <Button type="submit" disabled={busy || !value.trim()}>
                {busy && <Loader2 className="animate-spin" />} 验证
              </Button>
            </div>
          </form>
        )}

        {onlyPassword && (
          <form onSubmit={submitPassword} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="reauth-pw">当前密码</Label>
              <Input
                id="reauth-pw"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onClose(false)}>
                取消
              </Button>
              <Button type="submit" disabled={busy || !password}>
                {busy && <Loader2 className="animate-spin" />} 验证
              </Button>
            </DialogFooter>
          </form>
        )}

        {(hasPasskey || hasTotp) && (
          <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <ShieldCheck className="size-3.5" />
            验证方式来自你已绑定的登录凭据
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
