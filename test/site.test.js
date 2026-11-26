import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSiteOrigin, sitePattern } from '../src/lib/site.js';

test('접속 주소는 origin만 저장하고 로그인 경로·쿼리·해시를 제거한다', () => {
  assert.equal(normalizeSiteOrigin(' https://ERP.EXAMPLE.COM/login?next=/foo#/login '), 'https://erp.example.com');
  assert.equal(normalizeSiteOrigin('https://erp.example.com:8443/'), 'https://erp.example.com:8443');
  assert.equal(sitePattern('https://erp.example.com:8443'), 'https://erp.example.com/*');
});

test('빈 주소·HTTPS 외 주소·인증 정보가 포함된 주소를 거부한다', () => {
  for (const value of ['', 'example.com', 'http://erp.example.com', 'file:///a', 'https://user:password@example.com']) {
    assert.throws(() => normalizeSiteOrigin(value));
  }
});
