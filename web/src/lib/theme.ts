import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const KEY = 'auth-theme'
const listeners = new Set<() => void>()
let current: Theme = readStored()

function readStored(): Theme {
  const stored = localStorage.getItem(KEY)
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
}

function prefersDark(): boolean {
  return matchMedia('(prefers-color-scheme: dark)').matches
}

function apply(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && prefersDark())
  document.documentElement.classList.toggle('dark', dark)
}

function emit() {
  for (const listener of listeners) listener()
}

// 模块加载即校正一次：内联脚本负责首屏防闪，这里兜住 localStorage 与媒体查询的偏差。
apply(current)

// 系统主题变化只在「跟随系统」时改 DOM，也要通知订阅者重渲染（Sonner 等）。
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (current !== 'system') return
  apply('system')
  emit()
})

export function setTheme(next: Theme) {
  localStorage.setItem(KEY, next)
  current = next
  apply(next)
  emit()
}

export function useTheme() {
  // 主题是全局单例：多个组件（Toaster、菜单）读同一份状态，不会各存一份。
  const theme = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
    () => 'system' as Theme,
  )

  return { theme, setTheme }
}
