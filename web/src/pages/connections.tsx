import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AppWindow, ShieldCheck, Unplug } from 'lucide-react'
import { api } from '@/lib/api'
import type { ConnectedApp } from '@/lib/types'
import { appLabel, dateTime, relativeTime } from '@/lib/format'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ListSkeleton } from '@/components/ui/skeleton'
import { useLoadingSkeleton } from '@/lib/use-loading'
import { EmptyState } from '@/components/ui/empty-state'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import * as React from 'react'

export default function ConnectionsPage() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['connected-apps'],
    queryFn: () => api.get<ConnectedApp[]>('/api/connected-apps'),
  })
  const [target, setTarget] = React.useState<ConnectedApp | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function revoke() {
    if (!target) return
    setBusy(true)
    try {
      await api.del(`/api/connected-apps/${target.app}`)
      toast.success('已撤销授权')
      setTarget(null)
      await qc.invalidateQueries({ queryKey: ['connected-apps'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '撤销失败')
    } finally {
      setBusy(false)
    }
  }

  const rows = data ?? []
  const showSkeleton = useLoadingSkeleton(isLoading)

  return (
    <div className="space-y-6">
      <PageHeader
        title="已授权应用"
        description="管理可以用你的账号登录的应用；撤销后，其登录会话会在下次校验时失效。"
      />

      <Card>
        <CardContent className="p-0">
          {showSkeleton ? (
            <ListSkeleton rows={2} action />
          ) : error ? (
            <EmptyState icon={Unplug} title="暂时无法读取授权列表" description="服务端可能尚未启用授权记录，请稍后再试。" />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={AppWindow}
              title="还没有授权过应用"
              description="在第三方应用里选择「用 Auth 登录」后，授权记录会出现在这里。"
            />
          ) : (
            <ul className="divide-y">
              {rows.map((row) => (
                <li key={row.app} className="flex flex-wrap items-center gap-3 px-4 py-4 sm:px-6">
                  <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-md">
                    <AppWindow className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium [overflow-wrap:anywhere]">
                      {row.name || appLabel(row.app)}
                      <Badge variant="secondary">{row.app}</Badge>
                    </p>
                    <p className="text-muted-foreground text-xs">
                      授权于 {dateTime(row.createdAt)} · 最近使用 {relativeTime(row.lastUsedAt)}
                    </p>
                    <p className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
                      <ShieldCheck className="size-3" />
                      权限：{row.scopes?.length ? row.scopes.map((s) => (s === 'uid' ? '账号标识' : s === 'email' ? '邮箱' : s)).join('、') : '账号标识与邮箱'}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" className="text-destructive" onClick={() => setTarget(row)}>
                    撤销授权
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!target}
        onOpenChange={(v) => !v && setTarget(null)}
        title={`撤销 ${target ? target.name || appLabel(target.app) : ''} 的授权？`}
        description="该应用将无法再用你的账号登录，直到你重新授权。"
        confirmLabel="撤销"
        destructive
        busy={busy}
        onConfirm={revoke}
      />
    </div>
  )
}
