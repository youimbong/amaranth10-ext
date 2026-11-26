import { normalizeSiteOrigin, sitePattern } from './lib/site.js';

const $ = (id) => document.getElementById(id);

const STATE_TEXT = {
  ok: '로그인됨',
  setup: '접속 주소 설정 필요',
  permission: '접근 권한 필요 — 접속 주소를 다시 저장해 주세요',
  login: '로그인 필요 — 설정한 아마란스10에 로그인해 주세요',
  nouser: '사용자 정보 없음 — 설정한 사이트에 로그인하고 페이지를 새로고침해 주세요',
  error: '오류',
};

function formatTime(ms) {
  return ms ? new Date(ms).toLocaleString('ko-KR') : '없음';
}

function renderStatus(status) {
  $('status').textContent = [
    `상태: ${STATE_TEXT[status?.state] ?? '아직 확인 전'}`,
    `마지막 확인: ${formatTime(status?.lastPoll)}`,
    `마지막 오류: ${status?.lastError || '없음'}`,
  ].join('\n');
}

async function load() {
  const { settings, status } = await chrome.storage.local.get(['settings', 'status']);
  $('siteOrigin').value = settings?.siteOrigin ?? '';
  $('webhookUrl').value = settings?.webhookUrl ?? '';
  $('intervalMin').value = settings?.intervalMin ?? 1;
  $('setup').hidden = Boolean(settings?.siteOrigin && settings.siteId);
  if (!$('setup').hidden) $('siteOrigin').focus();
  renderStatus(status);
}

// 권한 요청은 저장 버튼 클릭 직후, 첫 await 전에 두 주소를 한 번에 요청한다.
$('save').addEventListener('click', async () => {
  const webhookUrl = $('webhookUrl').value.trim();
  const intervalMin = Math.max(1, Math.floor(Number($('intervalMin').value)) || 1);
  try {
    const siteOrigin = normalizeSiteOrigin($('siteOrigin').value);
    const origins = [sitePattern(siteOrigin)];
    if (webhookUrl) {
      const url = new URL(webhookUrl);
      origins.push(`${url.protocol}//${url.hostname}/*`);
    }
    if (!(await chrome.permissions.request({ origins: [...new Set(origins)] }))) {
      $('message').textContent = '사이트 접근 권한이 거부되어 저장하지 않았습니다.';
      return;
    }
    const result = await chrome.runtime.sendMessage({
      type: 'saveSettings', settings: { siteOrigin, webhookUrl, intervalMin },
    });
    if (!result?.ok) throw new Error(result?.error || '설정을 저장하지 못했습니다.');
    $('siteOrigin').value = siteOrigin;
    $('intervalMin').value = intervalMin;
    $('setup').hidden = true;
    $('message').textContent = '저장했습니다. 사이트에 로그인하고 페이지를 새로고침해 주세요.';
  } catch (e) {
    $('message').textContent = `저장 실패: ${e.message}`;
  }
});

$('test').addEventListener('click', async () => {
  try {
    await chrome.notifications.create(`test:${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: '아마란스10 알림 테스트',
      message: '알림이 정상적으로 표시됩니다.',
    });
    $('message').textContent = '테스트 알림을 보냈습니다.';
  } catch (e) {
    $('message').textContent = `테스트 알림 실패: ${e.message}`;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.status) renderStatus(changes.status.newValue);
});

load();
