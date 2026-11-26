import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Activity, ChartColumn, Loader2, Settings2, TrendingDown, TrendingUp, Users } from 'lucide-react'
import { Area, AreaChart, ResponsiveContainer, Tooltip as ReTooltip, XAxis } from 'recharts'
import { api } from '@/lib/api'
import type { AIUsage } from '@/lib/types'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { useLoadingSkeleton } from '@/lib/use-loading'
import { StatCard } from '@/components/ui/stat-card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function AdminAIPage() {
  const qc = useQueryClient()
  const [days, setDays] = React.useState('30')
  const [quotaOpen, setQuotaOpen] = React.useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['ai-usage', days],
    queryFn: () => api.get<AIUsage>(`/admin/ai-usage?days=${days}`),
  })

  const showSkeleton = useLoadingSkeleton(isLoading)
  const delta = data ? data.today - data.yesterday : 0
  const chart = (data?.days ?? []).map((d) => ({ ...d, label: d.date.slice(5) }))

  return (
    <div className="space-y-4">
      <PageHeader
        title="AI 用量"
        description="按用户聚合的调用次数与限额；空表如实为空。"
        actions={
          <>
            <Select aria-label="时间范围" className="w-32" value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="7">近 7 天</option>
              <option value="30">近 30 天</option>
              <option value="90">近 90 天</option>
            </Select>
            <Button variant="outline" size="sm" onClick={() => setQuotaOpen(true)}>
              <Settings2 /> 编辑限额
            </Button>
          </>
        }
      />

      {showSkeleton ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="今日调用" value={data?.today ?? 0} hint={delta === 0 ? '与昨日持平' : `较昨日 ${delta > 0 ? '+' : ''}${delta}`} icon={ChartColumn} />
            <StatCard
              label="全站剩余"
              value={data?.global ? Math.max(0, data.global.limit - data.global.used) : '—'}
              hint={data?.global ? `已用 ${data.global.used} / ${data.global.limit}` : '仅平台管理员可见'}
              icon={Activity}
            />
            <StatCard label="今日活跃" value={data?.activeToday ?? 0} hint="今日有调用的用户数" icon={Users} />
            <StatCard label="默认限额档" value={data?.defaultsUsed ?? 0} hint="0 = 四档均已显式配置" icon={Settings2} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                调用趋势
                {delta >= 0 ? <Badge variant="warning"><TrendingUp /> 上升</Badge> : <Badge variant="success"><TrendingDown /> 下降</Badge>}
              </CardTitle>
              <CardDescription>按天合计，未用量的日期补 0。</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chart} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                    <defs>
                      <linearGradient id="aiFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" />
                    <ReTooltip
                      contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                      labelStyle={{ color: 'var(--muted-foreground)' }}
                    />
                    <Area type="monotone" dataKey="count" name="调用" stroke="var(--chart-1)" fill="url(#aiFill)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>用户明细</CardTitle>
              <CardDescription>按区间用量倒序；进度条是今日用量 / 每用户每日限额。</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {(data?.users ?? []).length === 0 ? (
                <p className="text-muted-foreground p-6 text-sm">所选区间内暂无用量记录。</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>用户</TableHead>
                      <TableHead>今日</TableHead>
                      <TableHead>区间</TableHead>
                      <TableHead className="w-48">今日限额</TableHead>
                      <TableHead>占比</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data!.users.map((u) => (
                      <TableRow key={u.uid}>
                        <TableCell>
                          <p className="text-sm font-medium">{u.email}</p>
                          <p className="text-muted-foreground text-xs">uid {u.uid}</p>
                        </TableCell>
                        <TableCell className="tabular-nums">{u.today}</TableCell>
                        <TableCell className="tabular-nums">{u.range}</TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            <Progress value={u.limitToday ? Math.min(100, (u.today / u.limitToday) * 100) : 0} aria-label={`${u.email} 今日限额`} />
                            <p className="text-muted-foreground text-xs">{u.today} / {u.limitToday}</p>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">{(u.share * 100).toFixed(1)}%</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <QuotaDialog open={quotaOpen} onOpenChange={setQuotaOpen} onDone={() => void qc.invalidateQueries({ queryKey: ['ai-usage'] })} />
    </div>
  )
}

function QuotaDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [values, setValues] = React.useState({ rate: '', conc: '', user: '', global: '' })
  const [busy, setBusy] = React.useState(false)
  const keys = [
    ['rate', 'ai_rate_per_minute', '每分钟请求'],
    ['conc', 'ai_concurrency', '并发上限'],
    ['user', 'ai_daily_per_user', '每用户每日'],
    ['global', 'ai_daily_global', '全站每日'],
  ] as const

  async function save() {
    setBusy(true)
    const saved: string[] = []
    try {
      for (const [k, key, label] of keys) {
        const v = values[k].trim()
        if (!v) continue
        await api.put(`/admin/config/${key}`, { value: v })
        saved.push(label)
      }
      toast.success(saved.length ? `已保存：${saved.join('、')}` : '没有修改')
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.error(`${saved.length ? `已保存 ${saved.length} 项；` : ''}${err instanceof Error ? err.message : '保存失败'}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑 AI 限额</DialogTitle>
          <DialogDescription>留空表示不修改。正整数，保存后 ≤10 秒生效。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {keys.map(([k, , label]) => (
            <div key={k} className="space-y-1.5">
              <Label>{label}</Label>
              <Input
                inputMode="numeric"
                value={values[k]}
                onChange={(e) => setValues((prev) => ({ ...prev, [k]: e.target.value.replace(/\D/g, '') }))}
                placeholder="留空不改"
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />} 保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
