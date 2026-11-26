import * as React from 'react'

// 骨架屏的「延迟 + 最少展示」状态机（对齐业界 loading 指南的两难取舍）：
//
//   - 挂载时 loading=false（缓存命中/瞬时请求）→ 永不显示骨架，内容直接出来；
//   - loading=true → 立即显示（用户点击后有即时反馈，不是一片空白）；
//   - loading 在 minShow 内变 false → 骨架保持到 minShow 再消失，
//     否则 150ms 的加载会闪一下灰块又闪一下内容（正是“闪两个骨架”的来源）。
//
// 数据其实已经就绪时，用 showSkeleton=false 的渲染会晚 minShow 毫秒出现，
// 这是刻意换来的稳定感（Nielsen：0.1s 内无反馈才觉得卡，0.3s 的稳定占位不卡）。
export function useLoadingSkeleton(loading: boolean, minShow = 300): boolean {
  const [visible, setVisible] = React.useState(loading)
  const shownAt = React.useRef(0)

  React.useEffect(() => {
    if (loading) {
      if (!shownAt.current) shownAt.current = Date.now()
      setVisible(true)
      return
    }
    const elapsed = Date.now() - shownAt.current
    const remain = Math.max(0, minShow - elapsed)
    if (remain === 0) {
      shownAt.current = 0
      setVisible(false)
      return
    }
    const timer = window.setTimeout(() => {
      shownAt.current = 0
      setVisible(false)
    }, remain)
    return () => window.clearTimeout(timer)
  }, [loading, minShow])

  return visible
}
