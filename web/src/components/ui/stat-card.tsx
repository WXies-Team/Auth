import type { LucideIcon } from 'lucide-react'
import { Card } from './card'
import { cn } from '@/lib/utils'

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  className,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  icon?: LucideIcon
  className?: string
}) {
  // 统计卡自带内边距（16 / 桌面 24），不复用 CardContent 的「无上内边距」默认值。
  return (
    <Card className={cn(className)}>
      <div className="flex items-start justify-between gap-3 px-4 py-4 sm:px-6">
        <div className="space-y-1">
          <p className="text-muted-foreground text-xs">{label}</p>
          <p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
          {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
        </div>
        {Icon && (
          <div className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-md">
            <Icon className="size-4" />
          </div>
        )}
      </div>
    </Card>
  )
}
