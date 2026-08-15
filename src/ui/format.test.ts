import { describe, expect, it } from 'vitest'
import { cleanedName, formatBytes } from './format.ts'

describe('formatBytes', () => {
  it('counts bytes below a kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('switches to kB at a kilobyte, with a decimal while it is small', () => {
    expect(formatBytes(1024)).toBe('1.0 kB')
    expect(formatBytes(1024 * 50)).toBe('50.0 kB')
  })

  it('drops the decimal past a hundred kilobytes', () => {
    expect(formatBytes(1024 * 512)).toBe('512 kB')
  })

  it('reaches MB, which is the whole reason this replaced the kB-only version', () => {
    // 20 MB printed as "19532 kB" is the number the reader was trying not to
    // have to work out.
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(Math.round(19.4 * 1024 * 1024))).toBe('19.4 MB')
  })
})

describe('cleanedName', () => {
  it('inserts the suffix before the extension', () => {
    expect(cleanedName('photo.jpg')).toBe('photo-unmarked.jpg')
  })

  it('only splits on the last dot', () => {
    expect(cleanedName('holiday.2024.jpg')).toBe('holiday.2024-unmarked.jpg')
  })

  it('appends when there is no extension', () => {
    expect(cleanedName('screenshot')).toBe('screenshot-unmarked')
  })

  it('does not read a leading dot as an extension', () => {
    expect(cleanedName('.profile')).toBe('.profile-unmarked')
  })
})
