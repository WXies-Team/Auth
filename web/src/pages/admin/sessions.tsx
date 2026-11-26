import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Globe, Monitor, RefreshCw, Search, ShieldAlert, Users } from 'lucide-react'
import { api } from '@/lib/api'
import { APP_OPTIONS } from '@/lib/apps'
import type { AdminSession, SessionPage } from '@/lib/types'
import { appLabel, dateTime, relativeTime } from '@/lib/format'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SavedViews } from '@/components/ui/saved-views'
import { TableSkeleton } from '@/components/ui/skeleton'
import { useLoadingSkeleton } from '@/lib/use-loading'
import { EmptyState } from '@/components/ui/empty-state'
import { Pagination } from '@/components/ui/pagination'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { StatCard } from '@/components/ui/stat-card'

const PAGE = 20

export default function AdminSessionsPage() {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = React.useState(params.get('query') ?? '')
  const [ip, setIp] = React.useState(params.get('ip') ?? '')
  const [app, setApp] = React.useState(params.get('app') ?? '')
  const [page, setPage] = React.useState(Math.max(1, Number(params.get('page')) || 1))
  const [target, setTarget] = React.useState<AdminSession | null>(null)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    const p = new URLSearchParams()
    if (query) p.set('query', query)
    if (ip) p.set('ip', ip)
    if (app) p.set('app', app)
    if (page > 1) p.set('page', String(page))
    setParams(p, { replace: true })
  }, [query, ip, app, page, setParams])

  const apiParams = new URLSearchParams({ limit: String(PAGE), offset: String((page - 1) * PAGE) })
  if (query) apiParams.set('query', query)
  if (ip) apiParams.set('ip', ip)
  if (app) apiParams.set('app', app)

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['admin-sessions', query, ip, app, page],
    queryFn: () => api.get<SessionPage>(`/admin/sessions?${apiParams}`),
  })

  async function kick() {
    if (!target) return
    setBusy(true)
    try {
      await api.del(`/admin/sessions/${target.id}`)
      toast.success('会话已吊销')
      setTarget(null)
      await qc.invalidateQueries({ queryKey: ['admin-sessions'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const rows = data?.items ?? []
  const showSkeleton = useLoadingSkeleton(isLoading)

  return (
    <div className="space-y-4">
      <PageHeader
        title="会话总览"
        description="全站活跃会话。按项目、邮箱、uid 或 IP 检索。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={isFetching ? 'animate-spin' : ''} /> 刷新
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="会话" value={data?.total ?? '—'} icon={Monitor} />
        <StatCard label="用户" value={data?.totalUsers ?? '—'} icon={Users} />
        <StatCard label="项目" value={data?.apps?.length ?? '—'} icon={Globe} />
        <StatCard
          label="地区"
          value={data?.regions?.length ?? '—'}
          hint={data?.regions?.[0] ? `最多：${data.regions[0].name} ${data.regions[0].count}` : undefined}
        />
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap gap-2">
            <div className="relative min-w-48 flex-1">
              <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <Input
                aria-label="按邮箱片段或 uid 搜索"
                className="pl-8"
                placeholder="按邮箱片段或 uid 搜索"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPage(1) }}
              />
            </div>
            <Input
              aria-label="按 IP 前缀过滤"
              className="w-48"
              placeholder="按 IP 前缀过滤"
              value={ip}
              onChange={(e) => { setIp(e.target.value); setPage(1) }}
            />
            <Select aria-label="项目筛选" className="w-40" value={app} onChange={(e) => { setApp(e.target.value); setPage(1) }}>
              {APP_OPTIONS.map((a) => (
                <option key={a.key} value={a.key}>{a.label}</option>
              ))}
            </Select>
          </div>

          <SavedViews
            storageKey="auth.views.sessions"
            state={{ query, ip, app }}
            onApply={(v) => {
              setQuery(v.query ?? '')
              setIp(v.ip ?? '')
              setApp(v.app ?? '')
              setPage(1)
            }}
          />

          {showSkeleton ? (
            <TableSkeleton rows={4} columns={5} />
          ) : error ? (
            // 403 不再被吞成空表：零项目授权的 app-admin 会看到明确原因与下一步。
            <EmptyState
              icon={ShieldAlert}
              title="无法读取会话数据"
              description={error instanceof Error ? error.message : '请稍后重试，或联系平台管理员。'}
              action={
                <Button variant="outline" size="sm" asChild>
                  <Link to="/web/console">返回控制台</Link>
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <EmptyState icon={Monitor} title="没有匹配的会话" description="调整筛选条件后重试。" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>设备</TableHead>
                  <TableHead>项目</TableHead>
                  <TableHead>IP / 地区</TableHead>
                  <TableHead>最近活跃</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <p className="text-sm font-medium">{s.nickname || s.email}</p>
                      <p className="text-muted-foreground text-xs">uid {s.uid}</p>
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-sm">{s.device || '未知'}</TableCell>
                    <TableCell><span className="text-sm">{appLabel(s.app)}</span></TableCell>
                    <TableCell>
                      <p className="font-mono text-xs">{s.ip}</p>
                      <p className="text-muted-foreground text-xs">{s.ipRegion || '—'}</p>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{relativeTime(s.lastSeenAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setTarget(s)}>
                        吊销
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

      <ConfirmDialog
        open={!!target}
        onOpenChange={(v) => !v && setTarget(null)}
        title="吊销这条会话？"
        description={
          <>
            <span className="font-medium">{target?.email}</span> 的 {target?.device || '未知设备'} 会立即退出。
            时间：{dateTime(target?.lastSeenAt)}
          </>
        }
        confirmLabel="吊销"
        destructive
        busy={busy}
        onConfirm={kick}
      />
    </div>
  )
}
