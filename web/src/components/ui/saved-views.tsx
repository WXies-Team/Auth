import * as React from 'react'
import { BookmarkPlus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

// 管理台筛选器的「保存视图」（W12）：命名后存 localStorage（每页一个 key），
// 刷新/换页后仍能一键恢复。纯前端便利功能——不存服务端，不参与权限判定。
//
// state 由调用页给（当前筛选值），onApply 由调用页恢复。视图里不存 page：
// 恢复筛选后回到第 1 页，避免「保存时在第 5 页、恢复时该页已不存在」。
export function SavedViews<T extends Record<string, string>>({
  storageKey,
  state,
  onApply,
}: {
  storageKey: string
  state: T
  onApply: (value: T) => void
}) {
  const [views, setViews] = React.useState<Record<string, T>>(() => {
    try {
      return JSON.parse(window.localStorage.getItem(storageKey) || '{}') as Record<string, T>
    } catch {
      return {}
    }
  })
  const [name, setName] = React.useState('')
  const [picked, setPicked] = React.useState('')

  const persist = (next: Record<string, T>) => {
    setViews(next)
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      // 隐私模式/配额满：功能降级为本次会话内可用
    }
  }

  const save = () => {
    const key = name.trim()
    if (!key) {
      toast.error('请先给视图起个名字')
      return
    }
    persist({ ...views, [key]: state })
    setPicked(key)
    setName('')
    toast.success(`已保存视图「${key}」`)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="已保存的视图"
        className="w-44"
        value={picked}
        onChange={(e) => {
          const key = e.target.value
          setPicked(key)
          if (key && views[key]) onApply(views[key])
        }}
      >
        <option value="">已保存视图</option>
        {Object.keys(views).map((key) => (
          <option key={key} value={key}>
            {key}
          </option>
        ))}
      </Select>
      <Input
        aria-label="视图名称"
        className="w-40"
        placeholder="视图名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            save()
          }
        }}
      />
      <Button type="button" size="sm" variant="outline" onClick={save}>
        <BookmarkPlus /> 保存当前筛选
      </Button>
      {picked && views[picked] && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-destructive"
          onClick={() => {
            const next = { ...views }
            delete next[picked]
            persist(next)
            setPicked('')
          }}
        >
          <Trash2 /> 删除视图
        </Button>
      )}
    </div>
  )
}
