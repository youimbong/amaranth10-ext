import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { sign, buildHeaders, buildCountBody, buildListBody, buildReadBody, buildAlertUrl } from '../src/lib/amaranth.js';

const fake = { token: 'tok-abc', signKey: 'key-xyz' };

test('sign은 Node HMAC-SHA256 Base64와 같다', async () => {
  const args = { ...fake, transactionId: '0123456789abcdef0123456789abcdef', timestamp: '1795042162', pathname: '/event/event02A12' };
  const expected = createHmac('sha256', args.signKey)
    .update(args.token + args.transactionId + args.timestamp + args.pathname).digest('base64');
  assert.equal(await sign(args), expected);
});

test('buildHeaders는 유닉스 초·32자리 hex·서명을 넣는다', async () => {
  const h = await buildHeaders({ ...fake, pathname: '/event/event02A01', now: 1795042162721 });
  assert.equal(h.Authorization, 'Bearer tok-abc');
  assert.equal(h.timestamp, '1795042162');
  assert.match(h['transaction-id'], /^[0-9a-f]{32}$/);
  assert.equal(h['Content-Type'], 'application/json');
  const expected = createHmac('sha256', fake.signKey)
    .update(fake.token + h['transaction-id'] + h.timestamp + '/event/event02A01').digest('base64');
  assert.equal(h['wehago-sign'], expected);
});

test('요청 본문', () => {
  const user = { groupSeq: 'g1', empSeq: 'e1' };
  assert.deepEqual(buildCountBody(user), { header: user, body: { eventType: '' } });
  assert.deepEqual(buildListBody(user, { timeStamp: 123 }), {
    header: user,
    body: { reqType: '2', reqSubType: 'N', pageSize: '20', newYn: 'N', mentionYn: 'N',
      langCode: 'kr', eventType: '', searchType: 'received', timeStamp: 123 },
  });
  assert.equal(buildListBody(user, { newYn: 'Y' }).body.newYn, 'Y');
});

test('메일 URL은 내 recvList 항목으로 {0}~{3}을 치환하고 mboxSeq를 mbodSeq로 쓴다', () => {
  const alert = {
    eventType: 'MAIL',
    url: '/#/popup?{0}&{1}&{2}&{3}&print=false&callComp=UDAP006&MicroModuleCode=mail&inOutCheck=1',
    data: JSON.stringify({ recvList: [
      { empSeq: 'other', muid: 1, email: 'o@example.com', mboxSeq: 1, boxName: 'INBOX', paramStr: 'muid|email|mboxSeq|boxName' },
      { empSeq: 'me', muid: 1001, email: 'x@example.com', mboxSeq: 10, boxName: 'INBOX', paramStr: 'muid|email|mboxSeq|boxName' },
    ] }),
  };
  assert.equal(buildAlertUrl(alert, 'me', 'https://erp.example.com'),
    'https://erp.example.com/#/popup?muid=1001&email=x%40example.com&mbodSeq=10&boxName=INBOX&print=false&callComp=UDAP006&MicroModuleCode=mail&inOutCheck=1');
});

test('단건 읽음 요청은 회사 정보와 해당 알림 ID만 보낸다', () => {
  assert.deepEqual(buildReadBody({
    groupSeq: 'g1', empSeq: 'e1', compSeq: 'c1', bizSeq: 'b1', deptSeq: 'd1',
    emailAdd: 'user', emailDomain: 'example.com', auth_a_token: 'must-not-send',
  }, 'A2'), {
    header: { groupSeq: 'g1', empSeq: 'e1', pid: '', tid: '' },
    body: {
      companyInfo: { compSeq: 'c1', bizSeq: 'b1', deptSeq: 'd1', emailAddr: 'user', emailDomain: 'example.com' },
      alertIds: ['A2'],
    },
  });
});

test('결재 URL은 그대로 쓴다', () => {
  const url = '/#/popup?callComp=UBAP002&MicroModuleCode=eap&docID=1&formId=2';
  assert.equal(buildAlertUrl({ eventType: 'EAPPROVAL', url, data: '{}' }, 'me', 'https://erp.example.com'), 'https://erp.example.com' + url);
});


test('원문 URL은 설정한 사이트를 사용하고 외부 사이트 주소는 거부한다', () => {
  assert.equal(buildAlertUrl({ url: '/#/popup?docID=1' }, 'me', 'https://other.example.com'), 'https://other.example.com/#/popup?docID=1');
  for (const url of ['https://foreign.example.com/x', '//foreign.example.com/x', 'javascript:alert(1)']) {
    assert.throws(() => buildAlertUrl({ url }, 'me', 'https://other.example.com'), /사이트 밖/);
  }
});
