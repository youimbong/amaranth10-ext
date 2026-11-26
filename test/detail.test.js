import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEapParams, summarizeAlert, previewQuery, buildMailDetailBody, buildEapDetailBody, buildSrcdoc,
} from '../src/lib/detail.js';

const EAP_URL = '/#/popup?callComp=UBAP002&MicroModuleCode=eap&docID=2001&formId=3001';

test('결재 url 쿼리에서 docID·formId를 꺼낸다', () => {
  assert.deepEqual(parseEapParams(EAP_URL), { docID: '2001', formId: '3001' });
  assert.equal(parseEapParams('/#/popup?callComp=UBAP002&docID=1'), null);
  assert.equal(parseEapParams('/#/'), null);
  assert.equal(parseEapParams(undefined), null);
});

test('메일 요약: 보낸사람 접두어를 떼고 data.content를 잘라 쓴다', () => {
  const rows = summarizeAlert({
    eventType: 'MAIL',
    message: { alertTitle: '[메일] 제목', alertContent: '보낸사람 : 홍길동<h@example.com>' },
    data: JSON.stringify({ content: 'x'.repeat(400) }),
  });
  assert.equal(rows[0][0], '보낸사람');
  assert.equal(rows[0][1], '홍길동<h@example.com>');
  assert.equal(rows[1][0], '내용');
  assert.equal(rows[1][1], `${'x'.repeat(300)}…`);
});

test('결재 요약: data의 양식·문서번호·제목·기안자·부서, 빈 값은 뺀다', () => {
  const rows = summarizeAlert({
    eventType: 'EAPPROVAL',
    message: { alertTitle: '[결재진행] …' },
    data: JSON.stringify({ form_nm: '품의서', doc_no: 'D-1', title: '구매', userName: '김기안', deptName: '' }),
  });
  assert.deepEqual(rows, [['양식', '품의서'], ['문서번호', 'D-1'], ['제목', '구매'], ['기안자', '김기안']]);
});

test('그 밖의 알림은 제목·내용만, data가 깨져도 동작한다', () => {
  const rows = summarizeAlert({ eventType: 'BOARD', message: { alertTitle: '[게시판] 공지', alertContent: '내용' }, data: '{bad' });
  assert.deepEqual(rows, [['제목', '[게시판] 공지'], ['내용', '내용']]);
});

test('미리보기 쿼리는 메일·결재만 만든다', () => {
  assert.equal(previewQuery({ eventType: 'MAIL', mailUid: 1001 }), 'type=MAIL&uid=1001');
  assert.equal(previewQuery({ eventType: 'EAPPROVAL', url: EAP_URL }), 'type=EAPPROVAL&docID=2001&formId=3001');
  assert.equal(previewQuery({ eventType: 'EAPPROVAL', url: '/#/' }), null);
  assert.equal(previewQuery({ eventType: 'BOARD', url: EAP_URL }), null);
});

test('원문 조회 요청 본문', () => {
  assert.deepEqual(buildMailDetailBody(1001, 123), { uid: '1001', currentTime: 123 });
  assert.deepEqual(buildEapDetailBody({ docID: '2001', formId: '3001' }), {
    doc_id: '2001', form_id: '3001', bindType: 'V', p_doc_id: 0, doc_auth: 0, spDocId: '',
    setReadYn: 'N', commentReqYn: 'N', pageCode: 'UBAP002', docToken: '',
  });
});

const cspOf = (doc) => doc.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)[1];

test('srcdoc: CSP는 기본으로 외부 이미지를 막고, 옵션일 때만 https: 이미지를 허용한다', () => {
  const blocked = cspOf(buildSrcdoc({ html: '<p>x</p>' }));
  assert.match(blocked, /default-src 'none'/);
  assert.match(blocked, /img-src data:;/);
  assert.doesNotMatch(blocked, /script-src/);
  assert.match(cspOf(buildSrcdoc({ html: '<p>x</p>' }, { remoteImages: true })), /img-src data: https:;/);
});

test('srcdoc: CSP·base가 본문보다 먼저 오고, 링크는 새 탭', () => {
  const doc = buildSrcdoc({ html: '<a href="https://example.com">a</a>' });
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('<body>'));
  assert.match(doc, /<base target="_blank">/);
  assert.match(doc, /<body><a href="https:\/\/example.com">a<\/a><\/body>/);
});

test('srcdoc: html이 없으면 plain을 이스케이프해 pre로 넣는다', () => {
  const doc = buildSrcdoc({ html: '', plain: '<script>alert(1)</script> & "q"' });
  assert.match(doc, /<pre[^>]*>&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;q&quot;<\/pre>/);
  assert.doesNotMatch(doc, /<script>/);
});
