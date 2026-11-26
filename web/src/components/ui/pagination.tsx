import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from './button'
import { cn } from '@/lib/utils'

type Props = {
  page: number
  pageSize: number
  total: number
  onPage: (page: number) => void
  className?: string
}

export function Pagination({ page, pageSize, total, onPage, className }: Props) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(page, pages)
  const nums: (number | '…')[] = []
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - current) <= 1) nums.push(i)
    else if (nums[nums.length - 1] !== '…') nums.push('…')
  }

  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      <p className="text-muted-foreground text-xs">
        共 {total} 条 · 第 {current} / {pages} 页
      </p>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon" disabled={current <= 1} onClick={() => onPage(current - 1)} aria-label="上一页">
          <ChevronLeft />
        </Button>
        {nums.map((n, i) =>
          n === '…' ? (
            <span key={`e${i}`} className="text-muted-foreground px-1 text-xs">
              …
            </span>
          ) : (
            <Button
              key={n}
              variant={n === current ? 'default' : 'ghost'}
              size="sm"
              className="min-w-8 px-2"
              onClick={() => onPage(n)}
              aria-current={n === current ? 'page' : undefined}
            >
              {n}
            </Button>
          ),
        )}
        <Button
          variant="outline"
          size="icon"
          disabled={current >= pages}
          onClick={() => onPage(current + 1)}
          aria-label="下一页"
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  )
}
