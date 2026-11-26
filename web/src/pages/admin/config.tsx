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
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
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
    keys: ['webauthn_opaque_origins'],
  },
  {
    title: 'AI 限额',
    desc: '看板与限额闸共用的四档值。',
    keys: ['ai_rate_per_minute', 'ai_concurrency', 'ai_daily_per_user', 'ai_daily_global'],
  },
  {
    title: '审计',
    desc: '审计日志保留天数（7–365，缺省 90）。',
    keys: ['audit_retention_days'],
  },
  {
    title: '注册与风险控制',
    desc: '自助注册默认关闭；泄露库校验与「新 IP 强制 2FA」默认开启（填 0 关闭）。',
    keys: ['allow_self_register', 'password_breach_check', 'risk_new_ip_mfa'],
  },
]

// 每个键的控件类型：配置中心不再让管理员手填逗号串/1/0，按语义出开关、
// 项目复选框、数字框或多行文本（表单校验仍在服务端做最后一道）。
type FieldKind = 'text' | 'number' | 'bool' | 'lines'
type FieldMeta = {
  kind: FieldKind
  min?: number
  max?: number
  placeholder?: string
  help?: string
  defaultOn?: boolean
  rows?: number
}

const FIELDS: Record<string, FieldMeta> = {
  mail_smtp_port: { kind: 'number', min: 1, max: 65535 },
  allow_self_register: {
    kind: 'bool',
    defaultOn: false,
    help: '关闭时仅邀请可建号；开启后登录页出现「创建账号」。',
  },
  password_breach_check: {
    kind: 'bool',
    defaultOn: true,
    help: '注册/改密时用 HIBP k-Anonymity 检查是否已泄露；第三方不可用时放行。',
  },
  risk_new_ip_mfa: {
    kind: 'bool',
    defaultOn: true,
    help: '新 IP 登录即使有可信设备也要求两步验证；关闭后仍会发新地点提醒邮件。',
  },
  webauthn_opaque_origins: {
    kind: 'lines',
    rows: 4,
    placeholder: 'android:apk-key-hash:…（每行一条，最多 8 条）',
    help: '两个 App 的原生签名指纹，精确匹配；格式错误会让对应 App 的 Passkey 仪式被拒。',
  },
  audit_retention_days: { kind: 'number', min: 7, max: 365 },
  ai_rate_per_minute: { kind: 'number', min: 1, max: 1000000 },
  ai_concurrency: { kind: 'number', min: 1, max: 1000 },
  ai_daily_per_user: { kind: 'number', min: 1, max: 100000000 },
  ai_daily_global: { kind: 'number', min: 1, max: 100000000 },
}

function fieldOf(key: string): FieldMeta {
  return FIELDS[key] ?? { kind: 'text' }
}

// 行内摘要：让管理员一眼看到**生效值**，而不是一串原始逗号串。
function fieldSummary(item: ConfigItem, meta: FieldMeta): string {
  if (!item.configured) {
    if (meta.kind === 'bool') return meta.defaultOn ? '未配置 · 默认开启' : '未配置 · 默认关闭'
    return '未配置'
  }
  if (meta.kind === 'bool') return item.value === '1' ? '已开启' : '已关闭'
  if (meta.kind === 'lines') {
    const n = (item.value ?? '').split(/[,\n]/).filter((x) => x.trim()).length
    return `${n} 条`
  }
  return item.value || '（空）'
}

