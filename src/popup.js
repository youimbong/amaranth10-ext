import { LIST_PATH, buildListBody } from './lib/amaranth.js';
import { getAuth, callApi } from './lib/client.js';
import { sitePattern } from './lib/site.js';
import {
  PEOPLE_PATH, ORG_OPTIONS_PATH, parseQuery, buildPeopleBody, buildOrgOptionsBody, toPeople, rankPeople,
} from './lib/people.js';

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function formatTime(ms) {
  const d = new Date(Number(ms));
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('ko-KR', sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function openErp() {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings?.siteOrigin) return chrome.runtime.openOptionsPage();
  const tabs = await chrome.tabs.query({ url: sitePattern(settings.siteOrigin) });
  const tab = tabs.find((t) => new URL(t.url).origin === settings.siteOrigin);
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: `${settings.siteOrigin}/` });
  }
}

async function refreshErp() {
  const button = $('refreshErp');
  button.disabled = true;
  try {
    const { settings } = await chrome.storage.local.get('settings');
    if (!settings?.siteOrigin) return chrome.runtime.openOptionsPage();
    const tabs = (await chrome.tabs.query({ url: sitePattern(settings.siteOrigin) }))
      .filter((tab) => new URL(tab.url).origin === settings.siteOrigin);
    if (!tabs.length) {
      $('message').textContent = '열려 있는 아마란스10 탭이 없습니다. 바로가기로 먼저 열어 주세요.';
    } else {
      await Promise.all(tabs.map((tab) => chrome.tabs.reload(tab.id)));
      $('message').textContent = `아마란스10 탭 ${tabs.length}개를 새로고침했습니다.`;
    }
    $('message').hidden = false;
  } catch (e) {
    $('message').textContent = `아마란스10 새로고침 실패: ${e.message}`;
    $('message').hidden = false;
  } finally {
    button.disabled = false;
  }
}

function showMessage(text, withErpButtons = false) {
  $('siteActions').hidden = !withErpButtons;
  $('list').hidden = true;
  $('more').hidden = true;
  const msg = $('message');
  msg.hidden = false;
  msg.replaceChildren(text);
}

const LOGIN_TEXT = '아마란스10에 로그인되어 있지 않습니다. 로그인한 뒤 다시 열어 주세요.';

function renderItem(alert, user) {
  const li = el('li', { className: alert.readDate === '' ? 'unread' : '' });
  const head = el('button', { className: 'head' },
    el('span', { className: 'title', textContent: alert.message?.alertTitle || alert.eventType || '알림' }),
    el('span', { className: 'time', textContent: formatTime(alert.createTime) }));
  li.append(head);

  head.addEventListener('click', async () => {
    if (head.disabled) return;
    head.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'openAlert', alert, user });
      if (!result?.ok) throw new Error(result?.error || '원문을 열지 못했습니다.');
      await load();
    } catch (e) {
      // 검색 중에는 결과를 가리지 않는다. 다음에 알림 목록을 열 때 안내한다.
      if (view.tab === 'people') return;
      $('message').hidden = false;
      $('message').textContent = e.message;
    } finally {
      head.disabled = false;
    }
  });
  return li;
}

const TABS = {
  unread: { newYn: 'Y', empty: '안 읽은 알림이 없습니다.' },
  all: { newYn: 'N', empty: '알림이 없습니다.' },
};

// cursor: 다음 페이지 요청에 쓸 timeStamp(더 없으면 null). pages: 불러온 페이지 수.
const emptyView = (tab) => ({ tab, user: null, alerts: [], cursor: null, pages: 0 });
let view = emptyView('unread');
let loadVersion = 0;

// 조회할 수 없으면 안내를 표시하고 null을 돌려준다. 그 사이 새 조회가 시작되면 표시하지 않는다.
async function connect(version) {
  const { settings, user, lastReadError } = await chrome.storage.local.get(['settings', 'user', 'lastReadError']);
  if (version !== loadVersion) return null;
  if (!settings?.siteOrigin || !settings.siteId) {
    showMessage('아마란스10 접속 주소를 먼저 설정해 주세요.');
    $('message').append(el('button', { textContent: '접속 주소 설정', onclick: () => chrome.runtime.openOptionsPage() }));
    await chrome.runtime.openOptionsPage();
    return null;
  }
  const allowed = await chrome.permissions.contains({ origins: [sitePattern(settings.siteOrigin)] });
  if (version !== loadVersion) return null;
  if (!allowed) {
    showMessage('사이트 접근 권한이 없습니다. 설정에서 접속 주소를 다시 저장해 주세요.');
    return null;
  }
  let auth;
  try {
    auth = await getAuth(settings);
  } catch (e) {
    if (version === loadVersion) showMessage(`로그인 상태를 확인하지 못했습니다: ${e.message}`);
    return null;
  }
  if (version !== loadVersion) return null;
  if (!auth) {
    showMessage(LOGIN_TEXT, true);
    return null;
  }
  if (!user || user.siteId !== settings.siteId || user.siteOrigin !== settings.siteOrigin) {
    showMessage('사용자 정보가 없습니다. 설정한 사이트에 로그인하고 페이지를 새로고침해 주세요.', true);
    return null;
  }
  return { user, auth, lastReadError };
}

