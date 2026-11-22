import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionCookieSecure } from '../src/auth/routes.js';

test('网页会话 Cookie 的 Secure 属性跟随公开地址协议', () => {
  assert.equal(sessionCookieSecure('http://192.168.5.196:4318'), false);
  assert.equal(sessionCookieSecure('https://babyplan.example.test'), true);
});
