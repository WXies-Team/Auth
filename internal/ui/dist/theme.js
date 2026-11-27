// 首屏前定主题，避免暗色闪白。CSP 只放行同源外部脚本，所以不能内联。
try {
  const saved = localStorage.getItem('auth-theme')
  const dark = saved === 'dark' || (saved !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
} catch {}
