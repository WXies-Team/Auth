import { useQuery } from '@tanstack/react-query'
import { Activity, CheckCircle2, Database, KeyRound, Mail, Server, XCircle } from 'lucide-react'
import { api } from '@/lib/api'
import type { SystemStatus } from '@/lib/types'
import { relativeTime } from '@/lib/format'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { StatCard } from '@/components/ui/stat-card'

function Status({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-sm">{label}</span>
      {ok ? (
        <Badge variant="success"><CheckCircle2 className="size-3" /> 正常</Badge>
      ) : (
        <Badge variant="destructive"><XCircle className="size-3" /> 未就绪</Badge>
      )}
    </div>
  )
}

export default function AdminSystemPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-status'],
    queryFn: () => api.get<SystemStatus>('/admin/status'),
    refetchInterval: 30_000,
  })

  return (
    <div className="space-y-4">
      <PageHeader title="系统状态" description="版本、数据库、邮件与 WebAuthn 配置自检；每 30 秒刷新。" />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="账号" value={data.counts.users} icon={Server} />
            <StatCard label="活跃会话" value={data.counts.sessions} icon={Activity} />
            <StatCard label="Passkey" value={data.counts.passkeys} icon={KeyRound} />
            <StatCard label="两步验证" value={data.counts.totp} icon={CheckCircle2} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>运行状态</CardTitle>
                <CardDescription>
                  {data.version} · 已运行 {Math.floor(data.uptimeSeconds / 3600)} 小时
                  {data.startedAt ? `（启动于 ${relativeTime(data.startedAt)}）` : ''}
                </CardDescription>
              </CardHeader>
              <CardContent className="divide-y">
                <Status ok={data.dbOK} label={`数据库 · ${data.dbLatencyMs} ms`} />
                <Status ok={data.mailConfigured} label="邮件发信" />
                <Status ok={data.jwtConfigured} label="JWT 密钥" />
                <Status ok={data.passkeysConfigured} label="Passkey / WebAuthn" />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>最近检查</CardTitle>
                <CardDescription>这些是进程内配置，不是外部探活；数据库延迟为本次查询耗时。</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex items-center gap-2">
                  <Database className="text-muted-foreground size-4" />
                  <span>数据库延迟 {data.dbLatencyMs} ms</span>
                </div>
                <div className="flex items-center gap-2">
                  <Mail className="text-muted-foreground size-4" />
                  <span>{data.mailConfigured ? 'SMTP 四键齐全' : 'SMTP 未配置，验证码邮件发不出去'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <KeyRound className="text-muted-foreground size-4" />
                  <span>{data.passkeysConfigured ? 'WebAuthn RP 已就绪' : 'WebAuthn 未配置'}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  )
}
