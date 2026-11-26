// 알림 요약·원문 조회 요청·미리보기 srcdoc. 브라우저와 Node 양쪽에서 쓰는 순수 로직.

export const MAIL_DETAIL_PATH = '/mail/mail002A01';
export const EAP_DETAIL_PATH = '/eap/eap111A04';

const SNIPPET_MAX = 300;

export function parseAlertData(alert) {
  if (typeof alert.data !== 'string') return alert.data ?? {};
  try {
    return JSON.parse(alert.data) ?? {};
  } catch {
    return {};
  }
}

// 결재 알림 url(`/#/popup?...&docID=…&formId=…`)의 쿼리에서 문서 키를 꺼낸다.
export function parseEapParams(url) {
  const i = (url ?? '').indexOf('?');
  if (i < 0) return null;
  const q = new URLSearchParams(url.slice(i + 1));
  const docID = q.get('docID');
  const formId = q.get('formId');
  return docID && formId ? { docID, formId } : null;
}

function snippet(text) {
  const s = String(text ?? '').trim();
  return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX)}…` : s;
}

// 목록 데이터만으로 만든 요약. [이름, 값] 목록(빈 값 제외).
export function summarizeAlert(alert) {
  const data = parseAlertData(alert);
  const msg = alert.message ?? {};
  let rows;
  if (alert.eventType === 'MAIL') {
    rows = [
      ['보낸사람', String(msg.alertContent ?? '').replace(/^보낸사람\s*:\s*/, '')],
      ['내용', snippet(data.content)],
    ];
  } else if (alert.eventType === 'EAPPROVAL') {
    rows = [
      ['양식', data.form_nm],
      ['문서번호', data.doc_no],
      ['제목', data.title],
      ['기안자', data.userName],
      ['부서', data.deptName],
    ];
  } else {
    rows = [['제목', msg.alertTitle], ['내용', msg.alertContent]];
  }
  return rows.filter(([, v]) => v != null && String(v).trim() !== '').map(([k, v]) => [k, String(v)]);
}

// 미리보기 페이지 쿼리. 미리보기를 지원하지 않는 알림이면 null.
export function previewQuery(alert) {
  if (alert.eventType === 'MAIL' && alert.mailUid) {
    return new URLSearchParams({ type: 'MAIL', uid: String(alert.mailUid) }).toString();
  }
  if (alert.eventType === 'EAPPROVAL') {
    const p = parseEapParams(alert.url);
    if (p) return new URLSearchParams({ type: 'EAPPROVAL', ...p }).toString();
  }
  return null;
}

export function buildMailDetailBody(uid, now = Date.now()) {
  return { uid: String(uid), currentTime: now };
}

// setReadYn "N": 화면은 "Y"로 호출한다. 읽음 처리를 피하려는 값(효과 미확인).
export function buildEapDetailBody({ docID, formId }) {
  return {
    doc_id: docID, form_id: formId, bindType: 'V', p_doc_id: 0, doc_auth: 0, spDocId: '',
    setReadYn: 'N', commentReqYn: 'N', pageCode: 'UBAP002', docToken: '',
  };
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// sandbox iframe(스크립트 금지)의 srcdoc. CSP로 외부 요청을 막고, 외부 이미지는 remoteImages일 때만 https:를 허용한다.
// 링크는 base target=_blank로 새 탭에서 열린다(iframe에 allow-popups 필요).
export function buildSrcdoc({ html, plain }, { remoteImages = false } = {}) {
  const csp = `default-src 'none'; img-src data:${remoteImages ? ' https:' : ''}; style-src 'unsafe-inline'; font-src data:; form-action 'none'`;
  const body = html || `<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(plain)}</pre>`;
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${csp}">`
    + '<meta name="referrer" content="no-referrer"><base target="_blank">'
    + `</head><body>${body}</body></html>`;
}
