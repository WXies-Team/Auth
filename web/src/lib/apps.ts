export const APPS = [
  { key: 'CalorieDiary', label: '热量日记' },
  { key: 'ExpenseDiary', label: '开支日记' },
  { key: 'EPassportForMikey', label: '奇奇岛护照' },
  { key: 'Shortener', label: '屑涵短链' },
] as const

export const APP_OPTIONS = [{ key: '', label: '全部项目' }, ...APPS]
