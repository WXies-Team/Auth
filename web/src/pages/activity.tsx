import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, CheckCircle2, XCircle } from 'lucide-react'
import { api } from '@/lib/api'
import type { AuditRow, Page } from '@/lib/types'
import { dateTime, relativeTime } from '@/lib/format'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ListSkeleton } from '@/components/ui/skeleton'
import { useLoadingSkeleton } from '@/lib/use-loading'
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
  'account.delete': '注销账号',
  'user.invite': '发出邀请',
  'user.invite_resend': '重发邀请',
  'user.invite_revoke': '撤销邀请',
  'user.invite_accept': '接受邀请',
  'user.ban': '封禁账号',
  'user.unban': '解除封禁',
  'user.profile_reset': '重置资料',
  'admin.user.role_change': '管理员调整角色',
  'admin.role.change': '管理员调整角色',
  'admin.role.grant': '授予项目管理员',
  'admin.role.revoke': '回收项目管理员',
  'admin.user.session_revoke': '管理员吊销会话',
  'admin.session.revoke': '管理员吊销会话',
  'admin.config.set': '管理员修改配置',
  'admin.bulk_action': '管理员批量操作',
  'admin.oauth_client.write': '管理员配置 OAuth 客户端',
  'admin.mfa.reset': '管理员重置两步验证',
  'admin.audit.view': '管理员查看审计',
  'project.access_grant': '加入项目',
  'project.access_revoke': '移出项目',
  'project.restrict_on': '项目改为仅限受邀',
  'project.restrict_off': '项目改为开放登录',
  'oauth.consent_grant': '授权应用',
  'oauth.consent_revoke': '撤销应用授权',
  'internal.ensure': '存量账号并入',
  logout: '退出登录',
  register: '注册账号',
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
  const showSkeleton = useLoadingSkeleton(isLoading)

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
          {showSkeleton ? (
            <ListSkeleton rows={4} />
          ) : rows.length === 0 ? (
            <EmptyState icon={Activity} title="还没有安全活动" description="登录、改密或管理凭证后，事件会出现在这里。" />
          ) : (
            <ul className="divide-y">
              {rows.map((row) => (
                <li key={row.id} className="flex flex-wrap items-start gap-3 p-4">
                  <div
                    className={
                      'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ' +
                      (row.result === 'ok' ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive')
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
