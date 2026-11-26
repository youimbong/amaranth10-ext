import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPopupWindow } from '../src/lib/client.js';

function setup() {
  const session = {};
  const windows = new Map();
  const navigations = [];
  let nextId = 1;
  globalThis.chrome = {
    storage: { session: {
      get: async (key) => ({ [key]: session[key] }),
      set: async (patch) => Object.assign(session, patch),
      remove: async (key) => { delete session[key]; },
    } },
    windows: {
      get: async (id) => {
        if (!windows.has(id)) throw new Error('No window');
        return windows.get(id);
      },
      create: async (options) => {
        const win = { ...options, id: nextId++, state: 'normal', tabs: [{ id: 10 }] };
        windows.set(win.id, win);
        return win;
      },
      update: async (id, patch) => Object.assign(windows.get(id), patch),
    },
    tabs: {
      get: async (id) => ({ id, status: 'complete' }),
      update: async (id, patch) => { navigations.push({ id, ...patch }); },
    },
  };
  return { session, windows, navigations };
}

test('서로 다른 원문 동시 열기도 하나의 창을 순서대로 재사용한다', async () => {
  const { windows, navigations } = setup();
  const [first, second] = await Promise.all([openPopupWindow('https://example.com/1'), openPopupWindow('https://example.com/2')]);
  assert.equal(windows.size, 1);
  assert.equal(first.id, second.id);
  assert.deepEqual(navigations, [{ id: 10, url: 'about:blank', active: true }, { id: 10, url: 'https://example.com/2' }]);
});

test('저장된 창을 찾아 최소화 해제하고 사용자가 지정한 크기를 유지한다', async () => {
  const { session, windows } = setup();
  session.sourceWindowId = 42;
  windows.set(42, { id: 42, type: 'popup', state: 'minimized', width: 900, height: 700, tabs: [{ id: 11 }] });
  const win = await openPopupWindow('https://example.com/1');
  assert.equal(win.id, 42);
  assert.equal(win.state, 'normal');
  assert.equal(win.focused, true);
  assert.equal(win.width, 900);
  assert.equal(win.height, 700);
});

test('닫힌 창은 새로 생성하고 다음 요청부터 다시 재사용한다', async () => {
  const { session, windows } = setup();
  const first = await openPopupWindow('https://example.com/1');
  windows.delete(first.id);
  const second = await openPopupWindow('https://example.com/2');
  assert.notEqual(first.id, second.id);
  assert.equal(session.sourceWindowId, second.id);
  assert.equal((await openPopupWindow('https://example.com/3')).id, second.id);
  assert.equal(windows.size, 1);
});

test('창 갱신 실패를 전달하고 이후 요청은 정상 실행한다', async () => {
  const { windows } = setup();
  await openPopupWindow('https://example.com/1');
  const update = chrome.tabs.update;
  chrome.tabs.update = async () => { throw new Error('update failed'); };
  await assert.rejects(openPopupWindow('https://example.com/2'), /update failed/);
  chrome.tabs.update = update;
  await openPopupWindow('https://example.com/3');
  assert.equal(windows.size, 1);
});

test('인증 쿠키는 설정된 사이트에서만 조회하고 인증에 주소를 묶는다', async () => {
  const { getAuth } = await import('../src/lib/client.js');
  const settings = { siteOrigin: 'https://erp.example.com', siteId: 'site-1' };
  const urls = [];
  globalThis.chrome = {
    storage: { local: { get: async () => ({ settings }) } },
    permissions: { contains: async () => true },
    cookies: { get: async ({ url, name }) => { urls.push(url); return { value: name === 'oAuthToken' ? 'token%2B1' : 'key' }; } },
  };
  assert.deepEqual(await getAuth(), { ...settings, token: 'token+1', signKey: 'key' });
  assert.deepEqual(urls, [settings.siteOrigin, settings.siteOrigin]);
});

test('설정 변경 전 인증 정보로 요청하지 않고 늦게 온 이전 응답도 거부한다', async () => {
  const { callApi } = await import('../src/lib/client.js');
  const old = { siteOrigin: 'https://old.example.com', siteId: 'old', token: 'old-token', signKey: 'key' };
  let settings = { siteOrigin: 'https://new.example.com', siteId: 'new' };
  let requests = 0;
  globalThis.chrome = { storage: { local: { get: async () => ({ settings }) } } };
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(url, 'https://old.example.com/event/event02A12');
    assert.equal(options.headers.Authorization, 'Bearer old-token');
    assert.equal(options.redirect, 'error');
    settings = { siteOrigin: 'https://new.example.com', siteId: 'new' };
    return { status: 200, ok: true, json: async () => ({ resultCode: 0, resultData: { alertCnt: 99 } }) };
  };
  try {
    await assert.rejects(callApi('/event/event02A12', {}, old), /사이트가 변경/);
    assert.equal(requests, 0);
    settings = old;
    await assert.rejects(callApi('/event/event02A12', {}, old), /사이트가 변경/);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});
