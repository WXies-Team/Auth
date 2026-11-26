import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/lib/auth'
import { toast } from 'sonner'
import { CheckCircle2, KeyRound, Loader2, Mail, Pencil, Trash2, XCircle } from 'lucide-react'
import { api } from '@/lib/api'
import type { ConfigItem } from '@/lib/types'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

const GROUPS: { title: string; desc: string; keys: string[] }[] = [
  {
    title: '邮件发信',
    desc: '四键齐全才会真正发信；改库 10 秒内热生效。',
    keys: ['mail_smtp_host', 'mail_smtp_port', 'mail_smtp_user', 'mail_smtp_pass'],
  },
  {
    title: '注销钩子',
    desc: '与两个日记服务共享的 Bearer 与各自注销地址。',
    keys: ['hook_token', 'hook_calorie_diary', 'hook_expense_diary'],
  },
  {
    title: 'Passkey / 两步验证',
    desc: 'Android 原生 origin 与强制两步验证的项目名单。',
    keys: ['webauthn_opaque_origins', 'totp_enforce_apps'],
  },
  {
    title: 'AI 限额',
    desc: '看板与限额闸共用的四档值。',
    keys: ['ai_rate_per_minute', 'ai_concurrency', 'ai_daily_per_user', 'ai_daily_global'],
  },
]

const LABELS: Record<string, string> = {
  mail_smtp_host: 'SMTP 主机',
  mail_smtp_port: 'SMTP 端口',
  mail_smtp_user: 'SMTP 账号',
  mail_smtp_pass: 'SMTP 密码',
  hook_token: '钩子 Bearer',
  hook_calorie_diary: '热量日记注销地址',
  hook_expense_diary: '开支日记注销地址',
  webauthn_opaque_origins: 'Android origin',
  totp_enforce_apps: '强制 2FA 项目',
  ai_rate_per_minute: '每分钟请求',
  ai_concurrency: '并发上限',
  ai_daily_per_user: '每用户每日',
  ai_daily_global: '全站每日',
}

export default function AdminConfigPage() {
  const qc = useQueryClient()
  const { session } = useAuth()
  const [testOpen, setTestOpen] = React.useState(false)
  const [testEmail, setTestEmail] = React.useState(session?.email ?? '')
  const [testBusy, setTestBusy] = React.useState(false)
  const { data, isLoading } = useQuery({ queryKey: ['admin-config'], queryFn: () => api.get<ConfigItem[]>('/admin/config') })
  const [edit, setEdit] = React.useState<ConfigItem | null>(null)
  const [value, setValue] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [clearItem, setClearItem] = React.useState<ConfigItem | null>(null)

  const byKey = new Map((data ?? []).map((i) => [i.key, i]))

  async function save() {
    if (!edit) return
    setBusy(true)
    try {
      await api.put(`/admin/config/${edit.key}`, { value })
      toast.success('已保存，≤10 秒生效')
      setEdit(null)
      setValue('')
      await qc.invalidateQueries({ queryKey: ['admin-config'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  if (isLoading) {
    return <div className="space-y-3"><Skeleton className="h-8 w-40" /><Skeleton className="h-48 w-full" /></div>
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="配置中心"
        description="白名单键；secret 只回末 4 位，留空表示不修改。"
        actions={
          <Button variant="outline" size="sm" onClick={() => setTestOpen(true)}>
            <Mail /> 发送测试邮件
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {GROUPS.map((g) => (
          <Card key={g.title}>
            <CardHeader>
              <CardTitle>{g.title}</CardTitle>
              <CardDescription>{g.desc}</CardDescription>
            </CardHeader>
            <CardContent className="divide-y p-0">
              {g.keys.map((key) => {
                const item = byKey.get(key)
                if (!item) return null
                return (
                  <div key={key} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        {LABELS[key] ?? key}
                        {item.secret && <KeyRound className="text-muted-foreground size-3.5" />}
                      </p>
                      <p className="text-muted-foreground truncate font-mono text-xs">
                        {item.configured
                          ? item.secret
                            ? `已配置 · ${item.hint || '••••'}`
                            : item.value || '（空）'
                          : '未配置'}
                      </p>
                    </div>
                    {item.configured ? (
                      <Badge variant="success"><CheckCircle2 className="size-3" /> 已配置</Badge>
                    ) : (
                      <Badge variant="outline"><XCircle className="size-3" /> 未配置</Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`编辑 ${LABELS[key] ?? key}`}
                      onClick={() => {
                        setEdit(item)
                        setValue(item.secret ? '' : item.value ?? '')
                      }}
                    >
                      <Pencil />
                    </Button>
                  </div>
                )
              })}
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={!!edit} onOpenChange={(v) => !v && setEdit(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑「{edit ? LABELS[edit.key] ?? edit.key : ''}」</DialogTitle>
            <DialogDescription>
              {edit?.secret ? ' secret 不回显原值；留空表示不修改，填写新值会整体替换。' : '保存后 ≤10 秒生效。'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="cfg-value">值</Label>
            <Input
              id="cfg-value"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={edit?.secret ? '留空则不修改' : '输入新值'}
            />
            <p className="text-muted-foreground font-mono text-xs">{edit?.key}</p>
          </div>
          <DialogFooter className="sm:justify-between">
            {edit?.configured ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive"
                onClick={() => setClearItem(edit)}
                disabled={busy}
              >
                <Trash2 /> 清空配置
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEdit(null)} disabled={busy}>取消</Button>
              <Button onClick={save} disabled={busy || (edit?.secret === true && !value)}>
                {busy && <Loader2 className="animate-spin" />} 保存
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={testOpen} onOpenChange={setTestOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>发送测试邮件</DialogTitle>
            <DialogDescription>用当前 SMTP 配置发一封最小邮件，验证发信链路。</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="test-email">收件邮箱</Label>
            <Input
              id="test-email"
              type="email"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              placeholder="默认发给当前管理员"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestOpen(false)} disabled={testBusy}>取消</Button>
            <Button
              onClick={async () => {
                setTestBusy(true)
                try {
                  await api.post('/admin/config/test-mail', { email: testEmail.trim() })
                  toast.success('测试邮件已发送，请查收')
                  setTestOpen(false)
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : '发送失败')
                } finally {
                  setTestBusy(false)
                }
              }}
              disabled={testBusy || !testEmail.trim()}
            >
              {testBusy && <Loader2 className="animate-spin" />} 发送
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!clearItem}
        onOpenChange={(v) => !v && setClearItem(null)}
        title={`清空「${clearItem ? LABELS[clearItem.key] ?? clearItem.key : ''}」？`}
        description="会从 app_config 删除该键；依赖它的功能会立即回到未配置状态。"
        confirmLabel="清空"
        destructive
        busy={busy}
        onConfirm={async () => {
          if (!clearItem) return
          setBusy(true)
          try {
            await api.put(`/admin/config/${clearItem.key}`, { value: '' })
            toast.success('已清空')
            setClearItem(null)
            setEdit(null)
            await qc.invalidateQueries({ queryKey: ['admin-config'] })
          } catch (err) {
            toast.error(err instanceof Error ? err.message : '清空失败')
          } finally {
            setBusy(false)
          }
        }}
      />
    </div>
  )
}
