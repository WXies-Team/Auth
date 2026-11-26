import * as React from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

export function CopyButton({
  value,
  label = '复制',
  className,
  size = 'icon',
}: {
  value: string
  label?: string
  className?: string
  size?: 'icon' | 'sm' | 'default'
}) {
  const [done, setDone] = React.useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setDone(true)
      toast.success('已复制')
      window.setTimeout(() => setDone(false), 1500)
    } catch {
      toast.error('复制失败，请手动选择文本')
    }
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      className={className}
      onClick={copy}
      aria-label={label}
      title={label}
    >
      {done ? <Check /> : <Copy />}
    </Button>
  )
}
