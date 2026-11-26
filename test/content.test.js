import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const settings = { siteOrigin: 'https://erp.example.com', siteId: 'site-1' };

const source = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');

test('기존 사용자도 회사·부서 정보를 보완하고 회사 변경을 반영한다', async () => {
  const uc = {
    groupSeq: 'g1', empSeq: 'e1', compSeq: 1, bizSeq: 2, deptSeq: 3,
    emailAdd: 'user', emailDomain: 'example.com', auth_a_token: 'must-not-store',
  };
  let saved = { groupSeq: 'g1', empSeq: 'e1' };
  const writes = [];
  const messages = [];
  let hashchange;
  runInNewContext(source, {
    sessionStorage: { getItem: () => JSON.stringify({ ucUserInfo: JSON.stringify(uc) }) },
    location: { origin: settings.siteOrigin },
    chrome: {
      storage: { local: { get: async () => ({ settings }) } },
      runtime: { sendMessage: async (message) => {
        messages.push(message);
        const user = JSON.parse(JSON.stringify(message.user));
        if (JSON.stringify(saved) !== JSON.stringify(user)) { saved = user; writes.push(saved); }
        return { ok: true };
      } },
    },
    window: { addEventListener: (name, callback) => { hashchange = callback; } },
    setInterval: () => 1,
    clearInterval: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saved, {
    groupSeq: 'g1', empSeq: 'e1', compSeq: '1', bizSeq: '2', deptSeq: '3',
    emailAdd: 'user', emailDomain: 'example.com', ...settings,
  });
  await hashchange();
  assert.equal(writes.length, 1);
  uc.compSeq = 4;
  await hashchange();
  assert.equal(saved.compSeq, '4');
  assert.equal(writes.length, 2);
  assert.ok(messages.every((m) => m.type === 'syncUser' && m.user.siteId === settings.siteId));
});


test('이전 사이트에서 실행 중인 스크립트는 사용자 정보를 전달하지 않는다', async () => {
  let sent = false;
  runInNewContext(source, {
    location: { origin: 'https://old.example.com' },
    sessionStorage: { getItem: () => JSON.stringify({ ucUserInfo: { groupSeq: 'g1', empSeq: 'e1' } }) },
    chrome: {
      storage: { local: { get: async () => ({ settings }) } },
      runtime: { sendMessage: async () => { sent = true; } },
    },
    window: { addEventListener: () => {} }, setInterval: () => 1, clearInterval: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent, false);
});
