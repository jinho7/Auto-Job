import './setup-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { configForSession } from '../src/browser/session';
import { parseSettings } from '../src/config';
import { paths } from '../src/paths';

test('기본 브라우저를 바꿔도 기존 작업의 포트와 프로필로 재연결한다', () => {
  const s=parseSettings(readFileSync(paths.settingsExample,'utf8'));s.browser.driver='aside';
  const cfg=configForSession(s,{targetId:'owned',cdpPort:s.browser.chrome.cdp_port,profileDir:s.browser.chrome.profile_dir});
  assert.equal(cfg,s.browser.chrome);
});

test('다른 프로필이나 구별할 수 없는 포트로 기존 작업을 옮기지 않는다', () => {
  const s=parseSettings(readFileSync(paths.settingsExample,'utf8'));
  assert.throws(()=>configForSession(s,{targetId:'owned',cdpPort:s.browser.chrome.cdp_port,profileDir:'/different-profile'}),/연결 설정/);
  s.browser.aside.cdp_port=s.browser.chrome.cdp_port;
  assert.throws(()=>configForSession(s,{targetId:'legacy',cdpPort:s.browser.chrome.cdp_port}),/연결 설정/);
  assert.equal(configForSession(s,{targetId:'owned',cdpPort:s.browser.chrome.cdp_port,profileDir:s.browser.chrome.profile_dir}),s.browser.chrome);
});
