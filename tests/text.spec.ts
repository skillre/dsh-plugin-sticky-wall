import { describe, expect, it } from 'vitest'
import { NAMESPACE, dictFor, en, textOf, zh } from '../src/client/text.js'

/**
 * Dictionary tests.
 *
 * The dict is a plain object, so the compiler cannot notice a key that exists in
 * one locale and not the other. That drift is invisible until a user switches
 * the GUI language and a label turns into its own key, so the key-set equality
 * here is the guard — it is the only assertion protecting every other string in
 * the UI.
 */

describe('dictionary parity', () => {
  it('ships the same key set in both locales', () => {
    // Sorted, compared as whole arrays: a failure then names the exact keys that
    // drifted instead of only reporting that the sets differ.
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('translates every key in both locales', () => {
    // An empty value is worse than a missing key: a missing key falls back to
    // the key, which is at least a visible signal, while '' silently deletes the
    // label (and an aria-label, and a title) from the UI.
    const blank = [...Object.entries(zh), ...Object.entries(en)]
      .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
      .map(([key]) => key)
    expect(blank).toEqual([])
  })

  it('registers under the namespace the locale service is bound with', () => {
    expect(NAMESPACE).toBe('skillreStickyWall')
  })
})

describe('textOf', () => {
  it('returns the translation for a known key', () => {
    expect(textOf(en, 'title')).toBe(en.title)
    expect(textOf(zh, 'title')).toBe(zh.title)
  })

  it('falls back to the key itself so a missing string is visible, not blank', () => {
    expect(textOf(en, 'noSuchKey')).toBe('noSuchKey')
    expect(textOf(zh, 'noSuchKey')).toBe('noSuchKey')
  })
})

describe('dictFor', () => {
  it('picks Chinese for any zh locale id', () => {
    expect(dictFor('zh-CN')).toBe(zh)
    expect(dictFor('zh')).toBe(zh)
    expect(dictFor('zh-Hant-TW')).toBe(zh)
  })

  it('falls back to English for every other locale', () => {
    expect(dictFor('en')).toBe(en)
    expect(dictFor('en-US')).toBe(en)
    expect(dictFor('fr-FR')).toBe(en)
    expect(dictFor('')).toBe(en)
  })
})
