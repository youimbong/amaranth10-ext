// 실제 Chromium에 확장을 올려 서비스 워커·옵션 페이지·폴링·Teams 전달·액션 팝업·미리보기를 확인한다.
// erp.example.test API는 Playwright route로 모의하고, 웹후크는 로컬 모의 서버로 보낸다(외부 전송 없음).
// 사용: CHROMIUM_PATH=<Chromium 실행 파일> node test-e2e/run.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const SITE = 'https://erp.example.test';
const OTHER_SITE = 'https://other.example.test';

const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = fileURLToPath(new URL('./.tmp/', import.meta.url));
const extDir = tmp + 'ext';
const profileDir = tmp + 'profile';
rmSync(tmp, { recursive: true, force: true });
mkdirSync(extDir, { recursive: true });
for (const p of ['manifest.json', 'src', 'icons']) cpSync(root + p, `${extDir}/${p}`, { recursive: true });
// 권한 대화상자를 자동화할 수 없으므로 테스트 사본에서만 로컬 모의 서버 주소를 미리 허용한다.
const manifest = JSON.parse(readFileSync(`${extDir}/manifest.json`, 'utf8'));
manifest.host_permissions = [`${SITE}/*`, `${OTHER_SITE}/*`, 'http://127.0.0.1/*'];
writeFileSync(`${extDir}/manifest.json`, JSON.stringify(manifest));
// 네이티브 알림 클릭은 자동화할 수 없으므로 테스트 사본에서만 클릭 처리 함수를 노출해 직접 부른다.
const bgPath = `${extDir}/src/background.js`;
writeFileSync(bgPath, readFileSync(bgPath, 'utf8') + '\nglobalThis.__onNotificationClicked = onNotificationClicked;\nglobalThis.__poll = poll;\nglobalThis.__openPopupWindow = openPopupWindow;\n');

