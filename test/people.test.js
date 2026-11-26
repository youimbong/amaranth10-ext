import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, buildPeopleBody, formatPhone, toPeople, rankPeople } from '../src/lib/people.js';

const OPTIONS = { isMobileTelNumOption: '1', isDutypositionOption: '3' };
const row = (extra = {}) => ({
  empSeq: '1', empName: '홍길동', compName: '가상회사', deptName: '개발팀', pathName: '가상회사|본부|개발팀',
  positionName: '과장', dutyName: '팀장', mobileTelNum: '01012345678', telNum: '0212345678', extNum: '1234',
  emailAddr: 'hong@example.com', mailUseYn: 'Y', empPrivateOptionValue: '', mainWork: '', loginId: 'hong', ...extra,
});

test('명부 대부분과 일치할 짧은 검색어는 보내지 않는다', () => {
  for (const q of ['김', '010', '01-0', '010-', '%%', '__', '%김%', 'a', '@example.com', '010@x']) {
    assert.equal(parseQuery(q).searchText, undefined, q);
    assert.ok(parseQuery(q).hint, q);
  }
  assert.deepEqual(parseQuery('  '), { empty: true });
});

test('한글 조합 중에는 검색을 미룬다', () => {
  assert.deepEqual(parseQuery('김ㅁ'), { pending: true });
  assert.deepEqual(parseQuery('홍길동 ㄱ'), { pending: true });
});

test('번호는 하이픈·공백을 빼고, 여러 단어는 첫 단어만 보내고 나머지로 거른다', () => {
  assert.deepEqual(parseQuery('010-1234 5678'), { searchText: '01012345678', filters: [] });
  assert.deepEqual(parseQuery(' 1234 '), { searchText: '1234', filters: [] });
  assert.deepEqual(parseQuery('홍길동  개발팀 ERP'), { searchText: '홍길동', filters: ['개발팀', 'erp'] });
  assert.deepEqual(parseQuery('Hong@Example.com'), { searchText: 'Hong', filters: ['hong@example.com'] });
  assert.deepEqual(buildPeopleBody('홍길동'), { popupType: 'main', selectedType: 'search', searchDiv: 'all', searchText: '홍길동' });
});

test('겸직 행을 한 사람으로 묶고 연락처 중복을 없앤다', () => {
  const people = toPeople([row(), row({ compName: '계열사', deptName: '기획팀', dutyName: '', telNum: '', extNum: '', mailUseYn: 'N' }), row({ empSeq: '2', empName: '홍길동' })], OPTIONS);
  assert.equal(people.length, 2);
  assert.deepEqual(people[0].affiliations.map((a) => [a.company, a.dept, a.title]),
    [['가상회사', '개발팀', '팀장 · 과장'], ['계열사', '기획팀', '과장']]);
  assert.deepEqual(people[0].mobiles, ['010-1234-5678']);
  assert.deepEqual(people[0].phones, ['02-1234-5678']);
  assert.deepEqual(people[0].emails, ['hong@example.com']);
  assert.equal('loginId' in people[0], false);
});

test('조직도에서 숨기는 휴대폰·이메일은 보여 주지 않는다', () => {
  const mobiles = (r, o) => toPeople([].concat(r), o)[0].mobiles;
  assert.deepEqual(mobiles(row(), { ...OPTIONS, isMobileTelNumOption: '0' }), []);
  assert.deepEqual(mobiles(row(), null), []);
  assert.deepEqual(mobiles(row({ empPrivateOptionValue: 'bday|mobileTelNum' }), OPTIONS), []);
  assert.deepEqual(mobiles([row(), row({ empPrivateOptionValue: 'mobileTelNum' })], OPTIONS), []);
  assert.deepEqual(mobiles(row({ empPrivateOptionValue: null }), OPTIONS), ['010-1234-5678']);
  assert.deepEqual(toPeople([row({ mailUseYn: 'N' })], OPTIONS)[0].emails, []);
});

test('직급·직책은 조직도 표시 설정 순서를 따른다', () => {
  const title = (v) => toPeople([row()], { ...OPTIONS, isDutypositionOption: v })[0].affiliations[0].title;
  assert.deepEqual(['0', '1', '2', '3', '9'].map(title), ['과장', '팀장', '과장 · 팀장', '팀장 · 과장', '']);
});

test('전화번호 표시 형식', () => {
  assert.equal(formatPhone('01012345678'), '010-1234-5678');
  assert.equal(formatPhone('0311234567'), '031-123-4567');
  assert.equal(formatPhone('021234567'), '02-123-4567');
  assert.equal(formatPhone('050712345678'), '0507-1234-5678');
  assert.equal(formatPhone('010-1234-5678'), '010-1234-5678');
  assert.equal(formatPhone('+82 10 1234'), '+82 10 1234');
  assert.equal(formatPhone(null), '');
});

test('나머지 단어로 거르고 이름이 일치하는 사람을 앞에 둔다', () => {
  const people = toPeople([
    row({ empSeq: '1', empName: '김철수', deptName: '홍길동팀' }),
    row({ empSeq: '2', empName: '홍길동수' }),
    row({ empSeq: '3', empName: '홍길동' }),
    row({ empSeq: '4', empName: '홍길동', deptName: '기획팀', pathName: '가상회사|기획팀' }),
  ], OPTIONS);
  assert.deepEqual(rankPeople(people, parseQuery('홍길동')).map((p) => p.empSeq), ['3', '4', '2', '1']);
  assert.deepEqual(rankPeople(people, parseQuery('홍길동 기획')).map((p) => p.empSeq), ['4']);
  assert.deepEqual(rankPeople(people, parseQuery('hong@example.co.kr')).map((p) => p.empSeq), []);
});
