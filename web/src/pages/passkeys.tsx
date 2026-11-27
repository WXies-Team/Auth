import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Fingerprint, Loader2, Pencil, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { usePasskeys } from '@/lib/queries'
import { registerPasskey } from '@/lib/webauthn'
import type { Passkey } from '@/lib/types'
import { dateTime, relativeTime } from '@/lib/format'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ListSkeleton } from '@/components/ui/skeleton'
import { useLoadingSkeleton } from '@/lib/use-loading'
import { EmptyState } from '@/components/ui/empty-state'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

export default function PasskeysPage() {
  const qc = useQueryClient()
  const { data, isLoading } = usePasskeys()
  const showSkeleton = useLoadingSkeleton(isLoading)
  const [adding, setAdding] = React.useState(false)
  const [renaming, setRenaming] = React.useState<Passkey | null>(null)
  const [name, setName] = React.useState('')
  const [deleting, setDeleting] = React.useState<Passkey | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')

  const rows = data ?? []

  async function add() {
    setError('')
    setAdding(true)
    try {
      await registerPasskey()
      toast.success('Passkey 已添加')
      await qc.invalidateQueries({ queryKey: ['passkeys'] })
      await qc.invalidateQueries({ queryKey: ['session'] })
    } catch (err) {
      const n = (err as DOMException)?.name
      if (n !== 'NotAllowedError' && n !== 'AbortError') {
        setError(err instanceof Error ? err.message : '添加失败，请重试')
      }
    } finally {
      setAdding(false)
    }
  }

  async function rename() {
    if (!renaming || !name.trim()) return
    setBusy(true)
    try {
      await api.patch(`/api/passkeys/${renaming.id}`, { name: name.trim() })
      toast.success('已改名')
      setRenaming(null)
      await qc.invalidateQueries({ queryKey: ['passkeys'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '改名失败')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!deleting) return
    setBusy(true)
    try {
      await api.del(`/api/passkeys/${deleting.id}`)
      toast.success('Passkey 已删除')
      setDeleting(null)
      await qc.invalidateQueries({ queryKey: ['passkeys'] })
      await qc.invalidateQueries({ queryKey: ['session'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Passkey"
        description="用指纹、面容或安全密钥登录，不需要输入密码。"
        actions={
          <Button onClick={add} disabled={adding || !window.PublicKeyCredential}>
            {adding ? <Loader2 className="animate-spin" /> : <Fingerprint />} 添加 Passkey
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="p-0">
          {showSkeleton ? (
            <ListSkeleton rows={2} action />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Fingerprint}
              title="还没有 Passkey"
              description="添加后可以用本机指纹、面容或外接安全密钥登录，比密码更快也更安全。"
              action={
                <Button onClick={add} disabled={adding}>
                  {adding ? <Loader2 className="animate-spin" /> : <Fingerprint />} 添加第一把
                </Button>
              }
            />
          ) : (
            <ul className="divide-y">
              {rows.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-md">
                    <Fingerprint className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium [overflow-wrap:anywhere]">
                      {row.name}
                      {row.current && <Badge variant="secondary">本机</Badge>}
                      {row.backupState ? (
                        <Badge variant="success">已同步</Badge>
                      ) : row.backupEligible ? (
                        <Badge variant="outline">可同步</Badge>
                      ) : null}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      添加于 {dateTime(row.createdAt)} · 最近使用 {relativeTime(row.lastUsedAt)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="改名"
                    onClick={() => {
                      setRenaming(row)
                      setName(row.name)
                    }}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="删除"
                    className="text-destructive"
                    onClick={() => setDeleting(row)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!renaming} onOpenChange={(v) => !v && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>给 Passkey 改名</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="pk-name">名称</Label>
            <Input id="pk-name" autoFocus value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
            <p className="text-muted-foreground text-xs">例如「MacBook 指纹」「iPhone」。</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button onClick={rename} disabled={busy || !name.trim()}>
              {busy && <Loader2 className="animate-spin" />} 保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={`删除「${deleting?.name ?? ''}」？`}
        description="删除后这把 Passkey 立即不能用于登录。如果你只剩这一种登录方式，将无法再登录。"
        confirmLabel="删除"
        destructive
        busy={busy}
        onConfirm={remove}
      />
    </div>
  )
}
