/* ============================================================
   FEATURE FLAGS — 행사마다 켜고 끌 수 있는 옵션
   ============================================================ */
export const FEATURES = {
    enableMeal:     true,
    mealLabel:      "점심",   // "저녁" / "간식" 등으로 변경 가능
    enableSchedule: true,
};

export const SCHEDULE_OPTIONS = [
    { value: "10~15시(4시간 파업)", label: "10 ~ 15시", sub: "4시간 파업 현장 참여\n오전 10시 ~ 오후 3시" },
    { value: "12~14시(2시간 집회)", label: "12 ~ 14시", sub: "2시간 집회 참여\n오후 12시 ~ 오후 2시" },
];

export const CORPS = [
    '그립컴퍼니','디케이테크인','링키지랩','볼트업','서울아레나',
    '야나두','에이엑스지','엑스엘게임즈','카카오','카카오게임즈',
    '카카오모빌리티','카카오뱅크','카카오스타일','카카오엔터테인먼트',
    '카카오엔터프라이즈','카카오임팩트','카카오페이','카카오페이증권',
    '카카오헬스케어','카카오VX','케이드라이브','케이앤웍스','케이엠파크',
    '키이스트','KP보험서비스','SM엔터테인먼트','기타 법인',
];

/** FEATURES 플래그에 따라 출석 시트 헤더를 동적으로 구성 */
export function attendHeaders() {
    return ['응답시간','법인','LDAP','이름','전화번호']
        .concat(FEATURES.enableMeal     ? ['식사여부'] : [])
        .concat(FEATURES.enableSchedule ? ['참여일정'] : [])
        .concat(['참여상태','Index','어드민확인']);
}

/** FEATURES 플래그에 따라 현장 시트 헤더를 동적으로 구성 */
export function onsiteHeaders() {
    return ['응답시간','법인','LDAP','이름','전화번호']
        .concat(FEATURES.enableMeal     ? ['식사여부'] : [])
        .concat(FEATURES.enableSchedule ? ['참여일정'] : [])
        .concat(['조합원여부','Index','어드민확인']);
}

export function normalizePhone(p) { return String(p).replace(/[^0-9]/g, ''); }
export function formatPhone(p) {
    const d = String(p).replace(/[^0-9]/g, '');
    if (d.length === 11) return `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`;
    if (d.length === 10) return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
    return d;
}
export function nowKST() {
    return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace('T', ' ');
}
