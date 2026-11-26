// 서비스 워커에서 알림 조회·읽음 처리에 사용할 사용자 정보를 옮겨 둔다.
function readUser() {
  try {
    let uc = JSON.parse(sessionStorage.getItem('userInfo')).ucUserInfo;
    if (typeof uc === 'string') uc = JSON.parse(uc);
    if (!uc?.groupSeq || !uc?.empSeq) return null;
    return Object.fromEntries(
      ['groupSeq', 'empSeq', 'compSeq', 'bizSeq', 'deptSeq', 'emailAdd', 'emailDomain']
        .map((key) => [key, String(uc[key] ?? '')]));
  } catch {
    return null;
  }
}

async function syncUser() {
  const user = readUser();
  if (!user) return false;
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings?.siteId || settings.siteOrigin !== location.origin) return false;
  const result = await chrome.runtime.sendMessage({
    type: 'syncUser', user: { ...user, siteOrigin: settings.siteOrigin, siteId: settings.siteId },
  });
  return result?.ok === true;
}

// 새 탭에서는 SPA가 document_idle 뒤 세션 확인 API 응답을 받고서야 userInfo를 쓴다.
// 찾을 때까지 2초 간격으로 최대 1분 다시 읽는다.
let tries = 0;
const retry = setInterval(async () => {
  if ((await syncUser()) || ++tries >= 30) clearInterval(retry);
}, 2000);
syncUser();
// SPA라 로그인 뒤 새로고침 없이 해시만 바뀐다.
window.addEventListener('hashchange', syncUser);