// Teams 웹후크·원문 화면 모의 서버
const hooks = [];
const server = createServer((req, res) => {
  // 해시가 바뀌어도 다시 그리지 않는 원문 화면. 제목은 문서를 로드한 시점의 해시로 고정된다.
  if (req.method === 'GET') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<script>document.title = location.hash</script>');
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { hooks.push({ method: req.method, url: req.url, body: JSON.parse(body) }); res.writeHead(202).end(); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const webhookUrl = `http://127.0.0.1:${server.address().port}/hook`;

const FAKE = { token: 'fake-token-1', signKey: 'fake-sign-key' };
let user = { groupSeq: 'g-test', empSeq: 'me', compSeq: 'c1', bizSeq: 'b1', deptSeq: 'd1', emailAdd: 'x', emailDomain: 'example.com' };
const userHeader = { groupSeq: user.groupSeq, empSeq: user.empSeq };
const alert = (alertId, createTime, extra = {}) => ({
  alertId, createTime, readDate: '', eventType: 'EAPPROVAL', url: `/#/popup?docID=${alertId}`, data: '{}',
  message: { alertTitle: `[결재] ${alertId}`, alertContent: `내용 ${alertId}` }, ...extra,
});
const mail = alert('A2', 2000, {
  eventType: 'MAIL',
  url: '/#/popup?{0}&{1}&{2}&{3}&print=false&callComp=UDAP006&MicroModuleCode=mail&inOutCheck=1',
  data: JSON.stringify({ recvList: [{ empSeq: 'me', muid: 1001, email: 'x@example.com', mboxSeq: 10, boxName: 'INBOX', paramStr: 'muid|email|mboxSeq|boxName' }] }),
  mailUid: '1001',
  message: { alertTitle: '[메일] 테스트', alertContent: '보낸사람 : 테스트' },
});
const MAIL_URL = 'https://erp.example.test/#/popup?muid=1001&email=x%40example.com&mbodSeq=10&boxName=INBOX&print=false&callComp=UDAP006&MicroModuleCode=mail&inOutCheck=1';
const eap = alert('E3', 3000, {
  url: '/#/popup?callComp=UBAP002&MicroModuleCode=eap&docID=2001&formId=3001',
  data: JSON.stringify({ form_nm: '품의서', doc_no: 'D-1', title: '구매 품의', userName: '김기안', deptName: '개발팀' }),
  message: { alertTitle: '[결재진행] 구매 품의', alertContent: '기안자:김기안' },
});
// 미리보기 본문: 스크립트가 돌면 script.example.test로 이동하고, 외부 이미지는 img.example.test를 요청한다.
const mailDetail = {
  seenYN: 0,
  decodeMime: { subject: '메일 제목 E2E', from: '보낸이 <s@example.com>', to: 'x@example.com', date: '2026-11-19 10:00' },
  mime: {
    fileList: [{ fileName: '첨부.pdf' }],
    body: { html: '<p id="mailtext">메일 본문 E2E</p><img src="https://img.example.test/track.png">'
      + '<script>location.href = "https://script.example.test/ran";</script>' },
  },
};
const eapDetail = {
  docTitle: '구매 품의', docNo: 'D-1', docStsName: '진행', formName: '품의서', empName: '김기안', deptName: '개발팀', repDt: '2026-11-19',
  line: [
    { user_nm: '김기안', act_nm: '기안', doc_line_sts: '10', action_time: '2026-11-19 09:00' },
    { user_nm: '이결재', act_nm: '결재', doc_line_sts: '20', action_time: '' },
  ],
  fileList: [{ dispFileNm: '견적서.xlsx' }],
  docContents: '<p id="eaptext">결재 본문 E2E</p>',
};

const person = (empSeq, empName, extra = {}) => ({
  empSeq, empName, compName: '가상회사', deptName: '개발팀', pathName: '가상회사|본부|개발팀', positionName: '과장', dutyName: '팀장',
  mobileTelNum: '01012345678', telNum: '0212345678', extNum: '1234', emailAddr: `${empSeq}@example.com`, mailUseYn: 'Y',
  empPrivateOptionValue: '', mainWork: '<b>확장</b> 개발', loginId: 'secret-login', employeeNumber: 'secret-number', ...extra,
});
let peopleRows = {};
let peopleMode = 'ok';
let peopleWait = null;
let orgOptionsMode = 'ok';

let apiMode = 'ok';
let readMode = 'ok';
let readWait = null;
let alertList = [alert('A1', 1000)];
let otherAlertList = [alert('A2', 2000)];
let apiWait = null;
const apiCalls = [];
let listMode = 'ok';
// 커서를 포함(<=)해 돌려주어 페이지 경계의 중복 제거도 확인한다.
function listPage(items, { newYn, timeStamp, pageSize }) {
  const rest = items.filter((a) => (newYn === 'N' || !a.readDate) && a.createTime <= timeStamp);
  const size = Number(pageSize);
  if (rest.length <= size) return { alertList: rest, moreYn: 'N', timeStamp: rest.at(-1)?.createTime ?? null };
  const page = rest.slice(0, size);
  return { alertList: page, moreYn: 'Y', timeStamp: page.at(-1).createTime };
}

const context = await chromium.launchPersistentContext(profileDir, {
  executablePath: process.env.CHROMIUM_PATH,
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
const DETAILS = { '/mail/mail002A01': () => mailDetail, '/eap/eap111A04': () => eapDetail };
await context.route(/^https:\/\/(erp|other)\.example\.test\//, async (route) => {
  const req = route.request();
  const { pathname: path, origin } = new URL(req.url());
  // API가 아닌 요청(원문 창·아마란스10 열기)은 빈 페이지로 대신한다.
  if (req.method() !== 'POST') return route.fulfill({ contentType: 'text/html', body: '<title>stub</title>' });
  const h = req.headers();
  const token = h.authorization?.replace('Bearer ', '');
  const expectedSign = createHmac('sha256', FAKE.signKey)
    .update(token + h['transaction-id'] + h.timestamp + path).digest('base64');
  apiCalls.push({ path, origin, token, signOk: h['wehago-sign'] === expectedSign, body: req.postDataJSON() });
  if (apiWait) await apiWait;
  if (apiMode === '401') {
    return route.fulfill({ status: 401, json: { resultCode: 140, resultMsg: 'expired', statusValue: 401 } });
  }
  if (path === '/gw/APIHandler/gw102A01') {
    if (orgOptionsMode === '500') return route.fulfill({ status: 500, json: {} });
    return route.fulfill({ json: { resultCode: 0, resultData: { isMobileTelNumOption: '1', isDutypositionOption: '3', treeList: [] } } });
  }
  if (path === '/gw/APIHandler/gw102A02') {
    const { searchText } = req.postDataJSON();
    if (peopleWait?.searchText === searchText) await peopleWait.promise;
    if (peopleMode === '500') return route.fulfill({ status: 500, json: {} });
    return route.fulfill({ json: { resultCode: 0, resultData: peopleRows[searchText] || [] } });
  }
  if (path === '/event/event02A01' && listMode === '500') return route.fulfill({ status: 500, json: {} });
  if (path === '/event/event02A01' && listMode === 'stuck') {
    return route.fulfill({ json: { resultCode: 0, resultData: { alertList: alertList.slice(0, 3), moreYn: 'Y', timeStamp: 1000 } } });
  }
  if (path === '/event/event02A03') {
    if (readWait) await readWait;
    if (readMode === '500') return route.fulfill({ status: 500, json: {} });
    if (readMode === 'rejected') return route.fulfill({ json: { resultCode: 1 } });
    const ids = req.postDataJSON().body.alertIds;
    if (origin === OTHER_SITE) otherAlertList = otherAlertList.map((a) => ids.includes(a.alertId) ? { ...a, readDate: '20261123090000000' } : a);
    else alertList = alertList.map((a) => ids.includes(a.alertId) ? { ...a, readDate: '20261123090000000' } : a);
    return route.fulfill({ json: { resultCode: 0, resultData: null } });
  }
  const items = origin === OTHER_SITE ? otherAlertList : alertList;
  const resultData = path === '/event/event02A12' ? { alertCnt: items.filter((a) => !a.readDate).length, mention: 0 }
    : DETAILS[path] ? DETAILS[path]() : listPage(items, req.postDataJSON().body);
  return route.fulfill({ json: { resultCode: 0, resultData, resultMsg: 'SUCCESS' } });
});
const imgHits = [];
const scriptHits = [];
await context.route('https://img.example.test/**', (route) => {
  imgHits.push(route.request().url());
  return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') });
});
await context.route('https://script.example.test/**', (route) => {
  scriptHits.push(route.request().url());
  return route.fulfill({ contentType: 'text/html', body: 'ran' });
});

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
  console.log(results.at(-1));
}
const waitFor = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('시간 초과');
    await new Promise((r) => setTimeout(r, 200));
  }
};
const setCookies = (token, origin = SITE) => context.addCookies(['oAuthToken', 'signKey'].map((name) => ({
  name, value: name === 'oAuthToken' ? token : FAKE.signKey, domain: new URL(origin).hostname, path: '/', secure: true, sameSite: 'Lax',
})));

try {
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  await sw.evaluate(() => {
    globalThis.__removedOrigins = [];
    chrome.permissions.remove = async ({ origins }) => { globalThis.__removedOrigins.push(...origins); return true; };
  });
  const getState = () => sw.evaluate(async () => ({
    status: (await chrome.storage.local.get('status')).status,
    badge: await chrome.action.getBadgeText({}),
    notifications: Object.keys(await chrome.notifications.getAll()),
  }));

  const extErrors = [];
  context.on('page', (p) => p.on('pageerror', (e) => {
    if (p.url().startsWith('chrome-extension://')) extErrors.push(`${p.url()}: ${e.message}`);
  }));
  const selectTab = async (p, tab) => {
    await p.click(`#tabs [data-tab=${tab}]`);
    await waitFor(async () => (await p.locator('#message').textContent()) !== '불러오는 중…');
  };
  const openPopup = async () => {
    const p = await context.newPage();
    await p.goto(`chrome-extension://${extId}/src/popup.html`);
    await selectTab(p, 'all');
    return p;
  };
  const reloadPopup = async (p) => {
    await p.reload();
    await selectTab(p, 'all');
  };
  const popupWindows = () => sw.evaluate(async () => (await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] }))
    .map((w) => ({ id: w.id, type: w.type, urls: w.tabs.map((t) => t.pendingUrl || t.url) })));
  const closePopupWindows = () => sw.evaluate(async () => {
    for (const w of await chrome.windows.getAll({ windowTypes: ['popup'] })) await chrome.windows.remove(w.id);
  });
  const LOGIN_TEXT = '로그인되어 있지 않습니다';

  await check('서비스 워커 시작', async () => assert.match(sw.url(), /src\/background\.js$/));

  let page;
  await check('최초 설치: 주소가 없으면 설정 화면 자동 열기', async () => {
    page = await waitFor(() => context.pages().find((p) => p.url() === `chrome-extension://${extId}/src/options.html`));
    await waitFor(async () => await page.locator('#setup').isVisible());
    assert.equal(await page.locator('#siteOrigin').evaluate((input) => document.activeElement === input), true);
  });
  page ??= await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`chrome-extension://${extId}/src/options.html`);

  await check('옵션 페이지 렌더링', async () => {
    assert.equal(await page.locator('h1').textContent(), '아마란스10 알림 설정');
    await waitFor(async () => !(await page.locator('#status').textContent()).includes('불러오는 중'));
  });

  await check('주소 미설정 → 설정 화면 자동 열기, API 호출 없음', async () => {
    const p = await context.newPage();
    await p.addInitScript(() => {
      const openOptionsPage = chrome.runtime.openOptionsPage.bind(chrome.runtime);
      window.__optionsOpened = 0;
      chrome.runtime.openOptionsPage = () => { window.__optionsOpened++; return openOptionsPage(); };
    });
    await p.goto(`chrome-extension://${extId}/src/popup.html`);
    await waitFor(async () => (await p.locator('#message').textContent()).includes('접속 주소를 먼저'));
    await waitFor(() => p.evaluate(() => window.__optionsOpened === 1));
    assert.equal(apiCalls.length, 0);
    assert.equal(await page.locator('#siteOrigin').inputValue(), '');
    await p.close();
  });

  await check('사이트 권한 거부 → 설정을 저장하지 않음', async () => {
    await page.fill('#siteOrigin', SITE);
    await page.evaluate(() => {
      window.__requestPermission = chrome.permissions.request;
      chrome.permissions.request = async () => false;
    });
    try {
      await page.click('#save');
      await waitFor(async () => (await page.locator('#message').textContent()).includes('거부'));
      assert.equal((await page.evaluate(() => chrome.storage.local.get('settings'))).settings, undefined);
    } finally {
      await page.evaluate(() => { chrome.permissions.request = window.__requestPermission; });
    }
  });

  await check('설정 저장', async () => {
    await page.fill('#siteOrigin', `${SITE}/#/login`);
    await page.fill('#webhookUrl', webhookUrl);
    await page.fill('#intervalMin', '2');
    await page.click('#save');
    await waitFor(async () => (await page.locator('#message').textContent()).startsWith('저장했습니다.'));
    const { settings } = await page.evaluate(() => chrome.storage.local.get('settings'));
    assert.deepEqual({ ...settings, siteId: undefined }, { siteOrigin: SITE, siteId: undefined, webhookUrl, intervalMin: 2 });
    assert.ok(settings.siteId);
    assert.equal(await page.locator('#setup').isHidden(), true);
    user = { ...user, siteOrigin: SITE, siteId: settings.siteId };
    const [script] = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    assert.deepEqual(script.matches, [`${SITE}/*`]);
    const alarm = await sw.evaluate(() => chrome.alarms.get('poll'));
    assert.equal(alarm.periodInMinutes, 2);
  });

  await check('쿠키 없음 → 로그인 필요 상태', async () => {
    await page.evaluate((u) => chrome.storage.local.set({ user: u }), user); // user 변경이 폴링을 트리거
    await waitFor(async () => (await getState()).status?.state === 'login');
    assert.equal((await getState()).badge, '!');
    await waitFor(async () => (await page.locator('#status').textContent()).includes('로그인 필요'));
    assert.equal(apiCalls.length, 0);
  });

  await check('팝업: 쿠키 없음 → 로그인 안내 + 아마란스10 열기', async () => {
    const optionsBefore = context.pages().filter((p) => p.url().endsWith('/src/options.html')).length;
    const p = await openPopup();
    await waitFor(async () => (await p.locator('#message').textContent()).includes(LOGIN_TEXT));
    assert.equal(context.pages().filter((p) => p.url().endsWith('/src/options.html')).length, optionsBefore);
    await p.click('#openErp');
    await waitFor(async () => (await sw.evaluate(() => chrome.tabs.query({}))).some((t) => (t.url || t.pendingUrl || '').startsWith(`${SITE}/`)));
    assert.equal(apiCalls.length, 0);
    await p.close();
  });

  await check('테스트 알림 버튼', async () => {
    await page.click('#test');
    await waitFor(async () => (await page.locator('#message').textContent()) === '테스트 알림을 보냈습니다.');
  });

  await check('로그인 후 첫 폴링은 시드만(알림·Teams 없음)', async () => {
    await setCookies(FAKE.token);
    await waitFor(async () => (await getState()).status?.state === 'ok');
    const s = await getState();
    assert.equal(s.badge, '1');
    assert.equal(s.notifications.filter((n) => n.startsWith('alert:')).length, 0);
    assert.equal(hooks.length, 0);
    assert.ok(apiCalls.every((c) => c.signOk), '서명 불일치');
    assert.deepEqual(apiCalls.find((c) => c.path === '/event/event02A01').body.header, userHeader);
  });

  await check('새 알림 → Chrome 알림 + Teams 페이로드', async () => {
    alertList = [mail, alert('A1', 1000)];
    await setCookies('fake-token-2'); // 쿠키 변경으로 폴링 트리거
    await waitFor(() => hooks.length >= 1);
    const s = await getState();
    assert.deepEqual(s.notifications.filter((n) => n.startsWith('alert:')), ['alert:A2']);
    assert.equal(s.badge, '2');
    assert.equal(hooks.length, 1);
    const card = hooks[0].body.attachments[0];
    assert.equal(hooks[0].body.type, 'message');
    assert.equal(card.contentType, 'application/vnd.microsoft.card.adaptive');
    assert.equal(card.content.version, '1.4');
    assert.equal(card.content.body[0].text, '[메일] 테스트');
    assert.equal(card.content.actions[0].url,
      'https://erp.example.test/#/popup?muid=1001&email=x%40example.com&mbodSeq=10&boxName=INBOX&print=false&callComp=UDAP006&MicroModuleCode=mail&inOutCheck=1');
  });

  alertList = [mail, eap, { ...alert('A1', 1000), readDate: '20261119085818627' }];
  let popup;
  await check('팝업: 목록(최신순, 안 읽음 표시, 시각)', async () => {
    popup = await openPopup();
    const items = popup.locator('#list li');
    await waitFor(async () => (await items.count()) === 3);
    assert.equal(await popup.locator('#siteActions').isHidden(), true);
    assert.deepEqual(await popup.locator('#list .title').allTextContents(), ['[결재진행] 구매 품의', '[메일] 테스트', '[결재] A1']);
    assert.deepEqual(await items.evaluateAll((els) => els.map((e) => e.classList.contains('unread'))), [true, true, false]);
    assert.ok((await popup.locator('#list .time').allTextContents()).every((t) => /\d/.test(t)));
    assert.deepEqual(apiCalls.at(-1).body.header, userHeader);
  });

  const readCalls = () => apiCalls.filter((c) => c.path === '/event/event02A03');
  await check('목록 한 번 클릭 → 실제 원문 + 서버 읽음 + 배지 갱신', async () => {
    await popup.locator('#list li').nth(1).locator('.head').click();
    const w = await waitFor(async () => (await popupWindows()).find((x) => x.urls.includes(MAIL_URL)));
    assert.equal(w.type, 'popup');
    await waitFor(async () => (await getState()).badge === '1');
    await waitFor(async () => !(await popup.locator('#list li').nth(1).getAttribute('class')).includes('unread'));
    assert.equal(await popup.locator('.detail, .preview, .source').count(), 0);
    const call = readCalls().at(-1);
    assert.ok(call.signOk);
    assert.deepEqual(call.body, {
      header: { ...userHeader, pid: '', tid: '' },
      body: { companyInfo: { compSeq: 'c1', bizSeq: 'b1', deptSeq: 'd1', emailAddr: 'x', emailDomain: 'example.com' }, alertIds: ['A2'] },
    });
    await closePopupWindows();
  });

  await check('다른 알림도 같은 원문 창 재사용, 위치·크기 유지, 닫으면 재생성', async () => {
    await popup.locator('#list li').nth(1).locator('.head').click();
    const first = await waitFor(async () => (await popupWindows()).find((w) => w.urls.includes(MAIL_URL)));
    await waitFor(async () => !(await popup.locator('#list li').nth(1).locator('.head').isDisabled()));
    const bounds = await sw.evaluate(async (id) => {
      const w = await chrome.windows.update(id, { left: 100, top: 100, width: 900, height: 700 });
      return { left: w.left, top: w.top, width: w.width, height: w.height };
    }, first.id);
    await popup.locator('#list li').nth(2).locator('.head').click();
    await waitFor(async () => !(await popup.locator('#list li').nth(2).locator('.head').isDisabled()));
    const windows = await popupWindows();
    assert.equal(windows.length, 1);
    assert.equal(windows[0].id, first.id);
    await waitFor(async () => (await popupWindows())[0].urls.includes('https://erp.example.test/#/popup?docID=A1'));
    const reused = await sw.evaluate((id) => chrome.windows.get(id), first.id);
    assert.deepEqual({ left: reused.left, top: reused.top, width: reused.width, height: reused.height }, bounds);
    assert.equal(reused.focused, true);
    await closePopupWindows();
    await popup.locator('#list li').nth(1).locator('.head').click();
    const next = await waitFor(async () => (await popupWindows()).find((w) => w.urls.includes(MAIL_URL)));
    assert.notEqual(next.id, first.id);
    await waitFor(async () => !(await popup.locator('#list li').nth(1).locator('.head').isDisabled()));
    await closePopupWindows();
  });

  await check('해시만 다른 원문도 같은 창에서 새로 로드', async () => {
    const base = `${new URL(webhookUrl).origin}/`;
    const open = (hash) => sw.evaluate(async (url) => (await globalThis.__openPopupWindow(url)).id, base + hash);
    const shows = (id, hash) => waitFor(async () => {
      const [tab] = await sw.evaluate((windowId) => chrome.tabs.query({ windowId }), id);
      return tab.url === base + hash && tab.title === hash;
    }).catch(async (e) => {
      const [tab] = await sw.evaluate((windowId) => chrome.tabs.query({ windowId }), id);
      throw new Error(`${e.message}: 주소 ${tab.url}, 화면 ${tab.title}`);
    });
    const id = await open('#/popup?docID=1');
    await shows(id, '#/popup?docID=1');
    for (const hash of ['#/popup?docID=2', '#/popup?docID=3&x=a%2Bb%26c', '#/popup?docID=3&x=a%2Bb%26c', '#/popup?docID=1']) {
      assert.equal(await open(hash), id);
      await shows(id, hash);
    }
    // 로드가 끝나기 전에 다시 열어도 마지막에 연 원문이 남는다.
    for (let i = 0; i < 30; i++) {
      await open(`#/popup?docID=a${i}`);
      await new Promise((r) => setTimeout(r, (i % 10) * 5));
      await open(`#/popup?docID=b${i}`);
      await shows(id, `#/popup?docID=b${i}`);
    }
    assert.equal((await popupWindows()).length, 1);
    await closePopupWindows();
  });

  await check('이미 읽은 알림은 원문만 열고 읽음 요청 생략', async () => {
    const before = readCalls().length;
    await popup.locator('#list li').nth(1).locator('.head').click();
    await waitFor(async () => (await popupWindows()).some((x) => x.urls.includes(MAIL_URL)));
    await waitFor(async () => !(await popup.locator('#list li').nth(1).locator('.head').isDisabled()));
    assert.equal(readCalls().length, before);
    await closePopupWindows();
  });

  await check('원문 창 생성 실패 → 읽음 요청 없음 + 오류 안내', async () => {
    const before = readCalls().length;
    await sw.evaluate(() => {
      globalThis.__createWindow = chrome.windows.create;
      chrome.windows.create = async () => { throw new Error('window failed'); };
    });
    try {
      await popup.locator('#list li').nth(0).locator('.head').click();
      await waitFor(async () => (await popup.locator('#message').textContent()).includes('window failed'));
      assert.equal(readCalls().length, before);
      assert.equal(await popup.locator('#list li').nth(0).getAttribute('class'), 'unread');
    } finally {
      await sw.evaluate(() => { chrome.windows.create = globalThis.__createWindow; });
    }
  });

  for (const mode of ['500', 'rejected']) {
    await check(`읽음 API ${mode} → 미읽음 유지 + 다시 열어도 오류 안내`, async () => {
      readMode = mode;
      await popup.locator('#list li').nth(0).locator('.head').click();
      await waitFor(async () => !(await popup.locator('#list li').nth(0).locator('.head').isDisabled()));
      assert.equal(await popup.locator('#list li').nth(0).getAttribute('class'), 'unread');
      await reloadPopup(popup);
      await waitFor(async () => (await popup.locator('#message').textContent()).includes('처리에 실패'));
      assert.equal(await popup.locator('#list li').nth(0).getAttribute('class'), 'unread');
      await closePopupWindows();
      readMode = 'ok';
    });
  }

  await check('동일 알림 동시 요청 → 원문 창·읽음 API 각각 한 번', async () => {
    let release;
    readWait = new Promise((resolve) => { release = resolve; });
    const before = readCalls().length;
    try {
      await popup.evaluate(({ alert, user }) => {
        const message = { type: 'openAlert', alert, user };
        window.__requests = Promise.all([chrome.runtime.sendMessage(message), chrome.runtime.sendMessage(message)]);
      }, { alert: eap, user });
      await waitFor(() => readCalls().length === before + 1);
      assert.equal((await popupWindows()).length, 1);
      release();
      assert.deepEqual(await popup.evaluate(() => window.__requests), [{ ok: true }, { ok: true }]);
      assert.equal(readCalls().length, before + 1);
      await reloadPopup(popup);
      await waitFor(async () => !(await popup.locator('#list li').nth(0).getAttribute('class')).includes('unread'));
      assert.equal((await getState()).badge, '');
      assert.equal(await popup.locator('#message').isHidden(), true);
    } finally {
      release();
      readWait = null;
      await closePopupWindows();
    }
  });

  await check('목록 팝업 종료 후에도 서비스 워커가 읽음 처리 완료', async () => {
    alertList = alertList.map((a) => a.alertId === 'A2' ? { ...a, readDate: '' } : a);
    await reloadPopup(popup);
    await waitFor(async () => (await popup.locator('#list li').nth(1).getAttribute('class')) === 'unread');
    let release;
    readWait = new Promise((resolve) => { release = resolve; });
    const before = readCalls().length;
    try {
      await popup.locator('#list li').nth(1).locator('.head').click();
      await waitFor(() => readCalls().length === before + 1);
      await popup.close();
      release();
      await waitFor(() => !!alertList.find((a) => a.alertId === 'A2').readDate);
      popup = await openPopup();
      await waitFor(async () => (await popup.locator('#list li').nth(1).getAttribute('class')) === '');
    } finally {
      release();
      readWait = null;
      await closePopupWindows();
    }
  });

  await check('이전 버전 사용자 정보 → 새로고침 안내, 읽음 요청 없음', async () => {
    const before = readCalls().length;
    await sw.evaluate((u) => chrome.storage.local.set({ user: u }), { ...userHeader, siteOrigin: user.siteOrigin, siteId: user.siteId });
    try {
      await popup.locator('#list li').nth(0).locator('.head').click();
      await waitFor(async () => (await popup.locator('#message').textContent()).includes('새로고침'));
      assert.equal(readCalls().length, before);
      assert.equal((await popupWindows()).length, 0);
    } finally {
      await sw.evaluate((u) => chrome.storage.local.set({ user: u }), user);
    }
  });

  await check('목록 표시 후 사용자 변경 → 원문 열기와 읽음 요청 중단', async () => {
    const before = readCalls().length;
    await sw.evaluate((u) => chrome.storage.local.set({ user: { ...u, empSeq: 'other' } }), user);
    try {
      await popup.locator('#list li').nth(0).locator('.head').click();
      await waitFor(async () => (await popup.locator('#message').textContent()).includes('사용자가 변경'));
      assert.equal(readCalls().length, before);
      assert.equal((await popupWindows()).length, 0);
    } finally {
      await sw.evaluate((u) => chrome.storage.local.set({ user: u }), user);
    }
  });

  await check('목록 표시 후 읽음 API 401 → 미읽음 유지 + 오류 안내', async () => {
    alertList = alertList.map((a) => a.alertId === 'A2' ? { ...a, readDate: '' } : a);
    await reloadPopup(popup);
    await waitFor(async () => (await popup.locator('#list li').nth(1).getAttribute('class')) === 'unread');
    apiMode = '401';
    try {
      await popup.locator('#list li').nth(1).locator('.head').click();
      await waitFor(async () => (await popup.locator('#message').textContent()).includes('인증 만료'));
      assert.equal(await popup.locator('#list li').nth(1).getAttribute('class'), 'unread');
      assert.equal(alertList.find((a) => a.alertId === 'A2').readDate, '');
    } finally {
      apiMode = 'ok';
      await closePopupWindows();
    }
  });

  const savedList = alertList;
  const titles = () => popup.locator('#list .title').allTextContents();
  const scrollToEnd = () => popup.evaluate(() => { const s = document.getElementById('scroll'); s.scrollTop = s.scrollHeight; });
  const listCalls = () => apiCalls.filter((c) => c.path === '/event/event02A01');
  // 45건 중 최근 25건은 읽음, 그 이전 20건은 안 읽음. 기존 20건 제한에서는 안 읽은 알림이 하나도 보이지 않는다.
  const many = (unreadCount) => Array.from({ length: unreadCount + 25 }, (_, i) => {
    const n = unreadCount + 25 - i;
    return alert(`P${n}`, 1000 + n, i < 25 ? { readDate: '20261119085818627' } : {});
  });
  await check('팝업 기본 탭은 안읽음이고 최근 20건 밖의 안 읽은 알림도 보인다', async () => {
    alertList = many(20);
    await popup.reload();
    await waitFor(async () => (await popup.locator('#list li').count()) === 20);
    assert.equal(await popup.locator('#tabs [data-tab=unread]').getAttribute('aria-pressed'), 'true');
    assert.equal(await popup.locator('#list li:not(.unread)').count(), 0);
    assert.equal((await titles())[0], '[결재] P20');
    assert.equal(listCalls().at(-1).body.body.newYn, 'Y');
    assert.equal(await popup.locator('#more').isHidden(), true);
  });

  await check('전체 탭 스크롤: 자동으로 커서를 이어 받고 중복 없이 끝까지, 마지막에 버튼 숨김', async () => {
    await selectTab(popup, 'all');
    const before = listCalls().length;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(listCalls().length, before, '스크롤 전에 다음 페이지를 요청함');
    assert.equal(await popup.locator('#list li').count(), 20);
    assert.equal(listCalls().at(-1).body.body.newYn, 'N');
    await scrollToEnd();
    await waitFor(async () => (await popup.locator('#list li').count()) === 39);
    assert.equal(listCalls().at(-1).body.body.timeStamp, 1026);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(listCalls().length, before + 1, '한 번 스크롤에 한 페이지만 요청해야 함');
    await scrollToEnd();
    await waitFor(async () => (await popup.locator('#list li').count()) === 45);
    assert.deepEqual(await titles(), alertList.map((a) => a.message.alertTitle));
    assert.equal(await popup.locator('#more').isHidden(), true);
  });

  await check('자동 더 보기 실패 → 목록 유지 + 오류 안내, 자동 재시도 없음, 버튼으로 이어서 조회', async () => {
    await selectTab(popup, 'all');
    listMode = '500';
    try {
      const before = listCalls().length;
      await scrollToEnd();
      await waitFor(async () => (await popup.locator('#message').textContent()).includes('더 불러오지 못했습니다'));
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(listCalls().length, before + 1);
      assert.equal(await popup.locator('#list li').count(), 20);
      assert.equal(await popup.locator('#list').isVisible(), true);
    } finally {
      listMode = 'ok';
    }
    await popup.click('#more');
    await waitFor(async () => (await popup.locator('#list li').count()) === 39);
    assert.doesNotMatch(await popup.locator('#message').textContent(), /더 불러오지 못했습니다/);
  });

  await check('더 불러온 항목을 열면 펼친 범위를 유지하고 읽음 반영', async () => {
    const item = popup.locator('#list li', { hasText: '[결재] P18' });
    assert.equal(await item.getAttribute('class'), 'unread');
    await item.locator('.head').click();
    await waitFor(async () => (await item.getAttribute('class')) === '');
    assert.equal(await popup.locator('#list li').count(), 39);
    await closePopupWindows();
  });

  await check('안읽음 탭에서 연 알림은 목록에서 빠진다', async () => {
    await selectTab(popup, 'unread');
    assert.equal(await popup.locator('#list li').count(), 19);
    await popup.locator('#list .head').first().click();
    await waitFor(async () => (await popup.locator('#list li').count()) === 18);
    assert.equal((await titles())[0], '[결재] P19');
    await closePopupWindows();
  });

  await check('더 보기 응답 전에 탭을 바꾸면 이전 탭 결과를 섞지 않는다', async () => {
    alertList = many(45);
    await selectTab(popup, 'all');
    let release;
    apiWait = new Promise((resolve) => { release = resolve; });
    try {
      const before = listCalls().length;
      await scrollToEnd();
      await waitFor(() => listCalls().length === before + 1);
      apiWait = null; // 더 보기 응답만 붙잡아 둔다
      await selectTab(popup, 'unread');
      assert.equal(await popup.locator('#list li').count(), 20);
    } finally {
      release();
      apiWait = null;
    }
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await popup.locator('#list li').count(), 20);
    assert.equal(await popup.locator('#list li:not(.unread)').count(), 0);
    assert.equal((await titles())[0], '[결재] P45');
  });

  await check('커서가 나아가지 않으면 자동 요청을 반복하지 않는다', async () => {
    listMode = 'stuck';
    try {
      await selectTab(popup, 'all');
      const before = listCalls().length;
      await new Promise((r) => setTimeout(r, 1000));
      assert.ok(listCalls().length - before <= 1, `요청 ${listCalls().length - before}회`);
      assert.equal(await popup.locator('#more').isHidden(), true);
    } finally {
      listMode = 'ok';
    }
  });

  await check('팝업 높이는 Chrome 상한 600px 안, 목록만 스크롤', async () => {
    await selectTab(popup, 'all');
    assert.ok(await popup.evaluate(() => document.body.getBoundingClientRect().height) <= 600);
    assert.ok(await popup.evaluate(() => { const s = document.getElementById('scroll'); return s.scrollHeight > s.clientHeight; }));
    if (process.env.SHOT) await popup.screenshot({ path: process.env.SHOT });
  });

  await check('안 읽은 알림이 없으면 안읽음 탭에 안내', async () => {
    alertList = savedList.map((a) => ({ ...a, readDate: '20261119085818627' }));
    await selectTab(popup, 'unread');
    assert.equal(await popup.locator('#message').textContent(), '안 읽은 알림이 없습니다.');
    assert.equal(await popup.locator('#list').isHidden(), true);
    alertList = savedList;
    await closePopupWindows();
  });

  const peopleCalls = () => apiCalls.filter((c) => c.path === '/gw/APIHandler/gw102A02');
  const searchStatus = () => popup.locator('#searchStatus').textContent();
  const names = () => popup.locator('#list .name').allTextContents();
  const queryFor = async (text, expected) => {
    await popup.fill('#query', text);
    await waitFor(async () => (await names()).join() === expected.join() && await popup.locator('#list').isVisible());
  };
  await check('임직원 검색창: 탭 위에 항상 표시, 열면 포커스, 짧은 검색어와 조합 중에는 알림 목록 유지·요청 없음', async () => {
    await popup.reload();
    assert.equal(await popup.locator('#query').evaluate((e) => document.activeElement === e), true);
    assert.ok((await popup.locator('#search').boundingBox()).y < (await popup.locator('#tabs').boundingBox()).y);
    await selectTab(popup, 'all');
    const before = await popup.locator('#list .head').count();
    assert.ok(before > 0);
    for (const [text, hint] of [['김', '두 글자 이상 입력하세요.'], ['010', '번호는 네 자리 이상 입력하세요.'], ['김ㅁ', ''], ['%%', '두 글자 이상 입력하세요.']]) {
      await popup.fill('#query', text);
      await new Promise((r) => setTimeout(r, 450));
      assert.equal(await searchStatus(), hint);
      assert.equal(await popup.locator('#list .head').count(), before);
      assert.ok(await popup.locator('#list').isVisible());
    }
    assert.equal(peopleCalls().length, 0);
  });
  await check('임직원 검색창: 검색어를 지우거나 탭을 누르면 보던 알림으로 복귀', async () => {
    peopleRows = { 김철수: [person('13', '김철수')] };
    await queryFor('김철수', ['김철수']);
    assert.deepEqual(await popup.locator('#tabs button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-pressed'))), ['false', 'false']);
    await popup.fill('#query', '');
    await waitFor(async () => await popup.locator('#list .head').count() > 0);
    assert.equal(await popup.locator('#tabs [data-tab=all]').getAttribute('aria-pressed'), 'true');
    assert.equal(await popup.locator('#query').evaluate((e) => document.activeElement === e), true);
    assert.equal(await searchStatus(), '');
    await queryFor('김철수', ['김철수']);
    await selectTab(popup, 'unread');
    assert.equal(await popup.locator('#query').inputValue(), '');
    assert.equal(await popup.locator('#list .person').count(), 0);
    // 입력 직후 탭을 누르면 예약된 검색을 취소한다.
    const before = peopleCalls().length;
    await popup.fill('#query', '김철수');
    await selectTab(popup, 'all');
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(peopleCalls().length, before);
    assert.ok(await popup.locator('#list .head').count() > 0);
  });
  await check('임직원 검색: 자동 검색, 겸직 묶음, 표시 설정 준수, HTML 이스케이프, 민감 항목 미표시', async () => {
    peopleRows = {
      홍길동: [person('11', '홍길동'), person('11', '홍길동', { compName: '계열사', deptName: '기획팀', telNum: '', extNum: '' }),
        person('12', '홍길동', { deptName: '기획팀', pathName: '가상회사|기획팀', empPrivateOptionValue: 'mobileTelNum', mailUseYn: 'N', mainWork: '' })],
      김철수: [person('13', '김철수')],
    };
    const before = peopleCalls().length;
    await popup.locator('#query').fill('');
    await popup.locator('#query').pressSequentially('홍길동', { delay: 20 });
    await waitFor(async () => (await names()).join() === '홍길동,홍길동');
    assert.equal(peopleCalls().length, before + 1);
    const call = peopleCalls().at(-1);
    assert.ok(call.signOk);
    assert.deepEqual(call.body, { popupType: 'main', selectedType: 'search', searchDiv: 'all', searchText: '홍길동' });
    assert.equal(await searchStatus(), '2명');
    const [first, second] = await popup.locator('#list .person').all();
    assert.deepEqual(await first.locator('.affiliation').allTextContents(), ['개발팀 · 팀장 · 과장 · 가상회사', '기획팀 · 팀장 · 과장 · 계열사']);
    assert.deepEqual(await first.locator('.contacts button').allTextContents(),
      ['휴대폰010-1234-5678', '전화02-1234-5678', '내선1234', '이메일11@example.com']);
    assert.equal(await first.locator('.work').textContent(), '담당: <b>확장</b> 개발');
    assert.deepEqual(await second.locator('.contacts button').allTextContents(), ['전화02-1234-5678', '내선1234']);
    assert.equal((await popup.locator('body').innerHTML()).includes('secret'), false);
    if (process.env.SHOT_PEOPLE) await popup.screenshot({ path: process.env.SHOT_PEOPLE });
  });
  await check('임직원 검색: 단어 추가로 좁히기, 조합 중 결과 유지, 연락처 복사, 결과 없음', async () => {
    await queryFor('홍길동 기획', ['홍길동', '홍길동']);
    await queryFor('홍길동 본부', ['홍길동']);
    const before = peopleCalls().length;
    await popup.fill('#query', '홍길동 본부 ㄱ');
    await new Promise((r) => setTimeout(r, 450));
    assert.deepEqual(await names(), ['홍길동']);
    assert.equal(peopleCalls().length, before);
    await popup.evaluate(() => { navigator.clipboard.writeText = async (text) => { window.__copied = text; }; });
    await popup.locator('.contacts button').first().click();
    await waitFor(async () => (await searchStatus()) === '휴대폰 복사됨: 010-1234-5678');
    assert.equal(await popup.evaluate(() => window.__copied), '010-1234-5678');
    await popup.fill('#query', '없는사람');
    await waitFor(async () => (await popup.locator('#message').textContent()) === '일치하는 임직원이 없습니다.');
    assert.equal(await popup.locator('#list').isHidden(), true);
  });
  await check('임직원 검색: 늦게 온 이전 응답과 다른 탭 결과를 섞지 않음', async () => {
    let release;
    peopleWait = { searchText: '홍길동', promise: new Promise((resolve) => { release = resolve; }) };
    try {
      const before = peopleCalls().length;
      await popup.fill('#query', '홍길동');
      await waitFor(() => peopleCalls().length > before);
      await queryFor('김철수', ['김철수']);
      await popup.fill('#query', '홍길동');
      await waitFor(() => peopleCalls().length > before + 2);
      await selectTab(popup, 'all');
      release();
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(await popup.locator('#list .person').count(), 0);
      assert.ok(await popup.locator('#list .head').count() > 0);
    } finally {
      release();
      peopleWait = null;
    }
  });
  await check('임직원 검색: 50명까지 표시, 팝업 높이 600px 이내', async () => {
    peopleRows.개발팀 = Array.from({ length: 60 }, (_, i) => person(`p${i}`, `사원${i}`));
    await popup.fill('#query', '개발팀');
    await waitFor(async () => (await searchStatus()).startsWith('60명 중 50명'));
    assert.equal(await popup.locator('#list .person').count(), 50);
    assert.ok(await popup.evaluate(() => document.body.getBoundingClientRect().height) <= 600);
    assert.ok(await popup.evaluate(() => { const s = document.getElementById('scroll'); return s.scrollHeight > s.clientHeight; }));
  });
  await check('임직원 검색: 실패 안내 후 Enter 재시도, 표시 설정 조회 실패 시 휴대폰 숨김, 저장 없음', async () => {
    peopleMode = '500';
    await popup.fill('#query', '김철수');
    await waitFor(async () => (await popup.locator('#message').textContent()).includes('검색하지 못했습니다'));
    peopleMode = 'ok';
    await popup.press('#query', 'Enter');
    await waitFor(async () => (await names()).join() === '김철수' && await popup.locator('#list').isVisible());
    orgOptionsMode = '500';
    await reloadPopup(popup);
    await popup.fill('#query', '김철수');
    await waitFor(async () => (await searchStatus()).includes('휴대폰을 숨겼습니다'));
    assert.deepEqual(await popup.locator('.contacts button').allTextContents(), ['전화02-1234-5678', '내선1234', '이메일13@example.com']);
    orgOptionsMode = 'ok';
    await popup.press('#query', 'Enter');
    await waitFor(async () => (await searchStatus()) === '1명');
    const stored = await sw.evaluate(async () => JSON.stringify([await chrome.storage.local.get(null), await chrome.storage.session.get(null)]));
    assert.equal(/김철수|홍길동/.test(stored), false);
    await selectTab(popup, 'all');
  });

  await check('메일 미리보기: sandbox iframe, 스크립트 미실행, 외부 이미지 기본 차단', async () => {
    const pv = await context.newPage();
    await pv.goto(`chrome-extension://${extId}/src/preview.html?type=MAIL&uid=1001&siteId=${user.siteId}`);
    assert.match(pv.url(), /preview\.html\?type=MAIL&uid=1001&siteId=/);
    await waitFor(async () => (await pv.locator('#info h1').textContent()) === '메일 제목 E2E');
    assert.match(await pv.locator('#info').textContent(), /첨부\.pdf/);
    assert.match(await pv.locator('#info .note').textContent(), /읽음 처리/);
    const call = apiCalls.findLast((c) => c.path === '/mail/mail002A01');
    assert.ok(call.signOk);
    assert.equal(call.body.uid, '1001');
    assert.equal(await pv.locator('#bodyFrame').getAttribute('sandbox'), 'allow-popups allow-popups-to-escape-sandbox');
    const frame = pv.frameLocator('#bodyFrame');
    assert.equal(await frame.locator('#mailtext').textContent(), '메일 본문 E2E');
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(scriptHits, [], '본문 스크립트가 실행됨');
    assert.deepEqual(imgHits, [], '외부 이미지가 기본으로 요청됨');
    await pv.check('#remoteImages');
    await waitFor(() => imgHits.length > 0);
    assert.equal(await frame.locator('#mailtext').textContent(), '메일 본문 E2E');
    assert.deepEqual(scriptHits, []);
    await pv.close();
    await closePopupWindows();
  });

  await check('결재 미리보기: 헤더·결재선·본문', async () => {
    const pv = await context.newPage();
    await pv.goto(`chrome-extension://${extId}/src/preview.html?type=EAPPROVAL&docID=2001&formId=3001&siteId=${user.siteId}`);
    await waitFor(async () => (await pv.locator('#info h1').textContent()) === '구매 품의');
    const info = await pv.locator('#info dd').allTextContents();
    assert.deepEqual(info, ['D-1', '진행', '품의서', '김기안', '개발팀', '2026-11-19', '견적서.xlsx']);
    assert.deepEqual(await pv.locator('tr.line td:first-child').allTextContents(), ['김기안', '이결재']);
    assert.equal(await pv.frameLocator('#bodyFrame').locator('#eaptext').textContent(), '결재 본문 E2E');
    const call = apiCalls.findLast((c) => c.path === '/eap/eap111A04');
    assert.ok(call.signOk);
    assert.equal(call.body.doc_id, '2001');
    assert.equal(call.body.form_id, '3001');
    assert.equal(call.body.setReadYn, 'N');
    await pv.close();
    await closePopupWindows();
    await popup.close();
  });

  await check('OS 알림 클릭: 읽음 API 실패 → 미읽음 유지·오류 저장·재시도 정보 유지', async () => {
    alertList = alertList.map((a) => a.alertId === 'A2' ? { ...a, readDate: '' } : a);
    readMode = '500';
    try {
      const result = await sw.evaluate(() => globalThis.__onNotificationClicked('alert:A2'));
      assert.equal(result.ok, false);
      assert.equal(alertList.find((a) => a.alertId === 'A2').readDate, '');
      const state = await sw.evaluate(async () => ({
        ...(await chrome.storage.local.get('lastReadError')),
        ...(await chrome.storage.session.get('alert:A2')),
      }));
      assert.match(state.lastReadError, /HTTP 500/);
      assert.equal(state['alert:A2'].alert.alertId, 'A2');
    } finally {
      readMode = 'ok';
      await closePopupWindows();
    }
  });

  await check('OS 알림 중복 클릭: 원문·읽음 한 번, 서버 읽음·배지 갱신·알림 제거', async () => {
    const before = readCalls().length;
    await sw.evaluate(() => Promise.all([
      globalThis.__onNotificationClicked('alert:A2'), globalThis.__onNotificationClicked('alert:A2'),
    ]));
    const w = await waitFor(async () => (await popupWindows()).find((x) => x.urls.includes(MAIL_URL)));
    assert.equal(w.type, 'popup');
    assert.equal(readCalls().length, before + 1);
    assert.equal(readCalls().at(-1).signOk, true);
    assert.deepEqual(readCalls().at(-1).body.body.alertIds, ['A2']);
    assert.ok(alertList.find((a) => a.alertId === 'A2').readDate);
    assert.equal((await getState()).badge, String(alertList.filter((a) => !a.readDate).length || ''));
    assert.equal((await getState()).notifications.includes('alert:A2'), false);
    assert.deepEqual(await sw.evaluate(() => chrome.storage.local.get('lastReadError')), {});
    assert.deepEqual(await sw.evaluate(() => chrome.storage.session.get('alert:A2')), {});
    await closePopupWindows();
  });

  await check('401 → 로그인 필요 상태', async () => {
    apiMode = '401';
    await setCookies('fake-token-3');
    await waitFor(async () => (await getState()).status?.state === 'login');
    assert.equal((await getState()).badge, '!');
  });

  await check('팝업: 401 → 로그인 안내', async () => {
    const p = await openPopup();
    await waitFor(async () => (await p.locator('#message').textContent()).includes(LOGIN_TEXT));
    assert.equal(await p.locator('#openErp').count(), 1);
    await p.close();
  });

  await check('팝업: 사용자 정보 없음 → 안내', async () => {
    apiMode = 'ok';
    await sw.evaluate(() => chrome.storage.local.remove('user'));
    const p = await openPopup();
    await waitFor(async () => (await p.locator('#message').textContent()).includes('페이지를 새로고침'));
    assert.equal(await p.locator('#openErp').count(), 1);
    await p.close();
  });

  await check('새로고침: 설정한 사이트 탭들을 새로고침하고 사용자 정보·목록 자동 복구', async () => {
    const erpTabs = await Promise.all([context.newPage(), context.newPage()]);
    const other = await context.newPage();
    const p = await openPopup();
    try {
      for (const tab of [...erpTabs, other]) {
        await tab.addInitScript(() => sessionStorage.setItem('loads', String(Number(sessionStorage.getItem('loads')) + 1)));
      }
      for (const tab of erpTabs) {
        await tab.goto(`${SITE}/refresh-test`);
        await tab.addInitScript((u) => sessionStorage.setItem('userInfo', JSON.stringify({ ucUserInfo: u })), user);
      }
      await other.goto(`${OTHER_SITE}/refresh-test`);
      assert.equal(await p.locator('#siteActions').isVisible(), true);
      const navigations = erpTabs.map((tab) => tab.waitForNavigation());
      await p.click('#refreshErp');
      await Promise.all(navigations);
      for (const tab of erpTabs) {
        assert.equal(await tab.evaluate(() => sessionStorage.getItem('loads')), '2');
      }
      assert.equal(await other.evaluate(() => sessionStorage.getItem('loads')), '1');
      await waitFor(async () => (await sw.evaluate(() => chrome.storage.local.get('user'))).user?.empSeq === user.empSeq);
      await waitFor(async () => !(await p.locator('#message').textContent()).includes('사용자 정보가 없습니다'));
      await waitFor(async () => await p.locator('#siteActions').isHidden());
      assert.equal(await p.locator('#refreshErp').isEnabled(), true);
    } finally {
      for (const tab of [...erpTabs, other, p]) await tab.close();
    }
  });

  await check('새로고침: 일치하는 탭 없음·실패 안내, 버튼 재활성화', async () => {
    await sw.evaluate(() => chrome.storage.local.remove('user'));
    const p = await openPopup();
    try {
      await p.evaluate((site) => {
        chrome.tabs.query = async () => [{ id: 123, url: `${site}:8443/` }];
        chrome.tabs.reload = async () => { throw new Error('reload-failed'); };
      }, SITE);
      await p.click('#refreshErp');
      await waitFor(async () => (await p.locator('#message').textContent()).includes('탭이 없습니다'));
      assert.equal(await p.locator('#refreshErp').isEnabled(), true);
      await p.evaluate((site) => { chrome.tabs.query = async () => [{ id: 123, url: `${site}/` }]; }, SITE);
      await p.click('#refreshErp');
      await waitFor(async () => (await p.locator('#message').textContent()).includes('새로고침 실패: reload-failed'));
      assert.equal(await p.locator('#refreshErp').isEnabled(), true);
    } finally {
      await p.close();
    }
  });

  await check('같은 사이트 설정 변경은 사용자·알림 기준 유지', async () => {
    await sw.evaluate((u) => chrome.storage.local.set({ user: u }), user);
    await waitFor(async () => (await getState()).status?.state === 'ok');
    const before = await sw.evaluate(() => chrome.storage.local.get(['settings', 'user', 'seen']));
    await page.fill('#intervalMin', '3');
    await page.click('#save');
    await waitFor(async () => (await sw.evaluate(() => chrome.storage.local.get('settings'))).settings.intervalMin === 3);
    const after = await sw.evaluate(() => chrome.storage.local.get(['settings', 'user', 'seen']));
    assert.equal(after.settings.siteId, before.settings.siteId);
    assert.deepEqual(after.user, before.user);
    assert.deepEqual(after.seen, before.seen);
  });

  await check('조회 중 사이트 변경 → 이전 작업 완료 후 정보·알림 초기화', async () => {
    let release;
    apiWait = new Promise((resolve) => { release = resolve; });
    const beforeCalls = apiCalls.length;
    try {
      await sw.evaluate((u) => chrome.storage.local.set({ user: { ...u, deptSeq: 'changed' } }), user);
      await waitFor(() => apiCalls.length > beforeCalls);
      await page.fill('#siteOrigin', `${OTHER_SITE}/#/login`);
      await page.click('#save');
      release();
      await waitFor(async () => (await sw.evaluate(() => chrome.storage.local.get('settings'))).settings.siteOrigin === OTHER_SITE);
      await waitFor(async () => (await getState()).status?.state === 'login');
      const state = await sw.evaluate(async () => ({
        ...(await chrome.storage.local.get(['settings', 'user', 'seen', 'lastReadError'])),
        registered: await chrome.scripting.getRegisteredContentScripts(),
        session: await chrome.storage.session.get(null),
        removed: globalThis.__removedOrigins,
      }));
      assert.notEqual(state.settings.siteId, user.siteId);
      assert.equal(state.user, null);
      assert.equal(state.seen, undefined); // 로그인 필요 상태에서 기존 기준 제거
      assert.equal(state.lastReadError, null);
      assert.deepEqual(state.registered[0].matches, [`${OTHER_SITE}/*`]);
      assert.ok(state.removed.includes(`${SITE}/*`));
      assert.equal(Object.keys(state.session).some((key) => key.startsWith('alert:') || key === 'sourceWindowId'), false);
      assert.equal((await getState()).notifications.some((id) => id.startsWith('alert:')), false);
    } finally {
      release();
      apiWait = null;
    }
  });

  await check('사이트 변경 후 이전 목록·알림·미리보기는 새 사이트 요청을 만들지 않음', async () => {
    const before = apiCalls.length;
    const p = await openPopup();
    try {
      const result = await p.evaluate(({ alert, user }) => chrome.runtime.sendMessage({ type: 'openAlert', alert, user }), { alert: mail, user });
      assert.equal(result.ok, false);
      assert.match(result.error, /사이트가 변경/);
      await sw.evaluate(() => globalThis.__onNotificationClicked('alert:A2'));
      const oldPreview = await context.newPage();
      await oldPreview.goto(`chrome-extension://${extId}/src/preview.html?type=MAIL&uid=1001&siteId=${user.siteId}`);
      // 새 사이트는 아직 비로그인이다. 이전 문서를 새 사이트로 요청하지 않는다.
      await waitFor(async () => (await oldPreview.locator('#info').textContent()).includes('로그인'));
      assert.equal(apiCalls.length, before);
      await oldPreview.close();
    } finally {
      await p.close();
    }
  });

  await check('새 사이트 동적 스크립트로 사용자 수집, 첫 조회 시드·원문·읽음 모두 새 주소 사용', async () => {
    const hooksBefore = hooks.length;
    await setCookies('other-site-token', OTHER_SITE);
    const erp = await context.newPage();
    await erp.goto(`${OTHER_SITE}/`);
    await erp.evaluate((u) => sessionStorage.setItem('userInfo', JSON.stringify({ ucUserInfo: u })), user);
    await erp.reload();
    await waitFor(async () => (await getState()).status?.state === 'ok');
    const { user: nextUser } = await sw.evaluate(() => chrome.storage.local.get('user'));
    assert.equal(nextUser.siteOrigin, OTHER_SITE);
    assert.notEqual(nextUser.siteId, user.siteId);
    assert.equal(hooks.length, hooksBefore);
    const p = await openPopup();
    await waitFor(async () => (await p.locator('#list li').count()) === 1);
    await p.locator('#list .head').click();
    await waitFor(async () => !(await p.locator('#list .head').isDisabled()));
    const last = readCalls().at(-1);
    assert.equal(last.origin, OTHER_SITE);
    assert.equal(last.token, 'other-site-token');
    assert.equal((await popupWindows())[0].urls[0], `${OTHER_SITE}/#/popup?docID=A2`);
    assert.equal((await getState()).badge, '');
    await p.close();
    await erp.close();
    await closePopupWindows();
  });

  await check('이전 사이트의 잔존 콘텐츠 스크립트 메시지는 거부', async () => {
    const erp = await context.newPage();
    await erp.goto(`${SITE}/old-script-test`);
    const before = await sw.evaluate(() => chrome.storage.local.get('user'));
    const result = await sw.evaluate(async ({ user, origin }) => {
      const tabs = await chrome.tabs.query({ url: `${origin}/*` });
      const tab = tabs.find((t) => t.url === `${origin}/old-script-test`);
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (user) => chrome.runtime.sendMessage({ type: 'syncUser', user }), args: [user],
      });
      return result.result;
    }, { user, origin: SITE });
    assert.equal(result.ok, false);
    assert.deepEqual(await sw.evaluate(() => chrome.storage.local.get('user')), before);
    await erp.close();
  });

  await check('사이트 접근 권한 상실 → 안내, API 조회 중지', async () => {
    const before = apiCalls.length;
    await sw.evaluate(() => {
      globalThis.__containsPermission = chrome.permissions.contains;
      chrome.permissions.contains = async () => false;
    });
    await sw.evaluate(() => globalThis.__poll());
    assert.equal((await getState()).status.state, 'permission');
    const p = await context.newPage();
    await p.addInitScript(() => { chrome.permissions.contains = async () => false; });
    await p.goto(`chrome-extension://${extId}/src/popup.html`);
    try {
      await waitFor(async () => (await p.locator('#message').textContent()).includes('접근 권한'));
      assert.equal(apiCalls.length, before);
    } finally {
      await sw.evaluate(() => { chrome.permissions.contains = globalThis.__containsPermission; });
      await p.close();
    }
  });

  await check('옵션 페이지 오류 없음', async () => assert.deepEqual(pageErrors, []));
  await check('확장 페이지 오류 없음', async () => assert.deepEqual(extErrors, []));
} finally {
  await context.close();
  server.close();
}

console.log(`검증 ${results.length}개, 성공 ${results.filter((r) => r.startsWith('PASS')).length}개`);
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
