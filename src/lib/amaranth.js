// 아마란스10 API 서명·요청 본문·알림 URL. 브라우저와 Node 양쪽에서 쓰는 순수 로직.

export const COUNT_PATH = '/event/event02A12';
export const LIST_PATH = '/event/event02A01';
export const READ_PATH = '/event/event02A03';

const encoder = new TextEncoder();

function bytesToBase64(buffer) {
  let binary = '';
  for (const b of new Uint8Array(buffer)) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function randomTransactionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// wehago-sign = Base64(HMAC-SHA256(token + transactionId + timestamp + pathname, key=signKey))
export async function sign({ token, signKey, transactionId, timestamp, pathname }) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(signKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(token + transactionId + timestamp + pathname));
  return bytesToBase64(mac);
}

export async function buildHeaders({ token, signKey, pathname, now = Date.now(), transactionId = randomTransactionId() }) {
  const timestamp = String(Math.floor(now / 1000));
  return {
    'Authorization': `Bearer ${token}`,
    'timestamp': timestamp,
    'transaction-id': transactionId,
    'wehago-sign': await sign({ token, signKey, transactionId, timestamp, pathname }),
    'Content-Type': 'application/json',
  };
}

export function buildCountBody({ groupSeq, empSeq }) {
  return { header: { groupSeq, empSeq }, body: { eventType: '' } };
}

export function buildReadBody(user, alertId) {
  const { groupSeq, empSeq, compSeq, bizSeq, deptSeq, emailAdd, emailDomain } = user;
  return {
    header: { groupSeq, empSeq, pid: '', tid: '' },
    body: {
      companyInfo: { compSeq, bizSeq, deptSeq, emailAddr: emailAdd, emailDomain },
      alertIds: [alertId],
    },
  };
}

// newYn: 'N' 전체, 'Y' 안 읽음만. timeStamp: 첫 페이지는 현재 시각, 다음 페이지는 직전 응답의 timeStamp.
export function buildListBody({ groupSeq, empSeq }, { newYn = 'N', timeStamp = Date.now() } = {}) {
  return {
    header: { groupSeq, empSeq },
    body: {
      reqType: '2', reqSubType: 'N', pageSize: '20', newYn, mentionYn: 'N',
      langCode: 'kr', eventType: '', searchType: 'received', timeStamp,
    },
  };
}

// 메일 paramStr 이름 중 mboxSeq는 화면이 mbodSeq로 연다.
const MAIL_PARAM_NAMES = { mboxSeq: 'mbodSeq' };

export function buildAlertUrl(alert, empSeq, origin) {
  let path = alert.url || '/';
  if (alert.eventType === 'MAIL' && path.includes('{0}')) {
    const data = typeof alert.data === 'string' ? JSON.parse(alert.data) : alert.data;
    const recv = data?.recvList?.find((r) => String(r.empSeq) === String(empSeq));
    if (recv) {
      recv.paramStr.split('|').forEach((name, i) => {
        const param = `${MAIL_PARAM_NAMES[name] ?? name}=${encodeURIComponent(recv[name] ?? '')}`;
        path = path.replace(`{${i}}`, param);
      });
    }
  }
  const url = new URL(path, origin);
  if (url.origin !== origin || url.username || url.password) {
    throw new Error('설정한 사이트 밖의 원문 주소는 열 수 없습니다.');
  }
  return url.href;
}
