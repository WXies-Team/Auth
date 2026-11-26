import * as React from 'react'
import { Input } from './input'
import { cn } from '@/lib/utils'

// 验证码输入（2026-11 重做）。口径参考 OWASP/AFixt/Twilio 的 OTP 最佳实践：
//
//   - **始终只有一个真实 <input>**：一次粘贴、一次性验证码自动填充（
//     autocomplete="one-time-code"）、读屏只看到一个控件、原生光标/选择行为全部保留。
//   - 视觉上分格（hybrid）：真实 input 透明铺满，下面用 aria-hidden 的格子渲染
//     每位数字与「下一个待输入位」的闪烁光标——解决旧版「6 个 0 占位符把光标挤到
//     中间」的问题：空值时第一格就是激活位，用户一眼知道从哪开始。
//   - 占位符不再用 0（0 是合法数字，会被误认为已输入）；空格子只画一个弱化的点。
//   - 非数字/长码（恢复码 32 位）不做分格，退回单个居中输入框，避免几十个格子。
//   - 聚焦态用容器描边 + 激活格高亮；光标动画遵守 prefers-reduced-motion。
const SEGMENT_MAX_LENGTH = 8

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
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [focused, setFocused] = React.useState(false)
  // caret 是本输入框的字符偏移（0..length），用来高亮「当前要输入的格子」。
  const [caret, setCaret] = React.useState(value.length)

  const segmented = numeric && length <= SEGMENT_MAX_LENGTH

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = (numeric ? e.target.value.replace(/\D/g, '') : e.target.value).slice(0, length)
    onChange(next)
    const pos = e.target.selectionStart ?? next.length
    setCaret(Math.min(pos, next.length))
  }

  if (!segmented) {
    // 恢复码这类长码：单个输入框，居中、不设 0 占位符（避免几十个 0 挤成一排）。
    return (
      <Input
        ref={inputRef}
        value={value}
        onChange={handleChange}
        inputMode={numeric ? 'numeric' : 'text'}
        autoComplete="one-time-code"
        maxLength={length}
        className={cn('h-11 text-center font-mono text-base', className)}
        {...props}
      />
    )
  }

  const active = Math.min(caret, length - 1)
  const showCaret = focused && value.length < length

  return (
    <div
      className={cn(
        'border-input bg-background focus-within:border-ring focus-within:ring-ring/50 relative flex h-11 w-full min-w-0 items-stretch gap-1 rounded-md border p-1 shadow-xs transition-[color,box-shadow] focus-within:ring-[3px]',
        className,
      )}
      onClick={() => inputRef.current?.focus()}
    >
      <input
        {...props}
        ref={inputRef}
        value={value}
        onChange={handleChange}
        onFocus={(e) => {
          setFocused(true)
          setCaret(e.currentTarget.selectionStart ?? value.length)
          props.onFocus?.(e)
        }}
        onBlur={(e) => {
          setFocused(false)
          props.onBlur?.(e)
        }}
        onSelect={(e) => {
          setCaret(e.currentTarget.selectionStart ?? 0)
          props.onSelect?.(e)
        }}
        onClick={(e) => {
          setCaret(e.currentTarget.selectionStart ?? 0)
          props.onClick?.(e)
        }}
        inputMode={numeric ? 'numeric' : 'text'}
        autoComplete="one-time-code"
        maxLength={length}
        // 真实输入框透明铺满：点击/聚焦/读屏都在它身上，视觉由下面的格子承担。
        className="absolute inset-0 z-10 h-full w-full cursor-text border-0 bg-transparent p-0 text-transparent caret-transparent opacity-0 outline-none focus-visible:ring-0"
      />
      <div aria-hidden="true" className="flex w-full items-stretch gap-1">
        {Array.from({ length }).map((_, i) => {
          const char = value[i] ?? ''
          const isActive = focused && i === active && value.length < length
          return (
            <div
              key={i}
              className={cn(
                'relative flex flex-1 items-center justify-center rounded-sm font-mono text-lg transition-colors',
                i < value.length ? 'text-foreground' : 'text-muted-foreground/40',
                isActive && 'bg-muted',
              )}
            >
              {char || <span className="bg-muted-foreground/30 size-1 rounded-full" />}
              {isActive && showCaret && (
                <span className="bg-primary absolute left-0.5 h-5 w-0.5 rounded-full motion-safe:animate-pulse" />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
