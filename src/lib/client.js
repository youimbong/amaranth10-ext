// 서비스 워커와 확장 페이지(팝업·미리보기)가 같이 쓰는 chrome API 래퍼.
import { buildHeaders } from './amaranth.js';
import { sitePattern } from './site.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function getCookie(name, origin) {
  const cookie = await chrome.cookies.get({ url: origin, name });
  // 쿠키 값은 URL 인코딩돼 있다(oAuthToken). 페이지도 디코딩해서 쓰며, 메일 API는 인코딩된 값을 거부한다.
  return cookie?.value ? decodeURIComponent(cookie.value) : null;
}

// 인증 정보에 사이트를 묶어 두어 설정 변경 중 다른 사이트에 토큰을 보내지 않는다.
export async function getAuth(site) {
  if (!site) site = (await chrome.storage.local.get('settings')).settings;
  if (!site?.siteOrigin || !site.siteId) return null;
  if (!(await chrome.permissions.contains({ origins: [sitePattern(site.siteOrigin)] }))) return null;
  const token = await getCookie('oAuthToken', site.siteOrigin);
  const signKey = await getCookie('signKey', site.siteOrigin);
  return token && signKey ? { token, signKey, siteOrigin: site.siteOrigin, siteId: site.siteId } : null;
}

export async function assertCurrentSite(site) {
  const { settings } = await chrome.storage.local.get('settings');
  if (!site || settings?.siteId !== site.siteId || settings?.siteOrigin !== site.siteOrigin) {
    throw new Error('접속 사이트가 변경되었습니다. 알림 목록을 다시 열어 주세요.');
  }
}

export async function callApi(pathname, body, auth) {
  await assertCurrentSite(auth);
  const res = await fetch(new URL(pathname, auth.siteOrigin).href, {
    redirect: 'error',
    method: 'POST',
    headers: await buildHeaders({ ...auth, pathname }),
    body: JSON.stringify(body),
  });
  await assertCurrentSite(auth);
  if (res.status === 401) throw new HttpError(401, '인증 만료');
  if (!res.ok) throw new HttpError(res.status, `${pathname} HTTP ${res.status}`);
  const json = await res.json();
  await assertCurrentSite(auth);
  if (json.resultCode !== 0) throw new Error(`${pathname} resultCode ${json.resultCode}`);
  return json.resultData;
}

// 원문 주소는 해시만 달라 바로 바꾸면 문서를 다시 로드하지 않고 이전 원문이 남는다. 빈 문서를 거쳐 새로 로드한다.
async function reloadTab(tabId, url) {
  await chrome.tabs.update(tabId, { url: 'about:blank', active: true });
  // tabs 권한이 없어 빈 문서로 바뀌면 url이 보이지 않는다.
  // 바뀌기 전이거나 앞선 원문이 아직 로드 중일 때 이동하면 이전 문서에서 해시만 바뀔 수 있다.
  for (let tries = 0; ; tries++) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url && tab.status === 'complete') break;
    if (tries >= 100) throw new Error('이전 원문 화면을 벗어나지 못했습니다. 원문 창을 닫고 다시 열어 주세요.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await chrome.tabs.update(tabId, { url });
}

// 서비스 워커가 다시 시작되어도 같은 원문 창을 찾고, 동시 요청으로 창이 중복 생성되지 않게 한다.
let popupQueue = Promise.resolve();
export function openPopupWindow(url) {
  const task = popupQueue.then(async () => {
    const { sourceWindowId } = await chrome.storage.session.get('sourceWindowId');
    let win;
    if (sourceWindowId != null) {
      try {
        win = await chrome.windows.get(sourceWindowId, { populate: true });
      } catch {
        // 사용자가 닫은 창은 새로 만든다.
        await chrome.storage.session.remove('sourceWindowId');
      }
    }
    if (win?.type === 'popup' && win.tabs?.length) {
      const updated = await chrome.windows.update(win.id, {
        focused: true,
        ...(win.state === 'minimized' ? { state: 'normal' } : {}),
      });
      await reloadTab(win.tabs[0].id, url);
      return updated;
    }
    const created = await chrome.windows.create({ url, type: 'popup', width: 1000, height: 800 });
    await chrome.storage.session.set({ sourceWindowId: created.id });
    return created;
  });
  popupQueue = task.catch(() => {});
  return task;
}
