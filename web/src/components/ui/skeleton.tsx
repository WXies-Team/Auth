import { cn } from '@/lib/utils'

export function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('bg-muted animate-pulse rounded-md', className)} {...props} />
}

// 列表骨架：镜像真实行的结构（图标块 + 两/三行文本 + 可选操作按钮），
// 而不是一根等宽灰条。宽度按行交替，接近真实内容的参差感。
export function ListSkeleton({
  rows = 3,
  action = false,
  className,
}: {
  rows?: number
  action?: boolean
  className?: string
}) {
  return (
    <div aria-hidden="true" className={cn('divide-y', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 p-4">
          <Skeleton className="size-9 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1 space-y-2 py-0.5">
            <Skeleton className={i % 2 === 0 ? 'h-4 w-2/5' : 'h-4 w-1/3'} />
            <Skeleton className={i % 2 === 0 ? 'h-3 w-3/5' : 'h-3 w-2/3'} />
            <Skeleton className="h-3 w-1/4" />
          </div>
          {action && <Skeleton className="h-8 w-16 shrink-0" />}
        </div>
      ))}
    </div>
  )
}

// 表格骨架：表头一行短条 + 数据行（头像/勾选框位 + 多列单元格），
// 高度与真实表格行（h-12 左右）一致，避免加载完成时的纵向跳动。
export function TableSkeleton({ rows = 4, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div aria-hidden="true" className="space-y-3">
      <div className="flex items-center gap-4 px-1">
        <Skeleton className="size-4 shrink-0 rounded-sm" />
        {Array.from({ length: Math.max(columns - 1, 1) }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-1">
          <Skeleton className="size-4 shrink-0 rounded-sm" />
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className={r % 2 === 0 ? 'h-3.5 w-2/5' : 'h-3.5 w-1/3'} />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="hidden h-3 w-16 sm:block" />
          <Skeleton className="hidden h-3 w-20 md:block" />
          <Skeleton className="h-7 w-14" />
        </div>
      ))}
    </div>
  )
}
