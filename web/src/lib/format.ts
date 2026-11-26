export function relativeTime(ms?: number | null): string {
  if (!ms) return '未知'
  const diff = Date.now() - ms
  const abs = Math.abs(diff)
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour
  if (abs < min) return '刚刚'
  if (abs < hour) return `${Math.floor(abs / min)} 分钟${diff >= 0 ? '前' : '后'}`
  if (abs < day) return `${Math.floor(abs / hour)} 小时${diff >= 0 ? '前' : '后'}`
  if (abs < 30 * day) return `${Math.floor(abs / day)} 天${diff >= 0 ? '前' : '后'}`
  return new Date(ms).toLocaleDateString('zh-CN')
}

export function dateTime(ms?: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

export function dateOnly(ms?: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleDateString('zh-CN')
}

export function bytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`
}

export function appLabel(app?: string | null): string {
  const map: Record<string, string> = {
    CalorieDiary: '热量日记',
    ExpenseDiary: '开支日记',
    EPassportForMikey: '奇奇岛护照',
    PersonalShortener: '屑涵短链',
  }
  return app ? (map[app] ?? app) : '全部项目'
}

export function roleLabel(role?: string | null): string {
  return role === 'super' ? '平台管理员' : role === 'admin' ? '项目管理员' : '普通用户'
}

export function initials(name: string): string {
  const s = name.trim()
  if (!s) return '?'
  return [...s][0]!.toUpperCase()
}


export const AVATAR_PALETTE = ['#5B8DEF', '#7C6AF2', '#E2556B', '#FF8A3D', '#2BB673', '#14A8A0', '#E6B422', '#8B7355']

export function avatarDataUrl(image?: string | null): string | undefined {
  if (!image) return undefined
  const type = image.startsWith('/9j/')
    ? 'image/jpeg'
    : image.startsWith('iVBOR')
      ? 'image/png'
      : image.startsWith('R0lGOD')
        ? 'image/gif'
        : image.startsWith('UklGR')
          ? 'image/webp'
          : 'image/jpeg'
  return `data:${type};base64,${image}`
}
