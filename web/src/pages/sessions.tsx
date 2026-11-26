import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { LogOut, MonitorSmartphone, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { useSessions } from '@/lib/queries'
import type { SessionInfo } from '@/lib/types'
import { appLabel, dateTime, relativeTime } from '@/lib/format'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

export default function SessionsPage() {
  const qc = useQueryClient()
  const { data, isLoading, isFetching, refetch } = useSessions()
  const [target, setTarget] = React.useState<SessionInfo | null>(null)
  const [revokeOthers, setRevokeOthers] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const rows = data?.sessions ?? []
  const others = rows.filter((r) => !r.current)

  async function kick() {
    if (!target) return
    setBusy(true)
    try {
      await api.del(`/api/sessions/${target.id}`)
      toast.success('已退出该设备')
      setTarget(null)
      await qc.invalidateQueries({ queryKey: ['sessions'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  async function kickOthers() {
    setBusy(true)
    try {
      await api.post('/api/sessions/revoke-others', {})
      toast.success('已退出其它设备')
      setRevokeOthers(false)
      await qc.invalidateQueries({ queryKey: ['sessions'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="登录会话"
        description="这些设备当前可以访问你的账号。发现陌生设备时立即退出。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
              <RefreshCw className={isFetching ? 'animate-spin' : ''} /> 刷新
            </Button>
            {others.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setRevokeOthers(true)}>
                <LogOut /> 退出其它设备
              </Button>
            )}
          </>
        }
      />

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={MonitorSmartphone}
              title="只有当前设备处于登录状态"
              description="在新设备上登录后，会话会出现在这里。"
            />
          ) : (
            <ul className="divide-y">
              {rows.map((row) => (
                <li key={row.id} className="flex flex-wrap items-start gap-3 p-4">
                  <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-md">
                    <MonitorSmartphone className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {row.device || '未知设备'}
                      {row.current && <Badge variant="secondary">本机</Badge>}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {appLabel(row.app)} · {relativeTime(row.lastSeenAt)}
                      {row.ipRegion ? ` · ${row.ipRegion}` : ''} · {row.ip}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      首次登录 {dateTime(row.createdAt)}
                      {row.expiresAt ? ` · 最晚 ${dateTime(row.expiresAt)}` : ''}
                    </p>
                  </div>
                  {!row.current && (
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setTarget(row)}>
                      退出
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!target}
        onOpenChange={(v) => !v && setTarget(null)}
        title="退出这台设备？"
        description={
          <>
            <span className="font-medium">{target?.device || '未知设备'}</span> 将立即失去访问权限，需要重新登录。
          </>
        }
        confirmLabel="退出设备"
        destructive
        busy={busy}
        onConfirm={kick}
      />
      <ConfirmDialog
        open={revokeOthers}
        onOpenChange={setRevokeOthers}
        title={`退出其它 ${others.length} 台设备？`}
        description="这些设备会立即失去访问权限，本机保持登录。"
        confirmLabel="全部退出"
        destructive
        busy={busy}
        onConfirm={kickOthers}
      />
    </div>
  )
}
