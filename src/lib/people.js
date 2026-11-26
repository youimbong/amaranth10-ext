// 임직원 검색어 해석, 요청 본문, 응답(소속별 행)을 사람 단위로 묶는 순수 로직.

export const PEOPLE_PATH = '/gw/APIHandler/gw102A02';
export const ORG_OPTIONS_PATH = '/gw/APIHandler/gw102A01';

// 서버는 검색어 하나만 부분 일치로 찾는다. 첫 단어를 보내고 나머지 단어는 결과에서 거른다.
// 짧은 검색어는 명부 대부분과 일치하므로 보내지 않고 안내한다({ hint }).
export function parseQuery(input) {
  const text = input.trim();
  if (!text) return { empty: true };
  if (/^[\d\s-]+$/.test(text)) {
    const digits = text.replace(/\D/g, '');
    return digits.length < 4 ? { hint: '번호는 네 자리 이상 입력하세요.' } : { searchText: digits, filters: [] };
  }
  // 한글 조합 중인 낱자(예: 김ㅁ)는 일치하는 사람이 없다.
  if (/[ㄱ-ㅎㅏ-ㅣ]/.test(text)) return { pending: true };
  const [first, ...filters] = text.split(/\s+/);
  // 서버는 이메일 전체 주소로 찾지 못하므로 아이디 부분을 보내고 전체 주소로 거른다.
  const searchText = first.replace(/@.*$/, '');
  if ((searchText.match(/[\p{L}\p{N}]/gu) || []).length < 2) return { hint: '두 글자 이상 입력하세요.' };
  if (/^[\d-]+$/.test(searchText) && searchText.replace(/\D/g, '').length < 4) return { hint: '번호는 네 자리 이상 입력하세요.' };
  if (first.includes('@')) filters.push(first);
  return { searchText, filters: filters.map((f) => f.toLowerCase()) };
}

export function buildPeopleBody(searchText) {
  return { popupType: 'main', selectedType: 'search', searchDiv: 'all', searchText };
}

export function buildOrgOptionsBody() {
  return {
    popupType: 'main', selectedType: 'tree', isAllCompShow: false, compFilter: '',
    isTreeChecked: '', isTreeAllOpen: false, isPartYn: false, parentSeq: '0',
  };
}

// 아마란스10 조직도의 직급·직책 표시 설정(isDutypositionOption).
const TITLE_FIELDS = {
  0: ['positionName'],
  1: ['dutyName'],
  2: ['positionName', 'dutyName'],
  3: ['dutyName', 'positionName'],
};

export function formatPhone(value) {
  const text = (value || '').trim();
  if (!/^0\d{8,11}$/.test(text)) return text;
  const area = text.startsWith('02') ? 2 : text.startsWith('050') && text.length === 12 ? 4 : 3;
  return `${text.slice(0, area)}-${text.slice(area, -4)}-${text.slice(-4)}`;
}

const uniq = (values) => [...new Set(values.filter(Boolean))];

// options: 조직도 표시 설정. 없으면 휴대폰을 숨긴다.
// 조직도 화면처럼 회사가 막았거나 본인이 비공개한 휴대폰, 메일을 쓰지 않는 사람의 이메일은 뺀다.
export function toPeople(rows, options) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.empSeq) continue;
    if (!groups.has(row.empSeq)) groups.set(row.empSeq, []);
    groups.get(row.empSeq).push(row);
  }
  const titleFields = TITLE_FIELDS[options?.isDutypositionOption] || [];
  return [...groups.values()].map((list) => {
    const affiliations = list.map((r) => ({
      company: r.compName || '', dept: r.deptName || '', path: r.pathName || '',
      title: uniq(titleFields.map((f) => r[f])).join(' · '),
    }));
    const hideMobile = options?.isMobileTelNumOption !== '1'
      || list.some((r) => (r.empPrivateOptionValue || '').includes('mobileTelNum'));
    return {
      empSeq: list[0].empSeq,
      name: list[0].empName || '',
      affiliations: affiliations.filter((a, i) =>
        affiliations.findIndex((b) => b.company === a.company && b.dept === a.dept && b.title === a.title) === i),
      mobiles: hideMobile ? [] : uniq(list.map((r) => formatPhone(r.mobileTelNum))),
      phones: uniq(list.map((r) => formatPhone(r.telNum))),
      extensions: uniq(list.map((r) => r.extNum)),
      emails: uniq(list.map((r) => (r.mailUseYn === 'Y' ? r.emailAddr : ''))),
      work: uniq(list.map((r) => r.mainWork)).join(', '),
    };
  });
}

// 나머지 단어를 모두 포함하는 사람만 남기고, 이름이 일치하는 사람을 앞에 둔다.
export function rankPeople(people, { searchText, filters }) {
  const rank = ({ name }) => (name === searchText ? 0 : name.startsWith(searchText) ? 1 : name.includes(searchText) ? 2 : 3);
  return people
    .filter((p) => {
      const text = [p.name, p.work, ...p.mobiles, ...p.phones, ...p.extensions, ...p.emails, ...p.affiliations.flatMap((a) => [a.company, a.dept, a.path, a.title])].join('\n').toLowerCase();
      return filters.every((f) => text.includes(f));
    })
    .sort((a, b) => rank(a) - rank(b));
}
