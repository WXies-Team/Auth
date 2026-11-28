import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { KeyRound, Loader2, Lock, Plus, Save, Search, ShieldCheck, SlidersHorizontal, Trash2, UserPlus, Users } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import type { AdminProject, Page, ProjectMember } from '@/lib/types'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { useLoadingSkeleton } from '@/lib/use-loading'
import { EmptyState } from '@/components/ui/empty-state'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CopyButton } from '@/components/ui/copy-button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'

export default function AdminAccessPage() {
  const qc = useQueryClient()
  const { session } = useAuth()
  const { data, isLoading } = useQuery({
    queryKey: ['admin-projects'],
    queryFn: () => api.get<{ projects: AdminProject[] }>('/admin/projects'),
  })
  const [memberProject, setMemberProject] = React.useState<AdminProject | null>(null)
  const [oauthProject, setOauthProject] = React.useState<AdminProject | null>(null)
  const [policyProject, setPolicyProject] = React.useState<AdminProject | null>(null)
  const [adminProject, setAdminProject] = React.useState<AdminProject | null>(null)
  const [revokingAdmin, setRevokingAdmin] = React.useState<{ app: string; member: ProjectMember } | null>(null)
  const [removing, setRemoving] = React.useState<{ app: string; member: ProjectMember } | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ['admin-projects'] })
  }

  async function setRestricted(p: AdminProject, restricted: boolean) {
    setBusy(true)
    try {
      await api.post(`/admin/projects/${p.app}/restrict`, { restricted })
      toast.success(restricted ? '已切换为仅限受邀' : '已切换为开放登录')
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  async function removeMember() {
    if (!removing) return
    setBusy(true)
    try {
      await api.del(`/admin/projects/${removing.app}/access`, { email: removing.member.email })
      toast.success('已移出项目')
      setRemoving(null)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  async function revokeAdmin() {
    if (!revokingAdmin) return
    setBusy(true)
    try {
      await api.post(`/admin/roles/${revokingAdmin.member.uid}/scope`, { app: revokingAdmin.app, op: 'revoke' })
      toast.success('已回收项目管理员')
      setRevokingAdmin(null)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const projects = data?.projects ?? []

  return (
    <div className="space-y-6">
      <PageHeader title="项目访问" description="控制每个项目谁能登录、谁是项目管理员，以及 OAuth 回跳地址。" />

      {isLoading ? (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-56 w-full" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <Card>
          <EmptyState icon={Lock} title="当前没有可管理的项目" description="你被授权的项目会出现在这里。" />
        </Card>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          {projects.map((p) => (
            <Card key={p.app}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {p.name}
                      <Badge variant="secondary">{p.app}</Badge>
                    </CardTitle>
                    <CardDescription>
                      {p.restricted ? '仅限受邀：只有成员和管理员能登录' : '开放登录：所有账号都能登录'}
                    </CardDescription>
                  </div>
                  <Switch
                    checked={p.restricted}
                    disabled={busy}
                    onCheckedChange={(v) => void setRestricted(p, v)}
                    aria-label="仅限受邀"
                  />
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <Users className="size-4" /> 成员 {p.members.length}
                  </p>
                  <Button variant="outline" size="sm" onClick={() => setMemberProject(p)}>
                    <UserPlus /> 添加成员
                  </Button>
                </div>
                {p.members.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {p.restricted ? '还没有成员。仅限受邀时，只有管理员和名单成员可以登录。' : '开放登录时无需名单；切到仅限受邀前先加成员。'}
                  </p>
                ) : (
                  <ul className="divide-y rounded-md border">
                    {p.members.slice(0, 6).map((m) => (
                      <li key={m.uid} className="flex items-center gap-2 px-3 py-2 text-sm">
                        <span className="min-w-0 flex-1 truncate">{m.email}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive"
                          aria-label={`移出 ${m.email}`}
                          onClick={() => setRemoving({ app: p.app, member: m })}
                        >
                          <Trash2 />
                        </Button>
                      </li>
                    ))}
                    {p.members.length > 6 && (
                      <li className="text-muted-foreground px-3 py-2 text-xs">还有 {p.members.length - 6} 人…</li>
                    )}
                  </ul>
                )}

                <Separator />
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">项目管理员</p>
                    {session?.role === 'super' && (
                      <Button variant="ghost" size="sm" onClick={() => setAdminProject(p)}>
                        <UserPlus /> 授予
                      </Button>
                    )}
                  </div>
                  {p.admins.length === 0 ? (
                    <p className="text-muted-foreground text-sm">暂无。项目管理员可管理该项目的成员与会话。</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {p.admins.map((a) => (
                        <span key={a.uid} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
                          {a.email}
                          {session?.role === 'super' && (
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-destructive"
                              aria-label={`回收 ${a.email} 的项目管理员`}
                              onClick={() => setRevokingAdmin({ app: p.app, member: a })}
                            >
                              ×
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <Separator />
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <ShieldCheck className="size-4" /> 访问策略
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {p.mfaRequired ? '要求 MFA' : '不强制 MFA'} · {p.sessionDays ? `会话 ${p.sessionDays} 天` : '会话默认 90 天'}
                      {p.legacyUpgrade ? ' · 旧客户端强制升级' : ''}
                      {p.allowedDomains.length ? ` · 域名 ${p.allowedDomains.join('、')}` : ''}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setPolicyProject(p)}>
                    <SlidersHorizontal /> 配置
                  </Button>
                </div>

                <Separator />
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">OAuth 客户端</p>
                    <p className="text-muted-foreground truncate text-xs">
                      {p.clientId ? `client_id: ${p.clientId}` : '未开通'}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setOauthProject(p)}>
                    <KeyRound /> 配置
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {memberProject && (
        <MemberDialog
          project={memberProject}
          open={!!memberProject}
          onOpenChange={(v) => !v && setMemberProject(null)}
          onDone={() => { setMemberProject(null); void refresh() }}
        />
      )}
      {adminProject && (
        <AdminDialog
          project={adminProject}
          open={!!adminProject}
          onOpenChange={(v) => !v && setAdminProject(null)}
          onDone={() => { setAdminProject(null); void refresh() }}
        />
      )}
      {policyProject && (
        <PolicyDialog
          project={policyProject}
          open={!!policyProject}
          onOpenChange={(v) => !v && setPolicyProject(null)}
          onDone={() => { setPolicyProject(null); void refresh() }}
        />
      )}
      {oauthProject && (
        <OAuthDialog
          project={oauthProject}
          open={!!oauthProject}
          onOpenChange={(v) => !v && setOauthProject(null)}
          onDone={() => { setOauthProject(null); void refresh() }}
        />
      )}

      <ConfirmDialog
        open={!!revokingAdmin}
        onOpenChange={(v) => !v && setRevokingAdmin(null)}
        title={`回收 ${revokingAdmin?.member.email ?? ''} 的项目管理员？`}
        description="会收回该项目管理员授权；对方的项目管理员角色在没有其它项目授权时会降回普通用户。"
        confirmLabel="回收"
        destructive
        busy={busy}
        onConfirm={revokeAdmin}
      />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(v) => !v && setRemoving(null)}
        title={`把 ${removing?.member.email ?? ''} 移出项目？`}
        description="会同时回收该项目的管理员授权与登录名单；该用户在这个项目的会话会被吊销。"
        confirmLabel="移出"
        destructive
        busy={busy}
        onConfirm={removeMember}
      />
    </div>
  )
}

function MemberDialog({
  project,
  open,
  onOpenChange,
  onDone,
}: {
  project: AdminProject
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
}) {
  const [query, setQuery] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const candidates = useQuery({
    queryKey: ['candidates', project.app, query],
    queryFn: () =>
      api.get<Page<{ uid: number; email: string; role: string }>>(
        `/admin/projects/${project.app}/candidates?query=${encodeURIComponent(query)}&limit=20&offset=0`,
      ),
    enabled: open,
  })
  const candidatesSkeleton = useLoadingSkeleton(candidates.isLoading)

  async function add(email: string) {
    setBusy(true)
    try {
      await api.post(`/admin/projects/${project.app}/access`, { email })
      toast.success('已加入项目')
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '添加失败')
    } finally {
      setBusy(false)
    }
  }

  const existing = new Set(project.members.map((m) => m.email))
  const rows = (candidates.data?.items ?? []).filter((c) => !existing.has(c.email))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加成员到「{project.name}」</DialogTitle>
          <DialogDescription>输入邮箱搜索已注册用户；未注册的人请先发邀请。</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input autoFocus aria-label="搜索邮箱或 uid" className="pl-8" placeholder="搜索邮箱或 uid" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="max-h-64 overflow-y-auto rounded-md border">
          {candidatesSkeleton ? (
            <Skeleton className="m-3 h-16" />
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm">没有可添加的用户。</p>
          ) : (
            <ul className="divide-y">
              {rows.map((c) => (
                <li key={c.uid} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{c.email}</p>
                    <p className="text-muted-foreground text-xs">uid {c.uid} · {c.role}</p>
                  </div>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void add(c.email)}>
                    <Plus /> 添加
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AdminDialog({
  project,
  open,
  onOpenChange,
  onDone,
}: {
  project: AdminProject
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
}) {
  const [query, setQuery] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const candidates = useQuery({
    queryKey: ['admin-candidates', project.app, query],
    queryFn: () =>
      api.get<Page<{ uid: number; email: string; role: string }>>(
        `/admin/projects/${project.app}/candidates?query=${encodeURIComponent(query)}&limit=20&offset=0`,
      ),
    enabled: open,
  })
  const candidatesSkeleton = useLoadingSkeleton(candidates.isLoading)

  async function grant(uid: number) {
    setBusy(true)
    try {
      await api.post(`/admin/roles/${uid}/scope`, { app: project.app, op: 'grant' })
      toast.success('已授予项目管理员')
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '授权失败')
    } finally {
      setBusy(false)
    }
  }

  const existing = new Set(project.admins.map((a) => a.uid))
  const rows = (candidates.data?.items ?? []).filter((c) => !existing.has(c.uid))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>授予「{project.name}」项目管理员</DialogTitle>
          <DialogDescription>项目管理员只能管理该项目，不能查看全站目录或配置。</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input autoFocus aria-label="搜索邮箱或 uid" className="pl-8" placeholder="搜索邮箱或 uid" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="max-h-64 overflow-y-auto rounded-md border">
          {candidatesSkeleton ? (
            <Skeleton className="m-3 h-16" />
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm">没有可授权的用户。</p>
          ) : (
            <ul className="divide-y">
              {rows.map((c) => (
                <li key={c.uid} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{c.email}</p>
                    <p className="text-muted-foreground text-xs">uid {c.uid} · {c.role}</p>
                  </div>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void grant(c.uid)}>
                    <Plus /> 授予
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PolicyDialog({
  project,
  open,
  onOpenChange,
  onDone,
}: {
  project: AdminProject
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
}) {
  const [mfa, setMfa] = React.useState(project.mfaRequired)
  const [legacyUpgrade, setLegacyUpgrade] = React.useState(project.legacyUpgrade)
  const [domains, setDomains] = React.useState(project.allowedDomains.join('\n'))
  const [days, setDays] = React.useState(String(project.sessionDays || 0))
  const [busy, setBusy] = React.useState(false)

  async function save() {
    setBusy(true)
    try {
      await api.post(`/admin/projects/${project.app}/policy`, {
        mfaRequired: mfa,
        legacyUpgrade,
        allowedDomains: domains.split(/[\n,，]/).map((d) => d.trim()).filter(Boolean),
        sessionDays: Number(days) || 0,
      })
      toast.success('策略已保存')
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>「{project.name}」访问策略</DialogTitle>
          <DialogDescription>
            只影响该项目的登录与会话；0 天表示使用默认 90 天。项目级策略都在这里，配置中心只保留全局/跨项目项。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              要求两步验证
              <span className="text-muted-foreground block text-xs">未绑定 TOTP/Passkey 的账号不能登录该项目。</span>
            </span>
            <Switch checked={mfa} onCheckedChange={setMfa} />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              旧版客户端强制升级
              <span className="text-muted-foreground block text-xs">
                账号已绑定两步验证时，旧版 App 的密码登录会被拒绝并提示升级；不影响新版登录。
              </span>
            </span>
            <Switch checked={legacyUpgrade} onCheckedChange={setLegacyUpgrade} />
          </label>
          <div className="space-y-2">
            <Label>允许的邮箱域名（每行一个，留空 = 不限）</Label>
            <Textarea
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              placeholder="example.com, company.cn"
              className="min-h-20 font-mono text-xs"
            />
            <p className="text-muted-foreground text-xs">子域自动放行（a.example.com 命中 example.com）。</p>
          </div>
          <div className="space-y-2">
            <Label>会话绝对天数（0 = 默认 90，最多 90）</Label>
            <Input
              type="number"
              min={0}
              max={90}
              value={days}
              onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />} 保存策略
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function OAuthDialog({
  project,
  open,
  onOpenChange,
  onDone,
}: {
  project: AdminProject
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
}) {
  const [uris, setUris] = React.useState((project.redirectUris ?? []).join('\n'))
  const [rotate, setRotate] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [secret, setSecret] = React.useState('')
  const [clientId, setClientId] = React.useState(project.clientId)

  async function save() {
    setBusy(true)
    try {
      const res = await api.post<{ clientId: string; secret?: string }>(`/admin/projects/${project.app}/oauth`, {
        redirectUris: uris.split('\n').map((s) => s.trim()).filter(Boolean),
        rotateSecret: rotate,
      })
      setClientId(res.clientId)
      if (res.secret) setSecret(res.secret)
      toast.success('OAuth 配置已保存')
      setRotate(false)
      if (!res.secret) onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>「{project.name}」OAuth 客户端</DialogTitle>
          <DialogDescription>回跳地址逐行填写，必须精确匹配（不做通配）。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>client_id</Label>
            <div className="flex gap-1">
              <Input aria-label="client_id" value={clientId} readOnly />
              {clientId && <CopyButton value={clientId} />}
            </div>
          </div>
          <div className="space-y-2">
            <Label>回跳地址（每行一个）</Label>
            <textarea
              aria-label="回跳地址"
              className="border-input bg-background min-h-24 w-full rounded-md border px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={uris}
              onChange={(e) => setUris(e.target.value)}
              placeholder="https://app.example.com/oauth/callback"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={rotate} onChange={(e) => setRotate(e.target.checked)} />
            同时轮换 client_secret（旧 secret 立即失效）
          </label>
          {secret && (
            <div className="space-y-2 rounded-md border border-warning/30 bg-warning/5 p-3">
              <p className="text-xs font-medium text-warning">新 secret 只显示这一次</p>
              <div className="flex items-center gap-1">
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{secret}</code>
                <CopyButton value={secret} />
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>关闭</Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />} <Save /> 保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
