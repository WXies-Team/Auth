import type { LucideIcon } from 'lucide-react'
import { Card, CardContent } from './card'
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
  return (
    <Card className={cn('py-4', className)}>
      <CardContent className="flex items-start justify-between gap-3 px-4">
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
      </CardContent>
    </Card>
  )
}
