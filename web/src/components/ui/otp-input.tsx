import * as React from 'react'
import { Input } from './input'
import { cn } from '@/lib/utils'

export function OtpInput({
  value,
  onChange,
  length = 6,
  numeric = true,
  className,
  ...props
}: {
  value: string
  onChange: (value: string) => void
  length?: number
  numeric?: boolean
  className?: string
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'>) {
  return (
    <Input
      value={value}
      onChange={(e) =>
        onChange((numeric ? e.target.value.replace(/\D/g, '') : e.target.value).slice(0, length))
      }
      inputMode={numeric ? 'numeric' : 'text'}
      autoComplete="one-time-code"
      maxLength={length}
      placeholder={'0'.repeat(length)}
      className={cn('h-11 text-center font-mono text-lg tracking-[0.5em]', className)}
      {...props}
    />
  )
}
