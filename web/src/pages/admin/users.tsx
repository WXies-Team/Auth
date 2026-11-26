import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Ban,
  CheckSquare,
  Loader2,
  MailPlus,
  Search,
  Users,
} from 'lucide-react'
import { api } from '@/lib/api'
import { APPS } from '@/lib/apps'
import type { AdminInvite, AdminUser, Page } from '@/lib/types'
import { dateOnly, roleLabel } from '@/lib/format'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { Pagination } from '@/components/ui/pagination'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'

const PAGE = 20

function inviteState(state: AdminInvite['state']): string {
  return state === 'pending' ? '待接受' : state === 'accepted' ? '已接受' : state === 'revoked' ? '已撤销' : '已过期'
}

export default function AdminUsersPage() {
  const qc = useQueryClient()
  const [query, setQuery] = React.useState('')
  const [role, setRole] = React.useState('')
  const [status, setStatus] = React.useState('')
  const [page, setPage] = React.useState(1)
  const [selected, setSelected] = React.useState<Set<number>>(new Set())
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [inviteEmail, setInviteEmail] = React.useState('')
  const [inviteApp, setInviteApp] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [bulkOpen, setBulkOpen] = React.useState(false)
  const [showInvites, setShowInvites] = React.useState(false)
  const [bulkKind, setBulkKind] = React.useState<'ban' | 'unban' | 'password_reset' | 'session_revoke'>('ban')
  const [reason, setReason] = React.useState('')

  const params = new URLSearchParams({ limit: String(PAGE), offset: String((page - 1) * PAGE) })
  if (query) params.set('query', query)
  if (role) params.set('role', role)
  if (status) params.set('banned', status)

  const { data, isLoading } = useQuery({
    queryKey: ['admin-users', query, role, status, page],
    queryFn: () => api.get<Page<AdminUser>>(`/admin/users?${params}`),
  })
  const invites = useQuery({
    queryKey: ['admin-invites', query],
    queryFn: () => api.get<{ invites: AdminInvite[] }>(`/admin/users/invites?query=${encodeURIComponent(query)}`),
    enabled: showInvites,
  })

  const rows = data?.items ?? []
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.uid))

  function toggle(uid: number, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(uid)
      else next.delete(uid)
      return next
    })
  }

  async function invite() {
    setBusy(true)
    try {
      await api.post('/admin/users/invite', { email: inviteEmail.trim(), app: inviteApp })
      toast.success('邀请已发送')
      setInviteOpen(false)
      setInviteEmail('')
      await qc.invalidateQueries({ queryKey: ['admin-users'] })
      await qc.invalidateQueries({ queryKey: ['admin-invites'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '发送失败')
    } finally {
      setBusy(false)
    }
  }

  async function bulk() {
    setBusy(true)
    try {
      const res = await api.post<{ succeeded: number; failed: number }>('/admin/users/bulk', {
        kind: bulkKind,
        uids: [...selected],
        app: '*',
        until: 0,
        reason: reason.trim(),
      })
      toast.success(`完成：成功 ${res.succeeded ?? selected.size}，失败 ${res.failed ?? 0}`)
      setBulkOpen(false)
      setSelected(new Set())
      setReason('')
      await qc.invalidateQueries({ queryKey: ['admin-users'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="用户"
        description="账号目录、角色、封禁与邀请。"
        actions={
          <Button onClick={() => setInviteOpen(true)}>
            <MailPlus /> 邀请用户
          </Button>
        }
      />

      <Card>
        <CardContent className="space-y-3 p-4">
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              setPage(1)
            }}
          >
            <div className="relative min-w-48 flex-1">
              <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <Input
                aria-label="按邮箱片段或 uid 搜索"
                className="pl-8"
                placeholder="按邮箱片段或 uid 搜索"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setPage(1)
                }}
              />
            </div>
            <Select
              aria-label="角色筛选"
              className="w-36"
              value={role}
              onChange={(e) => {
                setRole(e.target.value)
                setPage(1)
              }}
            >
              <option value="">全部角色</option>
              <option value="user">普通用户</option>
              <option value="admin">项目管理员</option>
              <option value="super">平台管理员</option>
            </Select>
            <Select
              aria-label="状态筛选"
              className="w-32"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setPage(1)
              }}
            >
              <option value="">全部状态</option>
              <option value="true">已封禁</option>
              <option value="false">正常</option>
            </Select>
          </form>

          {selected.size > 0 && (
            <div className="bg-muted flex flex-wrap items-center gap-2 rounded-lg px-3 py-2">
              <CheckSquare className="size-4" />
              <span className="text-sm">已选 {selected.size} 人</span>
              <div className="flex-1" />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setBulkKind('ban')
                  setBulkOpen(true)
                }}
              >
                <Ban /> 封禁
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setBulkKind('unban')
                  setBulkOpen(true)
                }}
              >
                解除封禁
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setBulkKind('password_reset')
                  setBulkOpen(true)
                }}
              >
                重置密码
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setBulkKind('session_revoke')
                  setBulkOpen(true)
                }}
              >
                退出所有会话
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                清空
              </Button>
            </div>
          )}

          {isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Users}
              title="暂无匹配的用户"
              description="调整搜索关键词，或点击「邀请用户」创建第一个账号。"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allChecked}
                      onCheckedChange={(v) => {
                        if (v === true) setSelected(new Set(rows.map((r) => r.uid)))
                        else setSelected(new Set())
                      }}
                      aria-label="全选"
                    />
                  </TableHead>
                  <TableHead>账号</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead>安全</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>注册</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((u) => (
                  <TableRow key={u.uid}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(u.uid)}
                        onCheckedChange={(v) => toggle(u.uid, v === true)}
                        aria-label={`选择 ${u.email}`}
                      />
                    </TableCell>
                    <TableCell>
                      <Link to={`/web/admin/users/${u.uid}`} className="hover:underline">
                        <p className="flex items-center gap-1.5 font-medium">
                          {u.email}
                          {u.isRoot && <Badge variant="secondary">根</Badge>}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          uid {u.uid}
                          {u.nickname ? ` · ${u.nickname}` : ''}
                        </p>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={u.role === 'super' ? 'default' : u.role === 'admin' ? 'secondary' : 'outline'}>
                        {roleLabel(u.role)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-muted-foreground text-xs">
                        {u.totpEnabled ? '2FA' : '无 2FA'} · {u.passkeyCount} 把 Passkey
                      </span>
                    </TableCell>
                    <TableCell>
                      {u.ban ? (
                        <Badge variant="destructive">封禁</Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">正常</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{dateOnly(u.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <Link to={`/web/admin/users/${u.uid}`}>详情</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {data && data.total > PAGE && (
            <Pagination page={page} pageSize={PAGE} total={data.total} onPage={setPage} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">邀请记录</p>
              <p className="text-muted-foreground text-xs">24 小时内有效；重发会让旧链接立即失效。</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowInvites((v) => !v)}>
              {showInvites ? '收起' : '查看'}
            </Button>
          </div>
          {showInvites && (
            <div className="mt-3 overflow-x-auto">
              {invites.isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : (invites.data?.invites ?? []).length === 0 ? (
                <p className="text-muted-foreground py-4 text-sm">没有邀请记录。</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>邮箱</TableHead>
                      <TableHead>项目</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>过期</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invites.data!.invites.map((inv) => (
                      <TableRow key={inv.id}>
                        <TableCell className="text-sm">{inv.email}</TableCell>
                        <TableCell className="text-sm">{inv.app || '账号级'}</TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              inv.state === 'pending'
                                ? 'warning'
                                : inv.state === 'accepted'
                                  ? 'success'
                                  : 'outline'
                            }
                          >
                            {inviteState(inv.state)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">{dateOnly(inv.expiresAt)}</TableCell>
                        <TableCell className="text-right">
                          {inv.state === 'pending' && (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  void api
                                    .post(`/admin/users/invite/${inv.id}/resend`, {})
                                    .then(() => { toast.success('已重发'); return invites.refetch() })
                                    .catch((e) => toast.error(e.message))
                                }
                              >
                                重发
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive"
                                onClick={() =>
                                  void api
                                    .post(`/admin/users/invite/${inv.id}/revoke`, {})
                                    .then(() => { toast.success('已撤销'); return invites.refetch() })
                                    .catch((e) => toast.error(e.message))
                                }
                              >
                                撤销
                              </Button>
                            </>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>邀请用户</DialogTitle>
            <DialogDescription>发送一封 24 小时内有效的邀请邮件，对方设置密码后即可登录。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">邮箱</Label>
              <Input id="invite-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="invite-app">项目（可选）</Label>
              <Select id="invite-app" value={inviteApp} onChange={(e) => setInviteApp(e.target.value)}>
                <option value="">账号级邀请</option>
                {APPS.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.label}
                  </option>
                ))}
              </Select>
              <p className="text-muted-foreground text-xs">选择项目时，接受后会自动加入该项目的登录名单。</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button onClick={invite} disabled={busy || !inviteEmail.trim()}>
              {busy && <Loader2 className="animate-spin" />} 发送邀请
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {bulkKind === 'ban'
                ? '封禁'
                : bulkKind === 'unban'
                  ? '解除封禁'
                  : bulkKind === 'session_revoke'
                    ? '退出所有会话'
                    : '重置密码'}{' '}
              {selected.size} 个账号？
            </DialogTitle>
            <DialogDescription>
              {bulkKind === 'ban'
                ? '封禁后这些账号无法登录任何项目，已有会话会被立即吊销。'
                : bulkKind === 'unban'
                  ? '解除后这些账号可以重新登录。'
                  : bulkKind === 'session_revoke'
                    ? '会吊销这些账号的全部登录会话；对方需要用密码重新登录。'
                    : '会为每个账号生成临时密码并发送通知邮件；临时密码不进本回执。'}
            </DialogDescription>
          </DialogHeader>
          {bulkKind !== 'unban' && (
            <div className="space-y-1.5">
              <Label htmlFor="bulk-reason">原因（可选）</Label>
              <Input id="bulk-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：异常登录" />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button variant={bulkKind === 'ban' ? 'destructive' : 'default'} onClick={bulk} disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              {bulkKind === 'ban'
                ? '封禁'
                : bulkKind === 'unban'
                  ? '解除'
                  : bulkKind === 'session_revoke'
                    ? '退出会话'
                    : '重置密码'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
