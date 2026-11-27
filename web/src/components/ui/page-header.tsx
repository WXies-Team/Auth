import { cn } from '@/lib/utils'
import { useDocumentTitle } from '@/lib/use-title'

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  className?: string
}) {
  useDocumentTitle(title)
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0 space-y-1">
        {/* 标题可能是邮箱这类无空格长串：允许任意断行，避免把页面撑出横向滚动 */}
        <h1 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">{title}</h1>
        {description && (
          <p className="text-muted-foreground text-sm [overflow-wrap:anywhere]">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