// 커서 경계에서 같은 알림이 두 페이지에 걸쳐 와도 한 번만 남긴다.
// 커서가 나아가지 않으면 자동 더 보기가 같은 요청을 반복하므로 끝으로 본다.
function appendPage(base, page) {
  const byId = new Map([...base.alerts, ...(page.alertList || [])].map((a) => [a.alertId, a]));
  return {
    ...base,
    alerts: [...byId.values()].sort((a, b) => Number(b.createTime) - Number(a.createTime)),
    cursor: page.moreYn === 'Y' && page.timeStamp && page.timeStamp !== base.cursor ? page.timeStamp : null,
    pages: base.pages + 1,
  };
}

function fetchPage({ user, auth }, { tab, cursor }) {
  return callApi(LIST_PATH, buildListBody(user, { newYn: TABS[tab].newYn, timeStamp: cursor ?? undefined }), auth);
}

function render(lastReadError) {
  $('siteActions').hidden = true;
  const { tab, user, alerts, cursor } = view;
  const text = lastReadError || (alerts.length ? '' : TABS[tab].empty);
  $('message').textContent = text;
  $('message').hidden = !text;
  $('list').replaceChildren(...alerts.map((a) => renderItem(a, user)));
  $('list').hidden = !alerts.length;
  $('more').hidden = cursor == null;
  $('more').disabled = false;
  // 다시 관찰해야 버튼이 계속 보이는 짧은 목록에서도 이어서 불러온다. 실패 뒤에는 다시 관찰하지 않아 재시도를 반복하지 않는다.
  moreObserver.unobserve($('more'));
  if (cursor != null) moreObserver.observe($('more'));
}

// 첫 페이지부터 다시 조회한다. 더 불러온 상태였으면 같은 페이지 수까지 유지한다.
async function load() {
  if (view.tab === 'people') return searchPeople();
  const version = ++loadVersion;
  $('more').disabled = true;
  const conn = await connect(version);
  if (!conn) return;
  const pages = Math.max(1, view.pages);
  let next = { ...emptyView(view.tab), user: conn.user };
  try {
    do {
      const page = await fetchPage(conn, next);
      if (version !== loadVersion) return;
      next = appendPage(next, page);
    } while (next.cursor != null && next.pages < pages);
  } catch (e) {
    if (version !== loadVersion) return;
    if (e.status === 401) return showMessage(LOGIN_TEXT, true);
    return showMessage(`알림을 불러오지 못했습니다: ${e.message}`, true);
  }
  view = next;
  render(conn.lastReadError);
}

async function loadMore() {
  const version = ++loadVersion;
  $('more').disabled = true;
  const conn = await connect(version);
  if (!conn) return;
  const { siteId, groupSeq, empSeq } = view.user;
  if (conn.user.siteId !== siteId || conn.user.groupSeq !== groupSeq || conn.user.empSeq !== empSeq) {
    return selectTab(view.tab);
  }
  try {
    const page = await fetchPage(conn, view);
    if (version !== loadVersion) return;
    view = appendPage(view, page);
    render(conn.lastReadError);
  } catch (e) {
    if (version !== loadVersion) return;
    if (e.status === 401) return showMessage(LOGIN_TEXT, true);
    $('message').textContent = `알림을 더 불러오지 못했습니다: ${e.message}`;
    $('message').hidden = false;
    $('more').disabled = false;
  }
}

const MAX_PEOPLE = 50;
const SEARCH_DELAY_MS = 300;
let searchTimer = null;
// 검색을 마치면 돌아갈 알림 탭.
let alertTab = 'unread';
// 조직도 표시 설정은 팝업이 열려 있는 동안 사이트별로 한 번만 조회한다. 실패하면 다음 검색에서 다시 조회한다.
let orgOptions = { siteId: null, value: null };

async function getOrgOptions(auth) {
  if (orgOptions.siteId === auth.siteId) return orgOptions.value;
  try {
    const { isMobileTelNumOption, isDutypositionOption } = await callApi(ORG_OPTIONS_PATH, buildOrgOptionsBody(), auth);
    orgOptions = { siteId: auth.siteId, value: { isMobileTelNumOption, isDutypositionOption } };
    return orgOptions.value;
  } catch {
    // 표시해도 되는지 알 수 없으므로 휴대폰 없이 보여 준다.
    return null;
  }
}

async function copyContact(button, label, value) {
  try {
    await navigator.clipboard.writeText(value);
    button.classList.add('copied');
    setTimeout(() => button.classList.remove('copied'), 1500);
    $('searchStatus').textContent = `${label} 복사됨: ${value}`;
  } catch (e) {
    $('searchStatus').textContent = `복사하지 못했습니다: ${e.message}`;
  }
}

