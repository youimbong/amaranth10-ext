import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectNewAlerts } from '../src/lib/alerts.js';

const a = (alertId, createTime, readDate = '') => ({ alertId, createTime, readDate });

test('첫 실행은 시드만 하고 알리지 않는다', () => {
  const r = selectNewAlerts([a('2', 200), a('1', 100)], null, 'me');
  assert.deepEqual(r.newAlerts, []);
  assert.deepEqual(r.seen, { empSeq: 'me', watermark: 200, ids: ['2', '1'] });
});

test('다른 사용자로 바뀌면 다시 시드한다', () => {
  const r = selectNewAlerts([a('3', 300)], { empSeq: 'old', watermark: 100, ids: ['1'] }, 'me');
  assert.deepEqual(r.newAlerts, []);
  assert.equal(r.seen.empSeq, 'me');
});

test('이후에는 안 읽은 새 alertId만 알린다', () => {
  const seen = { empSeq: 'me', watermark: 200, ids: ['2', '1'] };
  const list = [a('4', 400), a('3', 300, '20261119085818627'), a('2', 200), a('1', 100)];
  const r = selectNewAlerts(list, seen, 'me');
  assert.deepEqual(r.newAlerts.map((x) => x.alertId), ['4']);
  assert.deepEqual(r.seen, { empSeq: 'me', watermark: 400, ids: ['4', '3', '2', '1'] });
});

test('워터마크보다 오래된 미확인 항목(목록 밖에서 밀려 들어온 옛 알림)은 알리지 않는다', () => {
  const seen = { empSeq: 'me', watermark: 300, ids: ['3'] };
  const r = selectNewAlerts([a('3', 300), a('0', 50)], seen, 'me');
  assert.deepEqual(r.newAlerts, []);
});

test('같은 목록을 다시 받으면 중복 알림이 없다', () => {
  const first = selectNewAlerts([a('5', 500), a('2', 200)], { empSeq: 'me', watermark: 200, ids: ['2'] }, 'me');
  assert.equal(first.newAlerts.length, 1);
  const second = selectNewAlerts([a('5', 500), a('2', 200)], first.seen, 'me');
  assert.deepEqual(second.newAlerts, []);
});
