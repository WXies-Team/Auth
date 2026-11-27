import { useEffect, useRef, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const KEY = 'auth-theme'

function apply(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

type ViewTransitionDocument = Document & {
  activeViewTransition?: unknown
  startViewTransition?: (options: { update: () => void; types: string[] }) => unknown
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => (localStorage.getItem(KEY) as Theme) || 'system')
  const mounted = useRef(false)

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
    const commit = () => {
      apply(next)
      setThemeState(next)
    }
    const doc = document as ViewTransitionDocument
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    // 首屏不播放；已有 React/Router 的过渡在跑时让路，避免两个 ViewTransition 互相打断。
    if (mounted.current && doc.startViewTransition && !reduce && !doc.activeViewTransition) {
      doc.startViewTransition({ update: commit, types: ['theme'] })
    } else {
      commit()
    }
  }

  useEffect(() => {
    mounted.current = true
  }, [])

  return { theme, setTheme }
}
