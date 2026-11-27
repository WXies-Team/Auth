import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Download,
  Loader2,
  Save,
  ShieldAlert,
  Trash2,
  Upload,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useProfile } from '@/lib/queries'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { AVATAR_PALETTE as PALETTE, avatarDataUrl, initials } from '@/lib/format'
import { cn } from '@/lib/utils'

async function fileToAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件')
  const bitmap = await createImageBitmap(file)
  const max = 512
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1]!
}

export default function AccountPage() {
  const { session, logout } = useAuth()
  const qc = useQueryClient()
  const { data: profile } = useProfile()

  const [nickname, setNickname] = React.useState('')
  const [color, setColor] = React.useState(0)
  const [image, setImage] = React.useState<string | null>(null)
  const [loginNotify, setLoginNotify] = React.useState(true)
  const [savingProfile, setSavingProfile] = React.useState(false)

  React.useEffect(() => {
    if (!profile) return
    setNickname(profile.nickname)
    setColor(profile.avatarColor || 0)
    setImage(profile.avatarImage)
    setLoginNotify(profile.loginNotify)
  }, [profile])

  const dirty =
    !!profile &&
    (nickname !== profile.nickname || color !== profile.avatarColor || image !== profile.avatarImage)

  async function saveProfile() {
    setSavingProfile(true)
    try {
      await api.put('/api/profile', { nickname: nickname.trim(), avatarColor: color, avatarImage: image })
      toast.success('资料已保存')
      await qc.invalidateQueries({ queryKey: ['profile'] })
      await qc.invalidateQueries({ queryKey: ['session'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSavingProfile(false)
    }
  }

  async function toggleNotify(next: boolean) {
    const prev = loginNotify
    setLoginNotify(next)
    try {
      await api.put('/api/profile', {
        nickname: profile?.nickname ?? '',
        avatarColor: profile?.avatarColor ?? 0,
        avatarImage: profile?.avatarImage ?? null,
        loginNotify: next,
      })
      toast.success(next ? '已开启新设备登录提醒' : '已关闭新设备登录提醒')
      await qc.invalidateQueries({ queryKey: ['profile'] })
    } catch (err) {
      setLoginNotify(prev)
      toast.error(err instanceof Error ? err.message : '保存失败')
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="账号" description="管理资料、登录凭据、邮箱与账号注销。" />

      <Card>
        <CardHeader>
          <CardTitle>个人资料</CardTitle>
          <CardDescription>昵称和头像会显示在控制台与已接入的应用中。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-center gap-4">
            <Avatar className="size-16">
              <AvatarImage src={avatarDataUrl(image)} alt="" />
              <AvatarFallback className="text-xl" style={{ background: PALETTE[color] ?? PALETTE[0], color: '#fff' }}>
                {initials(nickname || session?.email || '?')}
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <label className="cursor-pointer">
                  <Upload /> 上传头像
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0]
                      e.target.value = ''
                      if (!file) return
                      try {
                        setImage(await fileToAvatar(file))
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : '图片处理失败')
                      }
                    }}
                  />
                </label>
              </Button>
              {image && (
                <Button variant="ghost" size="sm" onClick={() => setImage(null)}>
                  移除头像
                </Button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="nickname">昵称</Label>
              <Input
                id="nickname"
                value={nickname}
                maxLength={64}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="留空则显示邮箱前缀"
              />
            </div>
            <div className="space-y-1.5">
              <Label>头像底色</Label>
              <div className="flex flex-wrap gap-2">
                {PALETTE.map((hex, i) => (
                  <button
                    key={hex}
                    type="button"
                    aria-label={`颜色 ${i + 1}`}
                    aria-pressed={color === i}
                    onClick={() => setColor(i)}
                    className={cn(
                      'size-8 rounded-full ring-2 ring-offset-2 ring-offset-background transition',
                      color === i ? 'ring-foreground' : 'ring-transparent',
                    )}
                    style={{ background: hex }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={saveProfile} disabled={!dirty || savingProfile}>
              {savingProfile ? <Loader2 className="animate-spin" /> : <Save />} 保存资料
            </Button>
            {dirty && <span className="text-muted-foreground text-xs">有未保存的修改</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>登录邮箱</CardTitle>
          <CardDescription>当前：{session?.email}。改绑后新旧邮箱都会收到通知。</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangeEmailForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>修改密码</CardTitle>
          <CardDescription>改密成功后其它设备会被登出，本机保持登录。</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>登录提醒</CardTitle>
          <CardDescription>新设备登录时发邮件提醒；同一设备不会重复打扰。</CardDescription>
        </CardHeader>
        <CardContent>
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm">新设备登录时发送邮件提醒</span>
            <Switch checked={loginNotify} onCheckedChange={(v) => void toggleNotify(v)} />
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>数据与隐私</CardTitle>
          <CardDescription>导出账号资料、会话、凭证与安全活动记录。</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                const data = await api.post<unknown>('/api/account/export')
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `auth-export-${new Date().toISOString().slice(0, 10)}.json`
                a.click()
                URL.revokeObjectURL(url)
                toast.success('导出已开始下载')
              } catch (err) {
                toast.error(err instanceof Error ? err.message : '导出失败')
              }
            }}
          >
            <Download /> 导出我的数据
          </Button>
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-destructive">注销账号</CardTitle>
          <CardDescription>
            提交后进入 7 天宽限期，期间可用邮件里的链接撤销；到期后账号资料与各应用中的业务数据会一起删除。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DeleteAccount
            email={session?.email ?? ''}
            onDone={async () => {
              await logout()
              window.location.assign('/web/login')
            }}
          />
        </CardContent>
      </Card>
    </div>
  )
}

function ChangePasswordForm() {
  const [mode, setMode] = React.useState<'old' | 'code'>('old')
  const [oldPw, setOldPw] = React.useState('')
  const [newPw, setNewPw] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [code, setCode] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (newPw.length < 8) return setError('新密码至少 8 位')
    if (newPw !== confirm) return setError('两次输入的新密码不一致')
    setBusy(true)
    try {
      if (mode === 'old') {
        await api.post('/auth/change-password', { oldPassword: oldPw, newPassword: newPw })
      } else {
        await api.post('/auth/change-password-code', { code: code.trim(), password: newPw })
      }
      toast.success('密码已更新')
      setOldPw('')
      setNewPw('')
      setConfirm('')
      setCode('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '改密失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Tabs value={mode} onValueChange={(v) => { setMode(v as 'old' | 'code'); setError('') }}>
      <TabsList>
        <TabsTrigger value="old">原密码</TabsTrigger>
        <TabsTrigger value="code">邮箱验证码</TabsTrigger>
      </TabsList>
      <form onSubmit={submit} className="mt-3 space-y-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {mode === 'old' ? (
          <div className="space-y-1.5">
            <Label htmlFor="old-pw">当前密码</Label>
            <PasswordInput id="old-pw" autoComplete="current-password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="pw-code">邮箱验证码</Label>
            <div className="flex gap-2">
              <Input id="pw-code" value={code} onChange={(e) => setCode(e.target.value)} className="flex-1" />
              <Button
                type="button"
                variant="outline"
                onClick={() => void api.post('/auth/send-change-code', {}).then(() => toast.success('验证码已发送')).catch((e) => toast.error(e.message))}
              >
                发送
              </Button>
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-pw">新密码</Label>
            <PasswordInput id="new-pw" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-pw2">确认新密码</Label>
            <PasswordInput id="new-pw2" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
        </div>
        <Button type="submit" disabled={busy || newPw.length < 8}>
          {busy && <Loader2 className="animate-spin" />} 更新密码
        </Button>
      </form>
    </Tabs>
  )
}

function ChangeEmailForm() {
  const qc = useQueryClient()
  const [email, setEmail] = React.useState('')
  const [code, setCode] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await api.post('/auth/change-email', { password, email: email.trim(), code: code.trim() })
      toast.success('邮箱已更新')
      setEmail('')
      setCode('')
      setPassword('')
      await qc.invalidateQueries({ queryKey: ['session'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : '改绑失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="new-email">新邮箱</Label>
          <Input id="new-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email-code">验证码</Label>
          <div className="flex gap-2">
            <Input id="email-code" value={code} onChange={(e) => setCode(e.target.value)} className="flex-1" required />
            <Button
              type="button"
              variant="outline"
              disabled={!email.trim()}
              onClick={() =>
                void api
                  .post('/auth/send-change-email-code', { email: email.trim() })
                  .then(() => toast.success('验证码已发到新邮箱'))
                  .catch((err) => toast.error(err.message))
              }
            >
              发送
            </Button>
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="email-pw">当前密码</Label>
        <PasswordInput id="email-pw" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>
      <Button type="submit" variant="outline" disabled={busy || !email || !code || !password}>
        {busy && <Loader2 className="animate-spin" />} 改绑邮箱
      </Button>
    </form>
  )
}

function DeleteAccount({ email, onDone }: { email: string; onDone: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [code, setCode] = React.useState('')
  const [phrase, setPhrase] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')

  async function submit() {
    if (phrase !== '注销') return
    setBusy(true)
    setError('')
    try {
      await api.post('/auth/delete', { email, code: code.trim() })
      toast.success('注销申请已提交，7 天内可撤销')
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button variant="outline" className="text-destructive" onClick={() => setOpen(true)}>
        <Trash2 /> 注销账号
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>永久注销账号？</DialogTitle>
            <DialogDescription>
              提交后进入 7 天宽限期，期间所有设备会退出登录；到期后账号与各应用中的业务数据会被删除。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="del-code">邮箱验证码</Label>
              <div className="flex gap-2">
                <Input id="del-code" value={code} onChange={(e) => setCode(e.target.value)} className="flex-1" />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    void api
                      .post('/auth/send-code', { email, purpose: 'delete' })
                      .then(() => toast.success('验证码已发送'))
                      .catch((err) => toast.error(err.message))
                  }
                >
                  发送
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="del-phrase">输入「注销」确认</Label>
              <Input id="del-phrase" value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder="注销" />
            </div>
            <Alert variant="warning">
              <ShieldAlert className="size-4" />
              <AlertDescription>此操作不可撤销（7 天宽限期内除外）。</AlertDescription>
            </Alert>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button variant="destructive" disabled={busy || phrase !== '注销' || !code} onClick={submit}>
              {busy && <Loader2 className="animate-spin" />} 永久注销账号
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
