import { describe, it, expect } from 'vitest'
import { guessContentType } from '../src/commands/inscription.js'

describe('guessContentType', () => {
  it('should detect PNG', () => {
    expect(guessContentType('image.png')).toBe('image/png')
  })

  it('should detect JPEG variants', () => {
    expect(guessContentType('photo.jpg')).toBe('image/jpeg')
    expect(guessContentType('photo.jpeg')).toBe('image/jpeg')
  })

  it('should detect GIF', () => {
    expect(guessContentType('anim.gif')).toBe('image/gif')
  })

  it('should detect WebP', () => {
    expect(guessContentType('image.webp')).toBe('image/webp')
  })

  it('should detect SVG', () => {
    expect(guessContentType('vector.svg')).toBe('image/svg+xml')
  })

  it('should detect MP4', () => {
    expect(guessContentType('video.mp4')).toBe('video/mp4')
  })

  it('should detect MP3', () => {
    expect(guessContentType('audio.mp3')).toBe('audio/mpeg')
  })

  it('should detect text', () => {
    expect(guessContentType('readme.txt')).toBe('text/plain')
  })

  it('should detect HTML', () => {
    expect(guessContentType('page.html')).toBe('text/html')
  })

  it('should detect JSON', () => {
    expect(guessContentType('data.json')).toBe('application/json')
  })

  it('should fallback to octet-stream for unknown extensions', () => {
    expect(guessContentType('file.xyz')).toBe('application/octet-stream')
    expect(guessContentType('noext')).toBe('application/octet-stream')
  })

  it('should be case-insensitive', () => {
    expect(guessContentType('IMAGE.PNG')).toBe('image/png')
    expect(guessContentType('video.MP4')).toBe('video/mp4')
  })
})
