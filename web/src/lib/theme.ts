import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const KEY = 'auth-theme'

function apply(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => (localStorage.getItem(KEY) as Theme) || 'system')

  useEffect(() => {
    apply(theme)
    if (theme !== 'system') return
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => apply('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  const setTheme = (next: Theme) => {
    localStorage.setItem(KEY, next)
    setThemeState(next)
  }

  return { theme, setTheme }
}
