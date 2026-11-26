// 새 알림 선별. seen = { empSeq, watermark(최대 createTime), ids(직전 목록의 alertId) } 또는 null.
// seen이 없거나 다른 사용자면 현재 목록으로 상태만 만들고 알리지 않는다(첫 실행 시드).
export function selectNewAlerts(alertList, seen, empSeq) {
  const ids = alertList.map((a) => a.alertId);
  const maxTime = Math.max(0, ...alertList.map((a) => Number(a.createTime) || 0));

  if (!seen || seen.empSeq !== empSeq) {
    return { newAlerts: [], seen: { empSeq, watermark: maxTime, ids } };
  }

  const seenIds = new Set(seen.ids);
  const newAlerts = alertList.filter((a) =>
    a.readDate === '' && !seenIds.has(a.alertId) && Number(a.createTime) >= seen.watermark);
  return {
    newAlerts,
    seen: { empSeq, watermark: Math.max(seen.watermark, maxTime), ids },
  };
}
