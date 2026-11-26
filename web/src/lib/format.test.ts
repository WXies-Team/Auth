import { describe, expect, it } from 'vitest'
import { appLabel, initials, roleLabel } from './format'

describe('format', () => {
  it('maps known apps and falls back to the slug', () => {
    expect(appLabel('CalorieDiary')).toBe('热量日记')
    expect(appLabel('Unknown')).toBe('Unknown')
  })
  it('maps roles', () => {
    expect(roleLabel('super')).toBe('平台管理员')
    expect(roleLabel('admin')).toBe('项目管理员')
    expect(roleLabel('user')).toBe('普通用户')
  })
  it('takes the first grapheme as initials', () => {
    expect(initials('horatio')).toBe('H')
    expect(initials('')).toBe('?')
  })
})