const LABELS: Record<string, string> = {
  mail_smtp_host: 'SMTP 主机',
  mail_smtp_port: 'SMTP 端口',
  mail_smtp_user: 'SMTP 账号',
  mail_smtp_pass: 'SMTP 密码',
  hook_token: '钩子 Bearer',
  hook_calorie_diary: '热量日记注销地址',
  hook_expense_diary: '开支日记注销地址',
  webauthn_opaque_origins: 'Android origin',
  ai_rate_per_minute: '每分钟请求',
  ai_concurrency: '并发上限',
  ai_daily_per_user: '每用户每日',
  ai_daily_global: '全站每日',
  audit_retention_days: '审计保留天数',
  allow_self_register: '开放自助注册',
  password_breach_check: '密码泄露库校验',
  risk_new_ip_mfa: '新 IP 强制 2FA',
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
  const editMeta = edit ? fieldOf(edit.key) : null

  async function save() {
    if (!edit) return
    const payload = value.trim()
    setBusy(true)
    try {
      await api.put(`/admin/config/${edit.key}`, { value: payload })
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

  function openEdit(item: ConfigItem) {
    const meta = fieldOf(item.key)
    setEdit(item)
    if (item.secret) {
      setValue('')
    } else if (meta.kind === 'lines') {
      // 库里是逗号串，编辑框按「每行一条」展示，保存时原样交回（服务端归一化）。
      setValue((item.value ?? '').split(',').join('\n'))
    } else {
      setValue(item.value ?? '')
    }
  }

  if (isLoading) {
    return <div className="space-y-3"><Skeleton className="h-8 w-40" /><Skeleton className="h-48 w-full" /></div>
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="配置中心"
        description="白名单键；开关、数字、多行列表用对应控件，secret 只回末 4 位。项目级策略在「项目访问」页。"
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
                // 尚未入库的键也显示出来（badge=未配置），否则新开关没有创建入口。
                const item = byKey.get(key) ?? {
                  key,
                  value: '',
                  configured: false,
                  secret: false,
                  hint: '',
                }
                const meta = fieldOf(key)
                return (
                  <div key={key} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        {LABELS[key] ?? key}
                        {item.secret && <KeyRound className="text-muted-foreground size-3.5" />}
                      </p>
                      <p className="text-muted-foreground truncate text-xs">
                        {item.secret ? (item.configured ? `已配置 · ${item.hint || '••••'}` : '未配置') : fieldSummary(item, meta)}
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
                      onClick={() => openEdit(item)}
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
          <div className="space-y-2">
            <Label htmlFor="cfg-value">值</Label>
            {editMeta?.kind === 'bool' ? (
              <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">
                    {value === '' ? (editMeta.defaultOn ? '默认开启' : '默认关闭') : value === '1' ? '已开启' : '已关闭'}
                  </p>
                  <p className="text-muted-foreground text-xs">{editMeta.help}</p>
                </div>
                <Switch
                  aria-label={`${edit ? LABELS[edit.key] ?? edit.key : ''}开关`}
                  checked={value === '' ? !!editMeta.defaultOn : value === '1'}
                  onCheckedChange={(v) => setValue(v ? '1' : '0')}
                />
              </div>
            ) : editMeta?.kind === 'number' ? (
              <Input
                id="cfg-value"
                type="number"
                inputMode="numeric"
                autoFocus
                min={editMeta.min}
                max={editMeta.max}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={editMeta.placeholder ?? '输入整数'}
              />
            ) : editMeta?.kind === 'lines' ? (
              <Textarea
                id="cfg-value"
                autoFocus
                rows={editMeta.rows ?? 3}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={editMeta.placeholder}
                className="font-mono text-xs"
              />
            ) : (
              <Input
                id="cfg-value"
                autoFocus
                type={edit?.secret ? 'password' : 'text'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={edit?.secret ? '留空则不修改' : (editMeta?.placeholder ?? '输入新值')}
              />
            )}
            {editMeta?.help && editMeta.kind !== 'bool' && (
              <p className="text-muted-foreground text-xs">{editMeta.help}</p>
            )}
            {editMeta?.kind === 'number' && (editMeta.min != null || editMeta.max != null) && (
              <p className="text-muted-foreground text-xs">
                允许范围：{editMeta.min ?? '—'} ~ {editMeta.max ?? '—'}
              </p>
            )}
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
              <Button
                onClick={save}
                disabled={
                  busy ||
                  (edit?.secret === true && !value) ||
                  (editMeta?.kind === 'number' &&
                    value.trim() !== '' &&
                    (Number.isNaN(Number(value)) ||
                      (editMeta.min != null && Number(value) < editMeta.min) ||
                      (editMeta.max != null && Number(value) > editMeta.max)))
                }
              >
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
