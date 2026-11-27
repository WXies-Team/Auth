import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { Download, FilterX, RefreshCw, ScrollText } from 'lucide-react'
import { api } from '@/lib/api'
import type { AuditRow, Page } from '@/lib/types'
import { dateTime } from '@/lib/format'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SavedViews } from '@/components/ui/saved-views'
import { Badge } from '@/components/ui/badge'
import { TableSkeleton } from '@/components/ui/skeleton'
import { useLoadingSkeleton } from '@/lib/use-loading'
import { EmptyState } from '@/components/ui/empty-state'
import { Pagination } from '@/components/ui/pagination'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const ACTIONS = [
  'login.success', 'login.fail', 'password.change', 'password.reset', 'email.change',
  'passkey.create', 'passkey.rename', 'passkey.delete', 'totp.setup', 'totp.enable',
  'totp.disable', 'recovery.generate', 'recovery.consume', 'reauth', 'profile.update',
  'session.kick', 'user.ban', 'user.unban', 'user.email_change', 'user.profile_reset',
  'user.invite', 'user.invite_resend', 'user.invite_revoke', 'user.invite_accept',
  'account.delete_requested', 'account.delete_cancelled', 'admin.user.role_change',
  'admin.role.change', 'admin.role.grant', 'admin.role.revoke', 'admin.user.session_revoke',
  'admin.session.revoke', 'admin.config.set', 'admin.bulk_action', 'admin.oauth_client.write',
  'project.access_grant', 'project.access_revoke', 'project.restrict_on', 'project.restrict_off', 'project.policy_update', 'admin.mail_test',
  'internal.ensure', 'account.delete', 'admin.audit.view', 'logout', 'register',
  'oauth.consent_grant', 'oauth.consent_revoke', 'admin.mfa.reset', 'admin.impersonate',
]

const PAGE = 50

