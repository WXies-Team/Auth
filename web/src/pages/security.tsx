import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, Download, Loader2, Printer, RefreshCw, ShieldCheck, ShieldOff, TriangleAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { useTotp } from '@/lib/queries'
import type { TrustedDevice } from '@/lib/types'
import type { TOTPSetup } from '@/lib/types'
import { dateTime, relativeTime } from '@/lib/format'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { OtpInput } from '@/components/ui/otp-input'
import { Progress } from '@/components/ui/progress'
import { ListSkeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { CopyButton } from '@/components/ui/copy-button'
import { Checkbox } from '@/components/ui/checkbox'
import { Separator } from '@/components/ui/separator'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

type CodeAction = 'disable' | 'regenerate' | null

export default function SecurityPage() {
  const qc = useQueryClient()
  const { data, isLoading } = useTotp()
  const trusted = useQuery({
    queryKey: ['trusted-devices'],
    queryFn: () => api.get<TrustedDevice[]>('/api/trusted-devices'),
  })
  const [revokeTrusted, setRevokeTrusted] = React.useState<TrustedDevice | null>(null)
  const [setup, setSetup] = React.useState<TOTPSetup | null>(null)
  const [codes, setCodes] = React.useState<string[] | null>(null)
  const [saved, setSaved] = React.useState(false)
  const [code, setCode] = React.useState('')
  const [action, setAction] = React.useState<CodeAction>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')

  const enabled = !!data?.enabled
  const left = data?.recoveryLeft ?? 0
  const total = data?.recoveryTotal ?? 10

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ['totp'] })
    await qc.invalidateQueries({ queryKey: ['session'] })
  }

  async function startSetup() {
    setError('')
    setBusy(true)
    try {
      const res = await api.post<TOTPSetup>('/api/totp/setup', {})
      setSetup(res)
      setCodes(null)
      setSaved(false)
      setCode('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法开始绑定')
    } finally {
      setBusy(false)
    }
  }

  async function confirmSetup() {
    if (!setup) return
    setError('')
    setBusy(true)
    try {
      const res = await api.post<{ recoveryCodes: string[] }>('/api/totp/enable', { code: code.trim() })
      setCodes(res.recoveryCodes)
      setSetup(null)
      setSaved(false)
      toast.success('两步验证已开启')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证码不正确')
    } finally {
      setBusy(false)
    }
  }

  async function runAction() {
    if (!action) return
    setError('')
    setBusy(true)
    try {
      if (action === 'disable') {
        await api.post('/api/totp/disable', { code: code.trim() })
        toast.success('两步验证已关闭')
      } else {
        const res = await api.post<{ recoveryCodes: string[] }>('/api/totp/regenerate-recovery-codes', {
          code: code.trim(),
        })
        setCodes(res.recoveryCodes)
        setSaved(false)
        toast.success('恢复码已重新生成')
      }
      setAction(null)
      setCode('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  function download() {
    if (!codes) return
    const body = [
      'Auth 两步验证恢复码',
      `生成时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      ...codes,
      '',
      '每枚只能使用一次；用完后可在安全页重新生成。',
    ].join('\n')
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'auth-recovery-codes.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (isLoading) {
    return <div className="h-40 animate-pulse rounded-xl bg-muted" />
  }

  return (
    <div className="space-y-4">
      <PageHeader title="两步验证" description="在密码之外再加一道动态验证码，防止密码泄露后被直接登录。" />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {codes ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              恢复码 <Badge variant="warning">只显示这一次</Badge>
            </CardTitle>
            <CardDescription>
              每枚只能使用一次。请现在保存到密码管理器或打印出来；关闭页面后无法再次查看。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-muted grid grid-cols-2 gap-2 rounded-lg p-4 font-mono text-sm">
              {codes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={download}>
                <Download /> 下载 txt
              </Button>
              <Button variant="outline" onClick={() => window.print()}>
                <Printer /> 打印
              </Button>
              <Button variant="outline" onClick={() => void navigator.clipboard.writeText(codes.join('\n')).then(() => toast.success('已复制'))}>
                复制全部
              </Button>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={saved} onCheckedChange={(v) => setSaved(v === true)} className="mt-0.5" />
              <span>我已把恢复码保存到安全的地方，知道它们不能再次查看。</span>
            </label>
            <Button disabled={!saved} onClick={() => { setCodes(null); setSaved(false) }}>
              完成
            </Button>
          </CardContent>
        </Card>
      ) : setup ? (
        <Card>
          <CardHeader>
            <CardTitle>绑定验证器</CardTitle>
            <CardDescription>用 Google Authenticator、1Password 等扫码，或手动输入密钥。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <img src={setup.qrPng} alt="两步验证二维码" className="size-40 rounded-lg border bg-white p-2" />
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-sm font-medium">手动输入密钥</p>
                <div className="flex items-center gap-1">
                  <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-2 py-1.5 font-mono text-xs">{setup.secret}</code>
                  <CopyButton value={setup.secret} />
                </div>
                <p className="text-muted-foreground text-xs">也可以复制 otpauth:// 链接到验证器。</p>
                <CopyButton value={setup.otpauthUri} label="复制链接" size="sm" />
              </div>
            </div>
            <Separator />
            <div className="space-y-1.5">
              <Label htmlFor="setup-code">输入验证器上的 6 位验证码</Label>
              <OtpInput id="setup-code" value={code} onChange={setCode} maxLength={6} className="max-w-56" />
            </div>
            <div className="flex gap-2">
              <Button onClick={confirmSetup} disabled={busy || code.length !== 6}>
                {busy && <Loader2 className="animate-spin" />} 验证并开启
              </Button>
              <Button variant="outline" onClick={() => setSetup(null)} disabled={busy}>
                取消
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : enabled ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              已开启 <Badge variant="success"><CheckCircle2 className="size-3" /> 两步验证</Badge>
            </CardTitle>
            <CardDescription>
              开启于 {dateTime(data?.createdAt)}（{relativeTime(data?.createdAt)}）。登录时除密码外还要输入动态验证码。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>恢复码剩余</span>
                <span className="text-muted-foreground tabular-nums">
                  {left} / {total}
                </span>
              </div>
              <Progress value={total ? (left / total) * 100 : 0} aria-label="恢复码剩余" />
              {left === 0 && (
                <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <TriangleAlert className="size-3.5" /> 恢复码已用尽，建议立即重新生成。
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => { setAction('regenerate'); setCode(''); setError('') }}>
                <RefreshCw /> 重新生成恢复码
              </Button>
              <Button variant="outline" className="text-destructive" onClick={() => { setAction('disable'); setCode(''); setError('') }}>
                <ShieldOff /> 关闭两步验证
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              未开启 <Badge variant="warning">建议开启</Badge>
            </CardTitle>
            <CardDescription>绑定后，即使密码泄露，攻击者也需要你的验证器才能登录。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="text-muted-foreground space-y-1 text-sm">
              <li>· 支持 Google Authenticator、1Password、Bitwarden 等 TOTP 应用。</li>
              <li>· 开启时一次性发放 10 枚恢复码，忘记带手机时使用。</li>
              <li>· 关闭或重生成恢复码需要验证当前动态码或一枚恢复码。</li>
            </ul>
            <Button onClick={startSetup} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />} 开始绑定
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>可信设备</CardTitle>
          <CardDescription>
            在这些设备上登录时跳过两步验证，30 天后失效。换浏览器或清除 cookie 后也会失效。
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {trusted.isLoading ? (
            <ListSkeleton rows={1} action />
          ) : (trusted.data ?? []).length === 0 ? (
            <p className="text-muted-foreground p-6 text-sm">还没有信任的设备。下次两步验证时勾选「信任此设备」即可。</p>
          ) : (
            <ul className="divide-y">
              {(trusted.data ?? []).map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="bg-muted flex size-9 items-center justify-center rounded-md">
                    <ShieldCheck className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {d.label || '未知设备'}
                      {d.current && <Badge variant="secondary">本机</Badge>}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      添加于 {dateTime(d.createdAt)} · 最近使用 {relativeTime(d.lastUsedAt)} · 有效至 {dateTime(d.expiresAt)}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setRevokeTrusted(d)}>
                    撤销
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!revokeTrusted}
        onOpenChange={(v) => !v && setRevokeTrusted(null)}
        title="撤销这台可信设备？"
        description="撤销后，这台设备下次登录会重新要求两步验证。"
        confirmLabel="撤销"
        destructive
        busy={busy}
        onConfirm={async () => {
          if (!revokeTrusted) return
          setBusy(true)
          try {
            await api.del(`/api/trusted-devices/${revokeTrusted.id}`)
            toast.success('已撤销')
            setRevokeTrusted(null)
            await trusted.refetch()
          } catch (err) {
            toast.error(err instanceof Error ? err.message : '撤销失败')
          } finally {
            setBusy(false)
          }
        }}
      />

      <Dialog open={!!action} onOpenChange={(v) => !v && setAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{action === 'disable' ? '关闭两步验证？' : '重新生成恢复码？'}</DialogTitle>
            <DialogDescription>
              {action === 'disable'
                ? '关闭后账号只剩密码一道防线。需要验证当前动态码或一枚恢复码。'
                : '旧恢复码会立即全部作废，新的一组只在关闭弹窗后显示一次。'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="action-code">动态验证码或恢复码</Label>
            <Input
              id="action-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6 位验证码或恢复码"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAction(null)} disabled={busy}>
              取消
            </Button>
            <Button
              variant={action === 'disable' ? 'destructive' : 'default'}
              onClick={runAction}
              disabled={busy || !code.trim()}
            >
              {busy && <Loader2 className="animate-spin" />} 确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