function renderPerson(person) {
  const li = el('li', { className: 'person' }, el('div', { className: 'name', textContent: person.name }));
  for (const { company, dept, path, title } of person.affiliations) {
    const text = [dept, title, company].filter(Boolean).join(' · ');
    li.append(el('div', { className: 'affiliation', textContent: text, title: path || text }));
  }
  if (person.work) li.append(el('div', { className: 'work', textContent: `담당: ${person.work}`, title: person.work }));
  const contacts = [['휴대폰', person.mobiles], ['전화', person.phones], ['내선', person.extensions], ['이메일', person.emails]]
    .flatMap(([label, values]) => values.map((value) => {
      const button = el('button', { type: 'button', title: `${label} 복사` }, el('span', { className: 'kind', textContent: label }), value);
      button.addEventListener('click', () => copyContact(button, label, value));
      return button;
    }));
  if (contacts.length) li.append(el('div', { className: 'contacts' }, ...contacts));
  return li;
}

async function searchPeople() {
  clearTimeout(searchTimer);
  const query = parseQuery($('query').value);
  // 이전 검색 결과를 유지한 채 조합이 끝나기를 기다린다.
  if (query.pending && !$('list').hidden) return;
  const version = ++loadVersion;
  const conn = await connect(version);
  if (!conn) {
    if (version === loadVersion) $('searchStatus').textContent = '';
    return;
  }
  view = { ...view, user: conn.user };
  if (!query.searchText) {
    $('searchStatus').textContent = '';
    return showMessage(query.hint || '입력을 마치면 검색합니다.');
  }
  $('searchStatus').textContent = '검색 중…';
  let people, options;
  try {
    let rows;
    [rows, options] = await Promise.all([
      callApi(PEOPLE_PATH, buildPeopleBody(query.searchText), conn.auth), getOrgOptions(conn.auth)]);
    people = rankPeople(toPeople(rows || [], options), query);
  } catch (e) {
    if (version !== loadVersion) return;
    $('searchStatus').textContent = '';
    if (e.status === 401) return showMessage(LOGIN_TEXT, true);
    return showMessage(`검색하지 못했습니다: ${e.message}`, true);
  }
  if (version !== loadVersion) return;
  if (!people.length) {
    $('searchStatus').textContent = '';
    return showMessage('일치하는 임직원이 없습니다.');
  }
  $('siteActions').hidden = true;
  $('message').hidden = true;
  $('list').replaceChildren(...people.slice(0, MAX_PEOPLE).map(renderPerson));
  $('list').hidden = false;
  $('scroll').scrollTop = 0;
  $('searchStatus').textContent = [
    people.length > MAX_PEOPLE ? `${people.length}명 중 ${MAX_PEOPLE}명 표시. 검색어를 더 입력하세요.` : `${people.length}명`,
    options ? '' : '표시 설정을 확인하지 못해 휴대폰을 숨겼습니다.',
  ].filter(Boolean).join(' · ');
}

function selectTab(tab) {
  clearTimeout(searchTimer);
  if (tab !== 'people') alertTab = tab;
  document.body.classList.toggle('people', tab === 'people');
  $('searchStatus').textContent = '';
  view = emptyView(tab);
  for (const button of $('tabs').children) button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
  showMessage(tab === 'people' ? '검색 중…' : '불러오는 중…');
  $('scroll').scrollTop = 0;
  return load();
}

// 검색할 수 있는 검색어가 되기 전에는 보던 알림 목록을 그대로 둔다.
async function applyQuery() {
  clearTimeout(searchTimer);
  const query = parseQuery($('query').value);
  if (view.tab === 'people') return query.empty ? selectTab(alertTab) : searchPeople();
  if (query.searchText) return selectTab('people');
  $('searchStatus').textContent = query.hint || '';
}

const showError = (e) => showMessage(`오류: ${e.message}`);
// 목록 끝 100px 전부터 자동으로 이어서 불러온다.
const moreObserver = new IntersectionObserver((entries) => {
  if (entries.at(-1).isIntersecting && !$('more').disabled) loadMore().catch(showError);
}, { root: $('scroll'), rootMargin: '0px 0px 100px 0px' });
for (const button of $('tabs').children) {
  button.addEventListener('click', () => {
    $('query').value = '';
    selectTab(button.dataset.tab).catch(showError);
  });
}
$('query').addEventListener('input', () => {
  clearTimeout(searchTimer);
  if (!$('query').value.trim()) return void applyQuery().catch(showError);
  searchTimer = setTimeout(() => applyQuery().catch(showError), SEARCH_DELAY_MS);
});
$('search').addEventListener('submit', (event) => {
  event.preventDefault();
  applyQuery().catch(showError);
});
$('more').addEventListener('click', () => loadMore().catch(showError));
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('openErp').addEventListener('click', () => openErp().catch(showError));
$('refreshErp').addEventListener('click', refreshErp);
load().catch(showError);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.settings || (changes.user && !view.user))) selectTab(view.tab).catch(showError);
});