export default function AdminAuditPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [action, setAction] = React.useState(searchParams.get('action') ?? '')
  const [actor, setActor] = React.useState(searchParams.get('actor') ?? '')
  const [target, setTarget] = React.useState(searchParams.get('target') ?? '')
  const [result, setResult] = React.useState(searchParams.get('result') ?? '')
  const [ip, setIp] = React.useState(searchParams.get('ip') ?? '')
  const [from, setFrom] = React.useState(searchParams.get('from') ?? '')
  const [to, setTo] = React.useState(searchParams.get('to') ?? '')
  const [page, setPage] = React.useState(Math.max(1, Number(searchParams.get('page')) || 1))
  const [open, setOpen] = React.useState<number | null>(null)

  React.useEffect(() => {
    const p = new URLSearchParams()
    if (action) p.set('action', action)
    if (actor) p.set('actor', actor)
    if (target) p.set('target', target)
    if (result) p.set('result', result)
    if (ip) p.set('ip', ip)
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    if (page > 1) p.set('page', String(page))
    setSearchParams(p, { replace: true })
  }, [action, actor, target, result, ip, from, to, page, setSearchParams])

  const params = new URLSearchParams({ limit: String(PAGE), offset: String((page - 1) * PAGE) })
  if (action) params.set('action', action)
  if (actor) params.set('actor', actor)
  if (target) params.set('target', target)
  if (result) params.set('result', result)
  if (ip) params.set('ip', ip)
  if (from) params.set('from', String(new Date(from).getTime()))
  if (to) params.set('to', String(new Date(to).getTime()))

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin-audit', params.toString()],
    queryFn: () => api.get<Page<AuditRow>>(`/admin/audit?${params}`),
  })

  const rows = data?.items ?? []
  const showSkeleton = useLoadingSkeleton(isLoading)

  return (
    <div className="space-y-4">
      <PageHeader
        title="审计日志"
        description="查看登录、授权、改密与管理操作的不可变记录，默认保留 90 天。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
              <RefreshCw className={isFetching ? 'animate-spin' : ''} /> 刷新
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={`/admin/audit?${params}&format=csv`}>
                <Download /> 导出 CSV
              </a>
            </Button>
          </>
        }
      />

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Select aria-label="动作筛选" value={action} onChange={(e) => { setAction(e.target.value); setPage(1) }}>
              <option value="">全部动作</option>
              {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </Select>
            <Select aria-label="结果筛选" value={result} onChange={(e) => { setResult(e.target.value); setPage(1) }}>
              <option value="">全部结果</option>
              <option value="ok">成功</option>
              <option value="fail">失败</option>
            </Select>
            <Input aria-label="操作者 uid" placeholder="操作者 uid" value={actor} onChange={(e) => { setActor(e.target.value); setPage(1) }} />
            <Input aria-label="目标 uid" placeholder="目标 uid" value={target} onChange={(e) => { setTarget(e.target.value); setPage(1) }} />
            <Input aria-label="IP 前缀" placeholder="IP 前缀" value={ip} onChange={(e) => { setIp(e.target.value); setPage(1) }} />
            <Input type="datetime-local" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} aria-label="起始时间" />
            <Input type="datetime-local" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} aria-label="结束时间" />
            <Button
              variant="ghost"
              onClick={() => {
                setAction(''); setActor(''); setTarget(''); setResult(''); setIp(''); setFrom(''); setTo(''); setPage(1)
              }}
            >
              <FilterX /> 重置筛选
            </Button>
          </div>

          <SavedViews
            storageKey="auth.views.audit"
            state={{ action, actor, target, result, ip, from, to }}
            onApply={(v) => {
              setAction(v.action ?? '')
              setActor(v.actor ?? '')
              setTarget(v.target ?? '')
              setResult(v.result ?? '')
              setIp(v.ip ?? '')
              setFrom(v.from ?? '')
              setTo(v.to ?? '')
              setPage(1)
            }}
          />

          {showSkeleton ? (
            <TableSkeleton rows={4} columns={6} dense />
          ) : rows.length === 0 ? (
            <EmptyState icon={ScrollText} title="没有匹配的审计记录" description="调整筛选条件或时间范围后重试。" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>动作</TableHead>
                  <TableHead>操作者</TableHead>
                  <TableHead>目标</TableHead>
                  <TableHead>结果</TableHead>
                  <TableHead>IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <React.Fragment key={r.id}>
                    <TableRow className="cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)}>
                      <TableCell className="text-muted-foreground text-xs whitespace-nowrap">{dateTime(r.ts)}</TableCell>
                      <TableCell className="font-mono text-xs">{r.action}</TableCell>
                      <TableCell className="text-sm">{r.actorEmail || (r.actorUid ? `uid ${r.actorUid}` : '系统')}</TableCell>
                      <TableCell className="text-sm">{r.targetUid ? <Link className="hover:underline" to={`/web/admin/users/${r.targetUid}`}>{r.targetUid}</Link> : '—'}</TableCell>
                      <TableCell>
                        {r.result === 'ok' ? <Badge variant="success">成功</Badge> : <Badge variant="destructive">失败</Badge>}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.ip || '—'}</TableCell>
                    </TableRow>
                    {open === r.id && (
                      <TableRow>
                        <TableCell colSpan={6} className="bg-muted/40">
                          <div className="space-y-1 text-xs">
                            <p><span className="text-muted-foreground">UA：</span>{r.userAgent || '—'}</p>
                            {r.detail && Object.keys(r.detail).length > 0 && (
                              <div className="flex flex-wrap gap-2">
                                {Object.entries(r.detail).map(([k, v]) => (
                                  <Badge key={k} variant="outline">{k}: {v}</Badge>
                                ))}
                              </div>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                ))}
              </TableBody>
            </Table>
          )}

          {data && data.total > PAGE && (
            <Pagination page={page} pageSize={PAGE} total={data.total} onPage={setPage} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
