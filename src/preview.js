import {
  MAIL_DETAIL_PATH, EAP_DETAIL_PATH, buildMailDetailBody, buildEapDetailBody, buildSrcdoc,
} from './lib/detail.js';
import { getAuth, callApi } from './lib/client.js';

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// decodeMime의 from/to는 HTML 엔티티가 든 문자열이다(예: `이름 &lt;주소&gt;`). 텍스트로 풀어 쓴다.
function toText(v) {
  if (v == null) return '';
  if (typeof v !== 'object') return new DOMParser().parseFromString(String(v), 'text/html').body.textContent;
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join(', ');
  const name = v.name ?? v.personal;
  const addr = v.address ?? v.email;
  return name || addr ? [name, addr && `<${addr}>`].filter(Boolean).join(' ') : JSON.stringify(v);
}

// 20261118115713 → 2026-11-18 11:57
function formatYmdHms(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(s ?? '');
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : (s ?? '');
}

function fields(rows) {
  const dl = el('dl');
  for (const [k, v] of rows) {
    if (v != null && v !== '') dl.append(el('dt', { textContent: k }), el('dd', { textContent: String(v) }));
  }
  return dl;
}

let content = null;
function renderBody() {
  $('bodyFrame').srcdoc = buildSrcdoc(content, { remoteImages: $('remoteImages').checked });
  $('bodyFrame').hidden = false;
  $('toolbar').hidden = false;
}
$('remoteImages').addEventListener('change', renderBody);

async function showMail(uid, auth) {
  const d = await callApi(MAIL_DETAIL_PATH, buildMailDetailBody(uid), auth);
  const m = d.decodeMime ?? {};
  // mime.fileList 항목의 이름 필드는 확인하지 못했다.
  const files = (d.mime?.fileList ?? []).map((f) => f.fileName ?? f.name ?? f.filename ?? '').filter(Boolean);
  document.title = m.subject || document.title;
  $('info').replaceChildren(
    el('h1', { textContent: m.subject || '(제목 없음)' }),
    fields([['보낸사람', toText(m.from)], ['받는사람', toText(m.to)], ['날짜', toText(m.date)], ['첨부', files.join(', ')]]),
    el('div', { className: 'note', textContent: '미리보기를 열면 메일이 읽음 처리됩니다.' }),
  );
  content = { html: d.mime?.body?.html, plain: d.mime?.body?.plain };
}

async function showEap(docID, formId, auth) {
  const d = await callApi(EAP_DETAIL_PATH, buildEapDetailBody({ docID, formId }), auth);
  document.title = d.docTitle || document.title;
  const line = el('table', {},
    el('tr', {}, ...['결재자', '구분', '시각'].map((t) => el('th', { textContent: t }))),
    ...(d.line ?? []).map((l) => el('tr', { className: 'line' },
      ...[l.user_nm, l.act_nm, l.action_time].map((t) => el('td', { textContent: t ?? '' })))));
  $('info').replaceChildren(
    el('h1', { textContent: d.docTitle || '(제목 없음)' }),
    fields([
      ['문서번호', d.docNo], ['상태', d.docStsName], ['양식', d.formName],
      ['기안자', d.empName], ['부서', d.deptName], ['상신일', formatYmdHms(d.repDt)],
      ['첨부', (d.fileList ?? []).map((f) => f.dispFileNm).filter(Boolean).join(', ')],
    ]),
    line,
  );
  content = { html: d.docContents };
}

async function main() {
  const q = new URLSearchParams(location.search);
  const auth = await getAuth();
  if (!auth) {
    $('info').textContent = '아마란스10에 로그인되어 있지 않습니다. 로그인한 뒤 다시 열어 주세요.';
    return;
  }
  if (q.get('siteId') !== auth.siteId) throw new Error('접속 사이트가 변경되었거나 미리보기 주소가 만료되었습니다.');
  if (q.get('type') === 'MAIL') await showMail(q.get('uid'), auth);
  else if (q.get('type') === 'EAPPROVAL') await showEap(q.get('docID'), q.get('formId'), auth);
  else throw new Error('지원하지 않는 알림입니다.');
  renderBody();
}

main().catch((e) => {
  $('info').textContent = e.status === 401
    ? '아마란스10에 로그인되어 있지 않습니다. 로그인한 뒤 다시 열어 주세요.'
    : `불러오지 못했습니다: ${e.message}`;
});
