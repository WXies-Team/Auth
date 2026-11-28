import * as React from 'react'

// 骨架屏的「延迟 + 最少展示」状态机（对齐业界加载指南）：
//
//   - 请求在 delay 内结束（缓存命中/同机接口）→ 骨架从不出现，内容直接出来；
//     几百毫秒的请求先闪一块灰再闪内容，是最刺眼的那种「闪一下」。
//   - 超过 delay 才显示骨架（用户已经有等待感，需要占位反馈）。
//   - 显示后至少保留 minShow，否则 150ms 的加载会闪一下灰块又闪一下内容。
//
// 默认 delay=0（加载中立即出骨架，列表/空态不会先闪一帧「暂无数据」）；
// 整页首次加载这种「空白 → 整张卡片」的场景才传 delay=200，避免短卡片闪一下。
export function useLoadingSkeleton(loading: boolean, minShow = 300, delay = 0): boolean {
  const [visible, setVisible] = React.useState(false)
  const shownAt = React.useRef(0)

  React.useEffect(() => {
    let timer = 0
    if (loading) {
      const show = () => {
        shownAt.current = Date.now()
        setVisible(true)
      }
      if (delay <= 0) show()
      else timer = window.setTimeout(show, delay)
      return () => window.clearTimeout(timer)
    }
    // 还没显示过（请求在 delay 内结束）：什么都不用做。
    if (!shownAt.current) {
      setVisible(false)
      return
    }
    const remain = Math.max(0, minShow - (Date.now() - shownAt.current))
    if (remain === 0) {
      shownAt.current = 0
      setVisible(false)
      return
    }
    timer = window.setTimeout(() => {
      shownAt.current = 0
      setVisible(false)
    }, remain)
    return () => window.clearTimeout(timer)
  }, [loading, minShow, delay])

  return visible
}
