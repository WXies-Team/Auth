import * as React from 'react'
import { Input } from './input'
import { cn } from '@/lib/utils'

export function OtpInput({
  value,
  onChange,
  length = 6,
  className,
  ...props
}: {
  value: string
  onChange: (value: string) => void
  length?: number
  className?: string
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'>) {
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, length))}
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={length}
      placeholder={'0'.repeat(length)}
      className={cn('h-11 text-center font-mono text-lg tracking-[0.5em]', className)}
      {...props}
    />
  )
}
