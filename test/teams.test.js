import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTeamsPayload } from '../src/lib/teams.js';

test('Teams 메시지는 Adaptive Card 1.4 첨부 하나를 담는다', () => {
  const p = buildTeamsPayload({ title: '[메일] 제목', content: '보낸사람 : 홍길동', url: 'https://erp.example.com/#/x' });
  assert.equal(p.type, 'message');
  assert.equal(p.attachments.length, 1);
  const { contentType, content } = p.attachments[0];
  assert.equal(contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(content.type, 'AdaptiveCard');
  assert.equal(content.version, '1.4');
  assert.deepEqual(content.body.map((b) => b.text), ['[메일] 제목', '보낸사람 : 홍길동']);
  assert.deepEqual(content.actions, [{ type: 'Action.OpenUrl', title: '아마란스10에서 열기', url: 'https://erp.example.com/#/x' }]);
});
