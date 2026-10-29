import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveLanguage } from '../lib/language.js'

test('解析器：显式值原样保留', () => {
  assert.equal(resolveLanguage('zh', {}), 'zh')
  assert.equal(resolveLanguage('en', {}), 'en')
  assert.equal(resolveLanguage('both', {}), 'both')
})

test('解析器：环境变量优先（中英文都能识别 POSIX/BCP 47 写法）', () => {
  assert.equal(resolveLanguage('auto', { env: { DSH_LOCALE: 'zh_CN.UTF-8' } }), 'zh')
  assert.equal(resolveLanguage('auto', { env: { LC_ALL: 'zh-Hans-CN' } }), 'zh')
  assert.equal(resolveLanguage('auto', { env: { LANG: 'en_US.UTF-8' } }), 'en')
  // DSH_LOCALE 优先于其它环境变量
  assert.equal(resolveLanguage('auto', { env: { DSH_LOCALE: 'en', LANG: 'zh_CN.UTF-8' } }), 'en')
})

test('解析器：macOS 系统语言偏好 → Intl → 英文兜底', () => {
  assert.equal(resolveLanguage('auto', { env: {}, appleLanguages: ['zh-Hans-CN', 'en-US'] }), 'zh')
  assert.equal(resolveLanguage('auto', { env: {}, appleLanguages: ['en-US'] }), 'en')
  assert.equal(resolveLanguage('auto', { env: {}, intlLocale: 'zh-CN' }), 'zh')
  assert.equal(resolveLanguage('auto', { env: {}, intlLocale: 'fr-FR' }), 'en')
  assert.equal(resolveLanguage('auto', {}), 'en')
})
