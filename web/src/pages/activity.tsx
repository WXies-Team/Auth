import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, CheckCircle2, XCircle } from 'lucide-react'
import { api } from '@/lib/api'
import type { AuditRow, Page } from '@/lib/types'
import { dateTime, relativeTime } from '@/lib/format'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { Pagination } from '@/components/ui/pagination'
import { Button } from '@/components/ui/button'

const ACTION_LABEL: Record<string, string> = {
  'login.success': '登录成功',
  'login.fail': '登录失败',
  'password.change': '修改密码',
  'password.reset': '重置密码',
  'email.change': '改绑邮箱',
  'user.email_change': '改绑邮箱',
  'passkey.create': '添加 Passkey',
  'passkey.rename': 'Passkey 改名',
  'passkey.delete': '删除 Passkey',
  'totp.setup': '开始绑定两步验证',
  'totp.enable': '开启两步验证',
  'totp.disable': '关闭两步验证',
  'recovery.generate': '重新生成恢复码',
  'recovery.consume': '使用恢复码',
  reauth: '重新验证',
  'profile.update': '更新资料',
  'session.kick': '退出设备',
  'account.delete_requested': '申请注销账号',
  'account.delete_cancelled': '撤销注销申请',
  'user.invite_accept': '接受邀请',
}

function label(action: string) {
  return ACTION_LABEL[action] ?? action
}

const PAGE = 20

export default function ActivityPage() {
  const [page, setPage] = React.useState(1)
  const { data, isLoading } = useQuery({
    queryKey: ['security-log', page],
    queryFn: () => api.get<Page<AuditRow>>(`/api/security-log?limit=${PAGE}&offset=${(page - 1) * PAGE}`),
  })

  const rows = data?.items ?? []

  return (
    <div className="space-y-4">
      <PageHeader
        title="安全活动"
        description="最近的登录、改密、凭证变更与会话操作。发现不认识的活动时，立即改密并退出其它设备。"
        actions={
          <Button variant="outline" size="sm" asChild>
            <a href="/web/console/sessions">管理登录设备</a>
          </Button>
        }
      />

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon={Activity} title="还没有安全活动" description="登录、改密或管理凭证后，事件会出现在这里。" />
          ) : (
            <ul className="divide-y">
              {rows.map((row) => (
                <li key={row.id} className="flex flex-wrap items-start gap-3 p-4">
                  <div
                    className={
                      'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ' +
                      (row.result === 'ok' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-destructive/10 text-destructive')
                    }
                  >
                    {row.result === 'ok' ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {label(row.action)}
                      {row.result !== 'ok' && <Badge variant="destructive">失败</Badge>}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {dateTime(row.ts)} · {relativeTime(row.ts)}
                      {row.ip ? ` · ${row.ip}` : ''}
                    </p>
                    {row.detail && Object.keys(row.detail).length > 0 && (
                      <p className="text-muted-foreground mt-0.5 truncate text-xs">
                        {Object.entries(row.detail)
                          .filter(([k]) => !['app'].includes(k))
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(' · ')}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {data && data.total > PAGE && (
        <Pagination page={page} pageSize={PAGE} total={data.total} onPage={setPage} />
      )}
    </div>
  )
}
