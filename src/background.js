import {
  COUNT_PATH, LIST_PATH, READ_PATH, buildCountBody, buildListBody, buildReadBody, buildAlertUrl,
} from './lib/amaranth.js';
import { selectNewAlerts } from './lib/alerts.js';
import { buildTeamsPayload } from './lib/teams.js';
import { getAuth, callApi, openPopupWindow } from './lib/client.js';
import { normalizeSiteOrigin, sitePattern } from './lib/site.js';

const ALARM = 'poll';
const DEFAULT_INTERVAL_MIN = 1;
const ICON = chrome.runtime.getURL('icons/icon128.png');

// 설정 전환과 서버 작업을 순서대로 끝내 이전 사이트의 결과가 새 상태를 덮지 않게 한다.
let taskQueue = Promise.resolve();
function enqueue(task) {
  const next = taskQueue.then(task);
  taskQueue = next.catch(() => {});
  return next;
}

async function syncContentScript(settings) {
  const id = 'amaranth-user';
  const [registered] = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  const allowed = settings?.siteOrigin && await chrome.permissions.contains({ origins: [sitePattern(settings.siteOrigin)] });
  if (!allowed) {
    if (registered) await chrome.scripting.unregisterContentScripts({ ids: [id] });
    return;
  }
  const script = { id, matches: [sitePattern(settings.siteOrigin)], js: ['src/content.js'], runAt: 'document_idle', persistAcrossSessions: true };
  if (registered) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}

async function saveSettings(input) {
  const siteOrigin = normalizeSiteOrigin(input.siteOrigin);
  if (!(await chrome.permissions.contains({ origins: [sitePattern(siteOrigin)] }))) {
    throw new Error('접속 사이트 접근 권한이 필요합니다. 다시 저장해 주세요.');
  }
  const { settings: previous } = await chrome.storage.local.get('settings');
  const changed = previous?.siteOrigin !== siteOrigin || !previous.siteId;
  const settings = {
    siteOrigin, siteId: changed ? crypto.randomUUID() : previous.siteId,
    webhookUrl: input.webhookUrl, intervalMin: input.intervalMin,
  };
  await syncContentScript(settings);
  if (changed) {
    for (const id of Object.keys(await chrome.notifications.getAll())) {
      if (id.startsWith('alert:')) {
        await chrome.notifications.clear(id);
        await chrome.storage.session.remove(id);
      }
    }
    await chrome.storage.session.remove('sourceWindowId');
    await chrome.storage.local.set({ settings, user: null, seen: null, lastReadError: null, status: { state: 'login' } });
    await setBadge('', '#888888', '설정한 아마란스10에 로그인해 주세요');
    const oldOrigin = previous?.siteOrigin;
    const webhookHost = settings.webhookUrl ? new URL(settings.webhookUrl).hostname : '';
    if (oldOrigin && sitePattern(oldOrigin) !== sitePattern(siteOrigin) && new URL(oldOrigin).hostname !== webhookHost) {
      await chrome.permissions.remove({ origins: [sitePattern(oldOrigin)] });
    }
  } else {
    await chrome.storage.local.set({ settings });
  }
  return { ok: true };
}

async function setStatus(patch) {
  const { status } = await chrome.storage.local.get('status');
  await chrome.storage.local.set({ status: { ...status, ...patch } });
}

async function setBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  if (color) await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
}

async function showLoginNeeded() {
  // 다음 로그인 뒤 첫 폴링은 다시 시드한다(그 사이 쌓인 알림을 한꺼번에 알리지 않음).
  await chrome.storage.local.remove('seen');
  await setBadge('!', '#888888', '아마란스10 로그인이 필요합니다');
  await setStatus({ state: 'login', lastPoll: Date.now() });
}

async function notify(alert, url, settings, user) {
  const id = `alert:${alert.alertId}`;
  await chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: ICON,
    title: alert.message?.alertTitle || '아마란스10 알림',
    message: alert.message?.alertContent || '',
  });
  await chrome.storage.session.set({ [id]: { url, alert, user, siteOrigin: settings.siteOrigin, siteId: settings.siteId } });
}

