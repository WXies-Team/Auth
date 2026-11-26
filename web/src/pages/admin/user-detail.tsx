import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Ban,
  Fingerprint,
  KeyRound,
  Loader2,
  Mail,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  UserCog,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { APPS } from '@/lib/apps'
import type { AdminUserDetail, AuditRow, BanInfo, Page, Passkey } from '@/lib/types'
import { dateOnly, dateTime, relativeTime } from '@/lib/format'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CopyButton } from '@/components/ui/copy-button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { initials } from '@/lib/format'

type DialogKind = 'password' | 'email' | 'ban' | 'mfa' | 'profile' | null

export default function AdminUserDetailPage() {
  const { uid = '' } = useParams()
  const qc = useQueryClient()
  const [dialog, setDialog] = React.useState<DialogKind>(null)
  const [busy, setBusy] = React.useState(false)
  const [tempPassword, setTempPassword] = React.useState('')
  const [pendingRole, setPendingRole] = React.useState<string | null>(null)
  const { session } = useAuth()

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['admin-user', uid],
    queryFn: () => api.get<AdminUserDetail>(`/admin/users/${uid}`),
    enabled: !!uid,
  })

  const audit = useQuery({
    queryKey: ['admin-user-audit', uid],
    queryFn: () => api.get<Page<AuditRow>>(`/admin/audit?target=${uid}&limit=20&offset=0`),
    enabled: !!uid,
  })

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ['admin-user', uid] })
    await qc.invalidateQueries({ queryKey: ['admin-user-audit', uid] })
  }

  async function setRole(role: string) {
    if (!data || role === data.role) return
    setBusy(true)
    try {
      await api.post(`/admin/users/${uid}/role`, { role })
      toast.success('角色已更新')
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '修改失败')
    } finally {
      setBusy(false)
    }
  }

  async function kickAll() {
    setBusy(true)
    try {
      await api.post(`/admin/users/${uid}/revoke-sessions`, {})
      toast.success('已吊销该用户全部会话')
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  async function kickSession(sid: string) {
    try {
      await api.del(`/admin/sessions/${sid}`)
      toast.success('会话已吊销')
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    }
  }

  async function unban(b: BanInfo) {
    try {
      await api.del(`/admin/users/${uid}/ban`, { app: b.app })
      toast.success('已解除封禁')
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    }
  }

  async function resetMfa() {
    setBusy(true)
    try {
      await api.post(`/admin/users/${uid}/mfa-reset`, {})
      toast.success('已重置两步验证与 Passkey，并吊销全部会话')
      setDialog(null)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  async function resetProfile(avatar: boolean, nickname: boolean) {
    setBusy(true)
    try {
      await api.post(`/admin/users/${uid}/profile-reset`, { avatar, nickname })
      toast.success('资料已重置')
      setDialog(null)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link to="/web/admin">
          <ArrowLeft /> 返回用户列表
        </Link>
      </Button>

      <PageHeader
        title={data.email}
        description={`uid ${data.uid} · 注册于 ${dateOnly(data.createdAt)}`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              <RefreshCw /> 刷新
            </Button>
            <Button variant="outline" size="sm" onClick={() => setDialog('email')}>
              <Mail /> 改邮箱
            </Button>
            <Button variant="outline" size="sm" onClick={() => setDialog('password')}>
              <KeyRound /> 重置密码
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDialog('mfa')}
              disabled={data.isRoot && !session?.isRoot}
            >
              <ShieldOff /> 重置 MFA
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>身份与状态</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-4">
              <Avatar className="size-14">
                <AvatarImage src={data.avatarImage ? `data:image/jpeg;base64,${data.avatarImage}` : undefined} alt="" />
                <AvatarFallback>{initials(data.nickname || data.email)}</AvatarFallback>
              </Avatar>
              <div>
                <p className="font-medium">{data.nickname || data.email.split('@')[0]}</p>
                <p className="text-muted-foreground text-sm">{data.email}</p>
              </div>
              <div className="flex-1" />
              {data.isRoot && <Badge>根管理员</Badge>}
              {data.ban ? <Badge variant="destructive">已封禁</Badge> : <Badge variant="success">正常</Badge>}
            </div>
            <Separator />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>角色</Label>
                <div className="flex gap-2">
                  <Select
                    aria-label="角色"
                    value={pendingRole ?? data.role}
                    onChange={(e) => setPendingRole(e.target.value)}
                    disabled={busy || session?.uid === data.uid || (data.isRoot && !session?.isRoot)}
                  >
                    <option value="user">普通用户</option>
                    <option value="admin">项目管理员</option>
                    <option value="super">平台管理员</option>
                  </Select>
                </div>
                <p className="text-muted-foreground text-xs">不能修改自己的角色；super 仅根管理员可任命。</p>
              </div>
              <div className="space-y-1.5">
                <Label>登录方式</Label>
                <div className="flex flex-wrap gap-2 text-sm">
                  <Badge variant={data.hasPassword ? 'secondary' : 'outline'}>
                    {data.hasPassword ? '密码已设置' : '无密码'}
                  </Badge>
                  <Badge variant={data.totpEnabled ? 'secondary' : 'outline'}>
                    {data.totpEnabled ? '两步验证' : '无两步验证'}
                  </Badge>
                  <Badge variant="outline">{data.passkeyCount} 把 Passkey</Badge>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label>项目授权</Label>
              <div className="flex flex-wrap gap-2">
                {data.scopes.length === 0 ? (
                  <span className="text-muted-foreground text-sm">无项目管理员授权</span>
                ) : (
                  data.scopes.map((s) => <Badge key={s} variant="secondary">{s}</Badge>)
                )}
              </div>
            </div>
            {data.bans.length > 0 && (
              <div className="space-y-2">
                <Label>封禁</Label>
                {data.bans.map((b) => (
                  <div key={b.app} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                    <Badge variant="destructive">{b.app === '*' ? '全站' : b.app}</Badge>
                    <span className="text-muted-foreground">
                      {b.until ? `至 ${dateTime(b.until)}` : '永久'}
                      {b.reason ? ` · ${b.reason}` : ''}
                    </span>
                    <div className="flex-1" />
                    <Button variant="ghost" size="sm" onClick={() => void unban(b)}>
                      解除
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>危险操作</CardTitle>
            <CardDescription>这些操作会影响该用户的登录与数据。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button variant="outline" className="w-full justify-start" onClick={() => setDialog('ban')}>
              <Ban /> 封禁账号
            </Button>
            <Button variant="outline" className="w-full justify-start" onClick={() => void kickAll()} disabled={busy}>
              <MonitorSmartphone /> 吊销全部会话
            </Button>
            <Button variant="outline" className="w-full justify-start" onClick={() => setDialog('profile')}>
              <UserCog /> 重置资料
            </Button>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="sessions">
        <TabsList>
          <TabsTrigger value="sessions">会话 ({data.sessions.length})</TabsTrigger>
          <TabsTrigger value="passkeys">Passkey ({data.passkeys.length})</TabsTrigger>
          <TabsTrigger value="audit">安全活动</TabsTrigger>
        </TabsList>

        <TabsContent value="sessions">
          <Card>
            <CardContent className="divide-y p-0">
              {data.sessions.length === 0 ? (
                <p className="text-muted-foreground p-6 text-sm">没有活跃会话。</p>
              ) : (
                data.sessions.map((s) => (
                  <div key={s.id} className="flex flex-wrap items-center gap-3 p-4">
                    <MonitorSmartphone className="text-muted-foreground size-4" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{s.device || '未知设备'}</p>
                      <p className="text-muted-foreground text-xs">
                        {s.app} · {s.ip}
                        {s.ipRegion ? ` · ${s.ipRegion}` : ''} · {relativeTime(s.lastSeenAt)}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => void kickSession(s.id)}>
                      吊销
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="passkeys">
          <Card>
            <CardContent className="divide-y p-0">
              {data.passkeys.length === 0 ? (
                <p className="text-muted-foreground p-6 text-sm">没有 Passkey。</p>
              ) : (
                data.passkeys.map((p: Passkey) => (
                  <div key={p.id} className="flex items-center gap-3 p-4">
                    <Fingerprint className="text-muted-foreground size-4" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{p.name}</p>
                      <p className="text-muted-foreground text-xs">
                        添加于 {dateTime(p.createdAt)} · 最近使用 {relativeTime(p.lastUsedAt)}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardContent className="divide-y p-0">
              {audit.isLoading ? (
                <Skeleton className="m-4 h-20" />
              ) : (audit.data?.items ?? []).length === 0 ? (
                <p className="text-muted-foreground p-6 text-sm">没有相关安全事件。</p>
              ) : (
                audit.data!.items.map((row) => (
                  <div key={row.id} className="flex flex-wrap items-start gap-3 p-4">
                    <ShieldCheck className="text-muted-foreground mt-0.5 size-4" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">
                        {row.action}
                        {row.result !== 'ok' && <Badge variant="destructive" className="ml-2">失败</Badge>}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {dateTime(row.ts)} · {row.ip}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={!!pendingRole}
        onOpenChange={(v) => !v && setPendingRole(null)}
        title={`变更为「${roleName(pendingRole)}」？`}
        description={`当前角色：${roleName(data.role)}。变更立即生效，并写入审计。`}
        confirmLabel="确认变更"
        busy={busy}
        onConfirm={async () => {
          const r = pendingRole
          setPendingRole(null)
          if (r) await setRole(r)
        }}
      />
      <ResetPasswordDialog
        open={dialog === 'password'}
        onOpenChange={(v) => !v && setDialog(null)}
        uid={uid}
        onDone={(pw) => {
          setTempPassword(pw)
          setDialog(null)
          void refresh()
        }}
      />
      <ChangeEmailDialog open={dialog === 'email'} onOpenChange={(v) => !v && setDialog(null)} uid={uid} onDone={() => { setDialog(null); void refresh() }} />
      <BanDialog open={dialog === 'ban'} onOpenChange={(v) => !v && setDialog(null)} uid={uid} onDone={() => { setDialog(null); void refresh() }} />
      <ConfirmDialog
        open={dialog === 'mfa'}
        onOpenChange={(v) => !v && setDialog(null)}
        title="重置两步验证与 Passkey？"
        description="会清空该用户的 TOTP 因子与全部 Passkey，并吊销全部会话。对方需要用密码重新登录并重新绑定。"
        confirmLabel="重置并吊销会话"
        destructive
        busy={busy}
        onConfirm={resetMfa}
      />
      <ProfileResetDialog open={dialog === 'profile'} onOpenChange={(v) => !v && setDialog(null)} busy={busy} onDone={resetProfile} />

      <Dialog open={!!tempPassword} onOpenChange={(v) => !v && setTempPassword('')}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>临时密码</DialogTitle>
            <DialogDescription>只显示这一次，关闭后无法再次查看。</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code className="bg-muted flex-1 rounded-md px-3 py-2 font-mono text-sm">{tempPassword}</code>
            <CopyButton value={tempPassword} />
          </div>
          <DialogFooter>
            <Button onClick={() => setTempPassword('')}>我已保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function roleName(role: string | null): string {
  return role === 'super' ? '平台管理员' : role === 'admin' ? '项目管理员' : '普通用户'
}

function ResetPasswordDialog({
  open,
  onOpenChange,
  uid,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  uid: string
  onDone: (pw: string) => void
}) {
  const [mode, setMode] = React.useState<'generate' | 'manual'>('generate')
  const [password, setPassword] = React.useState('')
  const [force, setForce] = React.useState(true)
  const [notify, setNotify] = React.useState(true)
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  async function run() {
    setBusy(true)
    try {
      const res = await api.post<{ temporaryPassword: string }>(`/admin/users/${uid}/password`, {
        mode,
        password,
        forceChange: force,
        notify,
        reason,
      })
      toast.success('密码已重置')
      onDone(res.temporaryPassword || '')
      setPassword('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重置失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重置密码</DialogTitle>
          <DialogDescription>临时密码只显示一次；选择通知时会同时发邮件。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>方式</Label>
            <Select aria-label="重置方式" value={mode} onChange={(e) => setMode(e.target.value as 'generate' | 'manual')}>
              <option value="generate">随机生成</option>
              <option value="manual">指定新密码</option>
            </Select>
          </div>
          {mode === 'manual' && (
            <div className="space-y-1.5">
              <Label>新密码</Label>
              <Input aria-label="新密码" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} /> 下次登录强制改密
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={notify} onCheckedChange={(v) => setNotify(v === true)} /> 邮件通知用户
          </label>
          <div className="space-y-1.5">
            <Label>原因（可选）</Label>
            <Input aria-label="重置原因" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="写进审计与通知邮件" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button onClick={run} disabled={busy || (mode === 'manual' && password.length < 8)}>
            {busy && <Loader2 className="animate-spin" />} 重置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChangeEmailDialog({
  open,
  onOpenChange,
  uid,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  uid: string
  onDone: () => void
}) {
  const [email, setEmail] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  async function run() {
    setBusy(true)
    try {
      await api.post(`/admin/users/${uid}/email`, { email: email.trim(), reason })
      toast.success('邮箱已更新')
      setEmail('')
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '修改失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>更换邮箱</DialogTitle>
          <DialogDescription>新邮箱必须未被占用；新旧邮箱都会收到通知。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>新邮箱</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>原因（可选）</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button onClick={run} disabled={busy || !email.trim()}>
            {busy && <Loader2 className="animate-spin" />} 保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BanDialog({
  open,
  onOpenChange,
  uid,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  uid: string
  onDone: () => void
}) {
  const [app, setApp] = React.useState('*')
  const [until, setUntil] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  async function run() {
    setBusy(true)
    try {
      await api.post(`/admin/users/${uid}/ban`, {
        app,
        until: until ? new Date(until).getTime() : 0,
        reason: reason.trim(),
      })
      toast.success('已封禁')
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '封禁失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>封禁账号</DialogTitle>
          <DialogDescription>封禁后该账号无法登录，已有会话会被吊销。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>范围</Label>
            <Select aria-label="封禁范围" value={app} onChange={(e) => setApp(e.target.value)}>
              <option value="*">全站</option>
              {APPS.map((a) => (
                <option key={a.key} value={a.key}>{a.label}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>解除时间（留空 = 永久）</Label>
            <Input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>原因</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button variant="destructive" onClick={run} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />} 封禁
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ProfileResetDialog({
  open,
  onOpenChange,
  busy,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  busy: boolean
  onDone: (avatar: boolean, nickname: boolean) => void
}) {
  const [avatar, setAvatar] = React.useState(true)
  const [nickname, setNickname] = React.useState(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重置资料</DialogTitle>
          <DialogDescription>清除用户自设的头像或昵称，回到邮箱前缀回退。</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={avatar} onCheckedChange={(v) => setAvatar(v === true)} /> 清除头像
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={nickname} onCheckedChange={(v) => setNickname(v === true)} /> 清除昵称
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button onClick={() => onDone(avatar, nickname)} disabled={busy || (!avatar && !nickname)}>
            {busy && <Loader2 className="animate-spin" />} 重置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
