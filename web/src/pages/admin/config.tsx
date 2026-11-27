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

// 按「改动频率 + 影响面」分三档（设置页通行做法：常用项在上，罕用/高风险项
// 放进高级区）：常规是日常会调的开关与参数；集成是下游对接，改动要让对方同步；
// 高级基本不动，改错会中断登录、邮件或数据清理。
type Section = 'common' | 'integration' | 'advanced'
const SECTIONS: { id: Section; title: string; desc: string }[] = [
  { id: 'common', title: '常规', desc: '日常会调整的开关与参数。' },
  { id: 'integration', title: '集成', desc: '与下游服务对接；改动前先确认对方已同步。' },
  { id: 'advanced', title: '高级', desc: '基本不动；改错会中断登录、邮件或数据清理。' },
]

const GROUPS: { section: Section; title: string; desc: string; keys: string[] }[] = [
  {
    section: 'common',
    title: 'LLM 大模型',
    desc: '统一配置各接入应用的模型地址、模型与密钥；保存后 ≤10 秒生效。',
    keys: ['llm_base_url', 'llm_model', 'llm_api_key'],
  },
  {
    section: 'common',
    title: 'AI 限额',
    desc: '每用户与全站的调用频率、并发和每日额度。',
    keys: ['ai_rate_per_minute', 'ai_concurrency', 'ai_concurrency_global', 'ai_daily_per_user', 'ai_daily_global'],
  },
  {
    section: 'common',
    title: '注册与风险控制',
    desc: '自助注册默认关闭；泄露库校验与「新 IP 强制 2FA」默认开启。',
    keys: ['allow_self_register', 'password_breach_check', 'risk_new_ip_mfa'],
  },
  {
    section: 'integration',
    title: '邮件发信',
    desc: '四键齐全后才会真正发信，保存后 ≤10 秒生效。',
    keys: ['mail_smtp_host', 'mail_smtp_port', 'mail_smtp_user', 'mail_smtp_pass'],
  },
  {
    section: 'integration',
    title: '注销钩子',
    desc: '与各接入应用共享的 Bearer 令牌与各自的注销地址。',
    keys: ['hook_token', 'hook_calorie_diary', 'hook_expense_diary'],
  },
  {
    section: 'integration',
    title: '推送',
    desc: '各接入应用调用推送管理端点所需的 Bearer 令牌。',
    keys: ['push_admin_token'],
  },
  {
    section: 'advanced',
    title: 'Android Passkey',
    desc: '原生 App 的签名指纹；只有更换签名时才需要更新。',
    keys: ['webauthn_opaque_origins'],
  },
  {
    section: 'advanced',
    title: '审计',
    desc: '审计日志保留天数（7–365，默认 90）。',
    keys: ['audit_retention_days'],
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
    help: '各接入 App 的原生签名指纹，精确匹配；格式错误会让对应 App 的 Passkey 仪式被拒。',
  },
  audit_retention_days: { kind: 'number', min: 7, max: 365 },
  llm_base_url: {
    kind: 'text',
    placeholder: 'https://…/v1/chat/completions',
    help: '可填完整端点（含 /chat/completions）或 Base URL（…/v1），下游服务都兼容。',
  },
  llm_model: { kind: 'text', placeholder: '上游模型 ID，如 gpt-5.1' },
  llm_api_key: { kind: 'text', placeholder: '上游 API Key' },
  ai_rate_per_minute: { kind: 'number', min: 1, max: 1000000 },
  ai_concurrency: { kind: 'number', min: 1, max: 1000 },
  ai_concurrency_global: { kind: 'number', min: 1, max: 1000 },
  push_admin_token: { kind: 'text', placeholder: 'Bearer 令牌' },
  ai_daily_per_user: { kind: 'number', min: 1, max: 100000000 },
  ai_daily_global: { kind: 'number', min: 1, max: 100000000 },
}

