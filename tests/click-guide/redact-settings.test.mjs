// ClickGuide 가리기 설정: 기본값과 보정, 녹화 스크립트에 보내는 값
// 가리는 방식은 검정 칠하기가 기본이다(흐리게 한 숫자는 원래 값을 되살리는 공격에 약함).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const settings = await import(new URL('../../click-guide/src/common/settings.js', import.meta.url).href);

test('기본값: 검정 칠하기, 화면 개인정보 자동 가리기 켬', () => {
  assert.equal(settings.DEFAULT_SETTINGS.redactStyle, 'box');
  assert.equal(settings.DEFAULT_SETTINGS.maskScreenPII, true);
  assert.equal(settings.DEFAULT_SETTINGS.maskPasswords, true);
});

test('가리는 방식은 box·blur 만 받고, 그 밖의 값은 기본값(box)으로', () => {
  const base = { ...settings.DEFAULT_SETTINGS };
  assert.equal(settings.normalizeSettings({ ...base, redactStyle: 'blur' }).redactStyle, 'blur');
  assert.equal(settings.normalizeSettings({ ...base, redactStyle: 'box' }).redactStyle, 'box');
  for (const v of ['pixelate', '', null, undefined, 1]) {
    assert.equal(settings.normalizeSettings({ ...base, redactStyle: v }).redactStyle, 'box', String(v));
  }
});

test('녹화 스크립트(웹페이지 쪽)로 보내는 설정에 화면 개인정보 가리기 값이 들어감', () => {
  const sw = fs.readFileSync(new URL('../../click-guide/src/background/service-worker.js', import.meta.url), 'utf8');
  const body = (sw.match(/function contentSettings\(cfg\) \{([\s\S]*?)\n\}/) || [])[1] || '';
  assert.match(body, /maskScreenPII: !!cfg\.maskScreenPII/);
  assert.doesNotMatch(body, /apiKey|ai:/, 'AI 설정·API 키는 웹페이지 쪽으로 보내지 않음');
});
