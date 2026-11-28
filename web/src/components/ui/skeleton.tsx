import { cn } from '@/lib/utils'

export function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  // aria-hidden：骨架是纯视觉占位；读屏靠页面自己的加载态/实时区域，不读一堆空 div。
  return <div aria-hidden="true" className={cn('bg-muted skeleton rounded-md', className)} {...props} />
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
        <div key={i} className="flex items-start gap-3 px-4 py-4 sm:px-6">
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

// 表格骨架：表头一行短条 + 数据行（头像/勾选框位 + 多列单元格）。
// dense=true 用于单行表格（审计这类），行高 ~44；默认两行单元格（用户/会话）
// 行高 ~60——加载完成时纵向零位移，这就是“内容从中间冒一行”的根治点。
export function TableSkeleton({
  rows = 4,
  columns = 5,
  dense = false,
}: {
  rows?: number
  columns?: number
  dense?: boolean
}) {
  return (
    <div aria-hidden="true" className="divide-y">
      {/* 与真实表格逐像素对齐：表头 h-9、数据行 h-12、同 px-3，
          换成真表时纵向零位移（骨架→内容的“冒一行”就是这里高度不齐造成的）。 */}
      <div className="flex h-10 items-center gap-4 px-4">
        <Skeleton className="size-4 shrink-0 rounded-sm" />
        {Array.from({ length: Math.max(columns - 1, 1) }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        // 与真实 TableCell 的 py-3 + 两行内容对齐（约 58~60px），骨架→真表零位移。
        <div key={r} className="flex items-center gap-4 px-4 py-3">
          <Skeleton className="size-4 shrink-0 rounded-sm" />
          <Skeleton className={dense ? 'hidden' : 'size-8 shrink-0 rounded-full'} />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className={r % 2 === 0 ? 'h-4 w-2/5' : 'h-4 w-1/3'} />
            {!dense && <Skeleton className="h-3 w-1/4" />}
          </div>
          <Skeleton className="hidden h-3 w-16 sm:block" />
          <Skeleton className="hidden h-3 w-20 md:block" />
          <Skeleton className="h-7 w-14" />
        </div>
      ))}
    </div>
  )
}
