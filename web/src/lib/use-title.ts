import { useEffect } from 'react'

// 页面标题是路由切换时读屏与浏览器历史的第一信号；统一在 PageHeader 收口。
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const prev = document.title
    document.title = `${title} · Auth`
    return () => {
      document.title = prev
    }
  }, [title])
}