async function sendTeams(webhookUrl, alert, url) {
  const payload = buildTeamsPayload({
    title: alert.message?.alertTitle || '아마란스10 알림',
    content: alert.message?.alertContent || '',
    url,
  });
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Teams 전송 실패 HTTP ${res.status}`);
}

async function pollOnce() {
  const { user, seen, settings } = await chrome.storage.local.get(['user', 'seen', 'settings']);
  if (!settings?.siteOrigin || !settings.siteId) {
    await setBadge('', '#888888', '아마란스10 접속 주소를 설정해 주세요');
    await setStatus({ state: 'setup', lastError: null });
    return;
  }
  if (!(await chrome.permissions.contains({ origins: [sitePattern(settings.siteOrigin)] }))) {
    await setBadge('!', '#888888', '접속 사이트 접근 권한이 필요합니다');
    await setStatus({ state: 'permission' });
    return;
  }
  const auth = await getAuth(settings);
  if (!auth) return showLoginNeeded();
  if (!user || user.siteId !== settings.siteId || user.siteOrigin !== settings.siteOrigin) {
    await setBadge('?', '#888888', '설정한 아마란스10에 로그인하고 페이지를 새로고침해 주세요');
    await setStatus({ state: 'nouser', lastPoll: Date.now() });
    return;
  }

  let count, list;
  try {
    count = await callApi(COUNT_PATH, buildCountBody(user), auth);
    list = await callApi(LIST_PATH, buildListBody(user), auth);
  } catch (e) {
    if (e.status === 401) return showLoginNeeded();
    await setStatus({ state: 'error', lastPoll: Date.now(), lastError: e.message });
    return;
  }

  const alertCnt = Number(count.alertCnt) || 0;
  await setBadge(alertCnt ? String(alertCnt) : '', '#d93025', `아마란스10 안 읽은 알림 ${alertCnt}건`);

  const result = selectNewAlerts(list.alertList || [], seen?.siteId === settings.siteId ? seen : null, user.empSeq);
  await chrome.storage.local.set({ seen: { ...result.seen, siteId: settings.siteId } });

  const errors = [];
  for (const alert of result.newAlerts) {
    const url = buildAlertUrl(alert, user.empSeq, settings.siteOrigin);
    await notify(alert, url, settings, user);
    if (settings?.webhookUrl) {
      try {
        await sendTeams(settings.webhookUrl, alert, url);
      } catch (e) {
        errors.push(e.message);
      }
    }
  }
  await setStatus({ state: 'ok', lastPoll: Date.now(), lastError: errors.join('; ') || null });
}

// 쿠키·알람·저장소 이벤트가 겹쳐도 폴링은 한 번에 하나만 돌려 중복 알림을 막는다.
// 도는 중에 들어온 요청은 끝난 뒤 한 번 더 돌려 최신 상태를 반영한다.
let running = null;
let again = false;
function poll() {
  if (running) {
    again = true;
    return running;
  }
  running = enqueue(async () => {
    do {
      again = false;
      await pollOnce().catch((e) => setStatus({ state: 'error', lastPoll: Date.now(), lastError: e.message }));
    } while (again);
  }).finally(() => { running = null; });
  return running;
}

async function scheduleAlarm() {
  const { settings } = await chrome.storage.local.get('settings');
  const periodInMinutes = Math.max(1, Number(settings?.intervalMin) || DEFAULT_INTERVAL_MIN);
  await chrome.alarms.create(ALARM, { delayInMinutes: 0.5, periodInMinutes });
}

function initialize(details) {
  return enqueue(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await syncContentScript(settings);
    await scheduleAlarm();
    await pollOnce();
    if (details && (!settings?.siteOrigin || !settings.siteId)) {
      await chrome.runtime.openOptionsPage();
    }
  });
}
chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) poll();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) { scheduleAlarm(); poll(); }
  if (changes.user) poll();
});

// 부모 도메인 쿠키도 설정한 사이트에 적용되는 경우에만 반영한다.
chrome.cookies.onChanged.addListener(({ cookie, removed, cause }) => {
  if (removed && cause === 'overwrite') return;
  if (cookie.name !== 'oAuthToken' && cookie.name !== 'signKey') return;
  chrome.storage.local.get('settings').then(({ settings }) => {
    if (!settings?.siteOrigin) return;
    const host = new URL(settings.siteOrigin).hostname;
    const domain = cookie.domain.replace(/^\./, '');
    if (host === domain || (!cookie.hostOnly && host.endsWith(`.${domain}`))) poll();
  });
});

chrome.permissions.onRemoved.addListener(() => {
  enqueue(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await syncContentScript(settings);
    if (settings?.siteOrigin && !(await chrome.permissions.contains({ origins: [sitePattern(settings.siteOrigin)] }))) {
      await chrome.storage.local.remove(['user', 'seen']);
    }
    await pollOnce();
  });
});

const openingAlerts = new Map();
function openAlert(alert, requestedUser) {
  const key = JSON.stringify([requestedUser.siteId, requestedUser.groupSeq, requestedUser.empSeq, alert.alertId]);
  if (openingAlerts.has(key)) return openingAlerts.get(key);
  const task = enqueue(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    if (!settings?.siteId || requestedUser.siteId !== settings.siteId || requestedUser.siteOrigin !== settings.siteOrigin) {
      throw new Error('접속 사이트가 변경되었습니다. 알림 목록을 다시 열어 주세요.');
    }
    const auth = await getAuth(settings);
    if (!auth) throw new Error('아마란스10에 로그인한 뒤 다시 열어 주세요.');
    const { user } = await chrome.storage.local.get('user');
    if (user?.siteId !== settings.siteId || user?.groupSeq !== requestedUser.groupSeq || user?.empSeq !== requestedUser.empSeq) {
      throw new Error('사용자가 변경되었습니다. 알림 목록을 다시 열어 주세요.');
    }
    if (!user.compSeq) throw new Error('아마란스10 페이지를 새로고침한 뒤 다시 열어 주세요.');
    const url = buildAlertUrl(alert, user.empSeq, settings.siteOrigin);
    if (!alert.alertId || !alert.url || /\{\d+\}/.test(url)) {
      throw new Error('원문 주소를 확인할 수 없는 알림입니다. 아마란스10에서 확인해 주세요.');
    }
    await openPopupWindow(url);
    if (alert.readDate === '' || alert.readDate == null) {
      await callApi(READ_PATH, buildReadBody(user, alert.alertId), auth);
    }
    await chrome.storage.local.remove('lastReadError');
    await pollOnce();
    return { ok: true };
  }).catch((e) => enqueue(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    const error = `원문 열기 또는 알림 읽음 처리에 실패했습니다: ${e.message}`;
    if (settings?.siteId === requestedUser.siteId) {
      if (e.status === 401) await showLoginNeeded();
      await chrome.storage.local.set({ lastReadError: error });
    }
    return { ok: false, error };
  })).finally(() => openingAlerts.delete(key));
  openingAlerts.set(key, task);
  return task;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  let task;
  if (message?.type === 'saveSettings' && sender.url === chrome.runtime.getURL('src/options.html')) {
    task = enqueue(() => saveSettings(message.settings));
  } else if (message?.type === 'syncUser' && sender.tab) {
    task = enqueue(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      if (!settings?.siteId || message.user.siteId !== settings.siteId || message.user.siteOrigin !== settings.siteOrigin || new URL(sender.url).origin !== settings.siteOrigin) return { ok: false };
      if (!(await chrome.permissions.contains({ origins: [sitePattern(settings.siteOrigin)] }))) return { ok: false };
      const { user } = await chrome.storage.local.get('user');
      if (JSON.stringify(user) !== JSON.stringify(message.user)) {
        await chrome.storage.local.set({ user: message.user });
      }
      return { ok: true };
    });
  } else if (message?.type === 'openAlert' && sender.url === chrome.runtime.getURL('src/popup.html')) {
    task = openAlert(message.alert, message.user);
  } else return;
  task.then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

async function onNotificationClicked(id) {
  const { [id]: entry } = await chrome.storage.session.get(id);
  if (entry?.alert && entry.user) {
    const result = await openAlert(entry.alert, entry.user);
    if (!result.ok) return result;
  } else {
    // 업데이트 전에 생성한 알림은 읽음 처리에 필요한 사용자 정보가 없다.
    await enqueue(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      if (entry?.siteId && entry.siteId === settings?.siteId && entry.siteOrigin === settings.siteOrigin) {
        await openPopupWindow(entry.url);
      }
    });
  }
  await chrome.storage.session.remove(id);
  await chrome.notifications.clear(id);
}
chrome.notifications.onClicked.addListener(onNotificationClicked);