function fieldOf(key: string): FieldMeta {
  return FIELDS[key] ?? { kind: 'text' }
}

// 行内摘要：让管理员一眼看到**生效值**，而不是一串原始逗号串。布尔必须永远可读
//（哪怕是 secret 命名的键）——开关值被掩码成「默认」正是「设为关却恒开」的来源。
function fieldSummary(item: ConfigItem, meta: FieldMeta): string {
  if (meta.kind === 'bool') {
    const on = item.configured ? item.value === '1' : !!meta.defaultOn
    return item.configured ? (on ? '已开启' : '已关闭') : on ? '默认开启' : '默认关闭'
  }
  if (!item.configured) return '未设置'
  if (item.secret) return `末 4 位 ${item.hint || '••••'}`
  if (meta.kind === 'lines') {
    const n = (item.value ?? '').split(/[,\n]/).filter((x) => x.trim()).length
    return `${n} 条`
  }
  return item.value || '（空）'
}

// 与服务端 isSecretConfigKey 同一口径的**后缀**判断：用于还没入库的键（服务端
// 不回 secret 标志），避免未配置的 API Key 被当成普通文本显示/编辑。
const SECRET_SUFFIXES = ['_secret', '_token', '_pass', '_password', '_key', '_apikey', '_credential']
function looksSecret(key: string): boolean {
  return SECRET_SUFFIXES.some((suffix) => key.toLowerCase().endsWith(suffix))
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
  llm_base_url: '接口地址',
  llm_model: '模型名',
  llm_api_key: 'API 密钥',
  ai_rate_per_minute: '每分钟请求',
  ai_concurrency: '每用户并发',
  ai_concurrency_global: '全站并发',
  ai_daily_per_user: '每用户每日',
  ai_daily_global: '全站每日',
  push_admin_token: '推送管理令牌',
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
  const [savingKey, setSavingKey] = React.useState<string | null>(null)
  const [clearItem, setClearItem] = React.useState<ConfigItem | null>(null)

  const byKey = new Map((data ?? []).map((i) => [i.key, i]))
  const editMeta = edit ? fieldOf(edit.key) : null

  // 允许 Base URL 或完整端点，但必须能解析成 http(s) 链接——写错协议下游只会报
  //「AI 不可用」，排查要从这里开始。清空走「清空配置」，不在此处放行空串。
  function validLLMBaseURL(v: string) {
    if (!v) return true
    try {
      const u = new URL(v)
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch {
      return false
    }
  }

  async function save() {
    if (!edit) return
    const payload = value.trim()
    if (edit.key === 'llm_base_url' && !validLLMBaseURL(payload)) {
      toast.error('接口地址必须是 http(s) 链接，例如 https://opencode.ai/inference/go/openai/v1/chat/completions')
      return
    }
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

  // 布尔项只有开/关：直接拨开关就写库，不再套一层编辑弹窗。
  async function setBool(item: ConfigItem, on: boolean) {
    const label = LABELS[item.key] ?? item.key
    setSavingKey(item.key)
    try {
      await api.put(`/admin/config/${item.key}`, { value: on ? '1' : '0' })
      toast.success(`${label}已${on ? '开启' : '关闭'}，≤10 秒生效`)
      await qc.invalidateQueries({ queryKey: ['admin-config'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSavingKey(null)
    }
  }

  async function restoreDefault(item: ConfigItem, meta: FieldMeta) {
    const label = LABELS[item.key] ?? item.key
    setSavingKey(item.key)
    try {
      await api.put(`/admin/config/${item.key}`, { value: '' })
      toast.success(`${label}已恢复默认${meta.defaultOn ? '开启' : '关闭'}，≤10 秒生效`)
      await qc.invalidateQueries({ queryKey: ['admin-config'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '恢复默认失败')
    } finally {
      setSavingKey(null)
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
        description="统一管理部署级配置：邮件、注销钩子、模型接入与限额。项目级策略在「项目访问」页。"
        actions={
          <Button variant="outline" size="sm" onClick={() => setTestOpen(true)}>
            <Mail /> 发送测试邮件
          </Button>
        }
      />

      {SECTIONS.map((section) => (
        <section key={section.id} className="space-y-3">
          <div>
            <h2 className="text-sm font-medium">{section.title}</h2>
            <p className="text-muted-foreground text-xs">{section.desc}</p>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {GROUPS.filter((g) => g.section === section.id).map((g) => (
              <Card key={g.title}>
                <CardHeader>
                  <CardTitle>{g.title}</CardTitle>
                  <CardDescription>{g.desc}</CardDescription>
                </CardHeader>
                <CardContent className="divide-y p-0">
                  {g.keys.map((key) => {
                    // 尚未入库的键也显示出来（badge=未设置），否则新开关没有创建入口。
                    const item = byKey.get(key) ?? {
                      key,
                      value: '',
                      configured: false,
                      secret: looksSecret(key),
                      hint: '',
                    }
                    const meta = fieldOf(key)
                    return (
                      <div key={key} className="flex items-center gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-2 text-sm font-medium">
                            {LABELS[key] ?? key}
                            {item.secret && meta.kind !== 'bool' && <KeyRound className="text-muted-foreground size-3.5" />}
                          </p>
                          <p
                            className="text-muted-foreground truncate text-xs"
                            title={!item.secret && item.configured ? item.value : undefined}
                          >
                            {fieldSummary(item, meta)}
                          </p>
                        </div>
                        {item.configured ? (
                          <Badge variant="success"><CheckCircle2 className="size-3" /> 已设置</Badge>
                        ) : meta.kind === 'bool' ? (
                          <Badge variant="outline">默认值</Badge>
                        ) : (
                          <Badge variant="outline"><XCircle className="size-3" /> 未设置</Badge>
                        )}
                        {meta.kind === 'bool' ? (
                          <div className="flex items-center gap-1.5">
                            {item.configured && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-muted-foreground h-7 px-2 text-xs"
                                disabled={savingKey === key}
                                onClick={() => void restoreDefault(item, meta)}
                              >
                                恢复默认
                              </Button>
                            )}
                            <Switch
                              aria-label={`${LABELS[key] ?? key}开关`}
                              checked={item.configured ? item.value === '1' : !!meta.defaultOn}
                              disabled={savingKey === key}
                              onCheckedChange={(v) => void setBool(item, v)}
                            />
                          </div>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`编辑 ${LABELS[key] ?? key}`}
                            onClick={() => openEdit(item)}
                          >
                            <Pencil />
                          </Button>
                        )}
                      </div>
                    )
                  })}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ))}

      <Dialog open={!!edit} onOpenChange={(v) => !v && setEdit(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑「{edit ? LABELS[edit.key] ?? edit.key : ''}」</DialogTitle>
            <DialogDescription>
              {edit?.secret
                ? '凭据不回显原值；留空表示不修改，填写新值会整体替换。'
                : '保存后 ≤10 秒生效。'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="cfg-value">值</Label>
            {editMeta?.kind === 'number' ? (
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
                <Trash2 /> 清除设置
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
        title={`清除「${clearItem ? LABELS[clearItem.key] ?? clearItem.key : ''}」？`}
        description="会从 app_config 删除该键；依赖它的功能会立即回到未设置状态。"
        confirmLabel="清除"
        destructive
        busy={busy}
        onConfirm={async () => {
          if (!clearItem) return
          setBusy(true)
          try {
            await api.put(`/admin/config/${clearItem.key}`, { value: '' })
            toast.success('已清除')
            setClearItem(null)
            setEdit(null)
            await qc.invalidateQueries({ queryKey: ['admin-config'] })
          } catch (err) {
            toast.error(err instanceof Error ? err.message : '操作失败')
          } finally {
            setBusy(false)
          }
        }}
      />
    </div>
  )
}
