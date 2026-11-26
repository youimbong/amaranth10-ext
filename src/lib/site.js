// 한 번에 한 사이트만 연결한다. 로그인 경로·쿼리·해시는 저장하지 않는다.
export function normalizeSiteOrigin(value) {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('아이디·비밀번호가 포함되지 않은 HTTPS 접속 주소를 입력해 주세요.');
  }
  return url.origin;
}

// Chrome의 사이트 권한과 콘텐츠 스크립트는 호스트 단위로 등록한다.
export function sitePattern(origin) {
  return `https://${new URL(origin).hostname}/*`;
}
