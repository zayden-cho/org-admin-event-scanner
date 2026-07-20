/* 비즈니스 로직
   ─────────────────────────────────────────────────────────
   API 호출 최적화:
     - 헤더맵: ensureSheet 완료 시 자동 캐시 → getHeaderMap 추가 호출 없음
     - appendRowByHeader: 캐시된 맵 전달 → 재조회 없음
     - findRowByPhone: 오픈형 범위 → _getLastRow 호출 제거
   ─────────────────────────────────────────────────────────*/

import { getAccessToken } from './auth.js';
import {
    getHeaderMap, batchGetValues, findRowByPhone, findRowByIndex,
    appendRowByHeader, updateCell, ensureSheet, colLetter,
} from './sheets.js';
import {
    FEATURES, attendHeaders, onsiteHeaders,
    normalizePhone, formatPhone, nowKST,
} from './settings.js';

/* ── 토큰 헬퍼 ── */
async function getToken(env) {
    const key = env.SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n');
    return getAccessToken(env.SERVICE_ACCOUNT_EMAIL, key);
}

/* ── 헤더맵 후보 컬럼 찾기 ── */
function col(map, candidates) {
    for (const c of candidates) if (map[c] !== undefined) return map[c];
    return null;
}


/* ═══════════════════════════════════════════════════════════
   참석확인 (checkIn)

   API 호출 흐름:
     최초 요청: ensureSheet(출석) + ensureSheet/getHeaderMap(응답)
                → 각각 헤더 조회 1회 후 캐시
     이후 요청: 전화번호 컬럼 1~2회 + 매칭 행 1회 + appendRow 1회
                = 3~4 회
   ═══════════════════════════════════════════════════════════ */
export async function checkIn(env, corp, phone, lunch) {
    lunch = FEATURES.enableMeal ? lunch : '';

    const tk        = await getToken(env);
    const phoneNorm = normalizePhone(phone);
    const phoneFmt  = formatPhone(phone);
    const eId       = env.EVENT_SHEET_ID;
    const sheetName = env.ATTEND_SHEET_NAME || '테스트';

    /* ① 시트 준비 + 헤더맵 취득 (캐시 우선, 최초 1회만 API 호출)
          ensureSheet와 getHeaderMap(응답) 을 병렬로 실행 */
    await Promise.all([
        ensureSheet(tk, eId, sheetName, attendHeaders()),
        getHeaderMap(tk, eId, '응답'),     // 캐시 적재
    ]);
    const aMap = await getHeaderMap(tk, eId, sheetName); // 캐시 반환
    const rMap = await getHeaderMap(tk, eId, '응답');     // 캐시 반환

    const aPhoneCol    = col(aMap, ['전화번호']);
    const aIndexCol    = col(aMap, ['Index', 'index']);
    const rPhoneCol    = col(rMap, ['전화번호']);
    const rCorpCol     = col(rMap, ['법인']);
    const rLdapCol     = col(rMap, ['LDAP']);
    const rNameCol     = col(rMap, ['이름']);
    const rScheduleCol = col(rMap, ['참여일정']);
    const rIndexCol    = col(rMap, ['index', 'Index']);
    const rStatusCol   = col(rMap, ['참여상태']);

    if (rPhoneCol == null || rIndexCol == null) {
        return { status: 'error', message: '사전신청 시트 헤더를 확인해 주세요.' };
    }

    /* ② batchGet: 출석(전화번호+Index) + 응답(전체) 를 1번 API 호출로 취득
          → 순차 4회 호출 → 1회로 단축
          → 매칭은 메모리에서 처리 (추가 API 호출 없음) */
    const [attendPhones, attendIndexes, responseRows] = await batchGetValues(tk, eId, [
        `${sheetName}!${colLetter(aPhoneCol)}2:${colLetter(aPhoneCol)}`,  // 출석 전화번호
        `${sheetName}!${colLetter(aIndexCol)}2:${colLetter(aIndexCol)}`,  // 출석 Index
        `응답!A2:Z`,                                                         // 응답 전체
    ]);

    /* ③ 출석 중복 확인 (메모리 검색) */
    for (let i = 0; i < attendPhones.length; i++) {
        const cell = String((attendPhones[i] || [])[0] || '').replace(/[^0-9]/g, '');
        if (cell === phoneNorm) {
            return {
                status: 'ok', qrType: 'CHECKIN', isDuplicate: true,
                qrId: String((attendIndexes[i] || [])[0] || ''),
            };
        }
    }

    /* ④ 응답 시트 매칭 (메모리 검색, 법인+전화번호) */
    const matched = responseRows.find(row =>
        String(row[rPhoneCol] || '').replace(/[^0-9]/g, '') === phoneNorm &&
        String(row[rCorpCol]  || '').trim() === corp
    );

    if (!matched) return { status: 'ok', qrType: 'NOSUB', qrId: 'KU-NOSUB' };

    /* ⑤ 출석 저장 (캐시된 aMap 전달 → appendRowByHeader 내부 재조회 없음) */
    const index    = String(matched[rIndexCol] ?? '').trim();
    const schedule = (FEATURES.enableSchedule && rScheduleCol != null)
        ? String(matched[rScheduleCol] ?? '').trim() : '';

    await appendRowByHeader(tk, eId, sheetName, {
        '응답시간': nowKST(),
        '법인':     corp,
        'LDAP':     rLdapCol   != null ? String(matched[rLdapCol]   ?? '').trim() : '',
        '이름':     rNameCol   != null ? String(matched[rNameCol]   ?? '').trim() : '',
        '전화번호': phoneFmt,
        '식사여부': lunch,
        '참여일정': schedule,
        '참여상태': rStatusCol != null ? String(matched[rStatusCol] ?? '').trim() : '',
        'Index':    index,
        '어드민확인': '',
    }, aMap);

    return { status: 'ok', qrType: 'CHECKIN', qrId: index, isDuplicate: false };
}


/* ═══════════════════════════════════════════════════════════
   현장신청 (onSiteRegister)
   ═══════════════════════════════════════════════════════════ */
export async function onSiteRegister(env, corp, ldap, name, phone, schedule, lunch) {
    lunch    = FEATURES.enableMeal     ? lunch    : '';
    schedule = FEATURES.enableSchedule ? schedule : '';

    if (env.ONSITE_BLOCK === 'true') {
        return { status: 'ok', qrType: 'NOSUB', qrId: 'KU-NOSUB' };
    }

    const tk        = await getToken(env);
    const phoneNorm = normalizePhone(phone);
    const phoneFmt  = formatPhone(phone);
    const eId       = env.EVENT_SHEET_ID;
    const sheetName = env.ATTEND_SHEET_NAME || '테스트';

    /* ① 응답 시트 헤더맵 (캐시 우선) */
    const rMap = await getHeaderMap(tk, eId, '응답');
    const rPhoneCol    = col(rMap, ['전화번호']);
    const rCorpCol     = col(rMap, ['법인']);
    const rLdapCol     = col(rMap, ['LDAP']);
    const rNameCol     = col(rMap, ['이름']);
    const rScheduleCol = col(rMap, ['참여일정']);
    const rIndexCol    = col(rMap, ['index', 'Index']);
    const rStatusCol   = col(rMap, ['참여상태']);

    /* ② 사전신청자 확인 → 출석 처리 후 CHECKIN QR */
    if (rPhoneCol != null) {
        const preMatch = await findRowByPhone(tk, eId, '응답', rPhoneCol, phoneNorm);
        if (preMatch) {
            await ensureSheet(tk, eId, sheetName, attendHeaders());
            const aMap      = await getHeaderMap(tk, eId, sheetName);
            const aPhoneCol = col(aMap, ['전화번호']);
            const aIndexCol = col(aMap, ['Index', 'index']);

            /* 이미 출석 처리됐는지 */
            const already = await findRowByPhone(tk, eId, sheetName, aPhoneCol, phoneNorm);
            if (already) {
                return { status: 'ok', qrType: 'CHECKIN', qrId: String(already.values[aIndexCol] ?? ''), isDuplicate: true };
            }

            const r      = preMatch.values;
            const rIndex = rIndexCol != null ? String(r[rIndexCol] ?? '').trim() : '';
            const rSched = (FEATURES.enableSchedule && rScheduleCol != null)
                ? String(r[rScheduleCol] ?? '').trim() : '';

            await appendRowByHeader(tk, eId, sheetName, {
                '응답시간': nowKST(),
                '법인':     rCorpCol  != null ? String(r[rCorpCol]  ?? '').trim() : corp,
                'LDAP':     rLdapCol  != null ? String(r[rLdapCol]  ?? '').trim() : '',
                '이름':     rNameCol  != null ? String(r[rNameCol]  ?? '').trim() : '',
                '전화번호': phoneFmt,
                '식사여부': lunch,
                '참여일정': rSched,
                '참여상태': rStatusCol != null ? String(r[rStatusCol] ?? '').trim() : '',
                'Index':    rIndex,
                '어드민확인': '',
            }, aMap);
            return { status: 'ok', qrType: 'CHECKIN', qrId: rIndex, isDuplicate: false };
        }
    }

    /* ③ 현장 시트 준비 + 중복 확인 */
    await ensureSheet(tk, eId, '현장', onsiteHeaders());
    const oMap      = await getHeaderMap(tk, eId, '현장');
    const oPhoneCol = col(oMap, ['전화번호']);
    const oIndexCol = col(oMap, ['Index', 'index']);

    const dup = await findRowByPhone(tk, eId, '현장', oPhoneCol, phoneNorm);
    if (dup) {
        return { status: 'ok', qrType: 'ONSITE', qrId: String(dup.values[oIndexCol] ?? '') };
    }

    /* ④ 조합원 여부 확인 */
    let memberStatus = '비조합원';
    let krewId       = null;
    try {
        const kMap      = await getHeaderMap(tk, env.KREW_SHEET_ID, '크루유니언');
        const kIdCol    = col(kMap, ['krewunionId', 'KrewunionId', 'Index', 'index']) ?? 0;
        const kCorpCol  = col(kMap, ['법인'])              ?? 1;
        const kNameCol  = col(kMap, ['한글명', '이름'])     ?? 2;
        const kLdapCol  = col(kMap, ['영문명', 'LDAP'])     ?? 3;
        const kPhoneCol = col(kMap, ['연락처', '전화번호']) ?? 4;

        const krewMatch = await findRowByPhone(
            tk, env.KREW_SHEET_ID, '크루유니언', kPhoneCol, phoneNorm,
            row => {
                const baseMatch = String(row[kCorpCol] ?? '').trim() === corp
                    && String(row[kNameCol] ?? '').trim() === name;
                const ldapMatch = ldap ? String(row[kLdapCol] ?? '').trim() === ldap : true;
                return baseMatch && ldapMatch;
            }
        );
        if (krewMatch) {
            memberStatus = '조합원';
            krewId       = String(krewMatch.values[kIdCol] ?? '').trim();
        }
    } catch { memberStatus = '조합원DB조회실패'; }

    /* ⑤ 비조합원 */
    if (!krewId) {
        await appendRowByHeader(tk, eId, '현장', {
            '응답시간': nowKST(), '법인': corp, 'LDAP': ldap, '이름': name,
            '전화번호': phoneFmt, '식사여부': lunch, '참여일정': schedule,
            '조합원여부': memberStatus, 'Index': 'KU-NOMEM', '어드민확인': '',
        }, oMap);
        return { status: 'ok', qrType: 'NOMEM', qrId: 'KU-NOMEM' };
    }

    /* ⑥ 조합원 */
    await appendRowByHeader(tk, eId, '현장', {
        '응답시간': nowKST(), '법인': corp, 'LDAP': ldap, '이름': name,
        '전화번호': phoneFmt, '식사여부': lunch, '참여일정': schedule,
        '조합원여부': memberStatus, 'Index': krewId, '어드민확인': '',
    }, oMap);
    return { status: 'ok', qrType: 'ONSITE', qrId: krewId };
}


/* ═══════════════════════════════════════════════════════════
   어드민 PIN 확인
   ═══════════════════════════════════════════════════════════ */
export function adminVerifyPin(env, pin) {
    const correct = env.ADMIN_PIN;
    if (!correct) return { status: 'error',  message: 'ADMIN_PIN 환경변수가 설정되지 않았습니다.' };
    if (String(pin).trim() !== String(correct).trim()) return { status: 'wrong', message: 'PIN이 올바르지 않습니다.' };
    return { status: 'ok' };
}


/* ═══════════════════════════════════════════════════════════
   QR 스캔 조회 (adminScanQR)

   API 호출 흐름:
     최초 요청: getHeaderMap 1회 → 캐시
     이후 요청: Index 컬럼 1회 + 매칭 행 1회 + updateCell 1회 = 3회
   ═══════════════════════════════════════════════════════════ */
export async function adminScanQR(env, qrString, pin) {
    const pinResult = adminVerifyPin(env, pin);
    if (pinResult.status !== 'ok') return { status: 'unauthorized', message: pinResult.message };
    if (!qrString) return { status: 'error', message: 'QR 데이터가 없습니다.' };

    const parts  = String(qrString).trim().split(':');
    const qrType = parts[0];
    const qrId   = parts.slice(1).join(':').trim();

    if (qrType === 'NOSUB') return { status: 'found', type: 'NOSUB' };
    if (qrType === 'NOMEM') return { status: 'found', type: 'NOMEM' };
    if (!qrId) return { status: 'notfound', message: '유효하지 않은 QR 코드입니다.' };

    const tk        = await getToken(env);
    const eId       = env.EVENT_SHEET_ID;
    const sheetName = qrType === 'CHECKIN' ? (env.ATTEND_SHEET_NAME || '테스트') : '현장';

    /* 헤더맵 (캐시 우선) */
    const map      = await getHeaderMap(tk, eId, sheetName);
    const indexCol = col(map, ['Index', 'index']);
    const adminCol = col(map, ['어드민확인']);

    if (indexCol == null) return { status: 'error', message: 'Index 컬럼을 찾을 수 없습니다.' };

    /* Index 컬럼 검색 */
    const found = await findRowByIndex(tk, eId, sheetName, indexCol, qrId);
    if (!found) return { status: 'notfound', message: 'QR 정보를 찾을 수 없습니다.\n다시 스캔해 주세요.' };

    const { rowNum, values } = found;

    /* 어드민확인 처리 */
    const adminVal         = adminCol != null ? (values[adminCol] ?? '') : '';
    const alreadyConfirmed = adminVal && String(adminVal).trim() !== '';
    const confirmedAt      = alreadyConfirmed ? String(adminVal).slice(11, 16) : null;

    if (!alreadyConfirmed && adminCol != null) {
        await updateCell(tk, eId, `${sheetName}!${colLetter(adminCol)}${rowNum}`, nowKST());
    }

    /* 각 컬럼 추출 */
    const tsCol     = col(map, ['응답시간']);
    const corpCol   = col(map, ['법인']);
    const ldapCol   = col(map, ['LDAP']);
    const nameCol   = col(map, ['이름']);
    const phoneCol  = col(map, ['전화번호']);
    const lunchCol  = col(map, ['식사여부']);
    const schedCol  = col(map, ['참여일정']);
    const statusCol = qrType === 'CHECKIN'
        ? col(map, ['참여상태'])
        : col(map, ['조합원여부']);

    const tsVal     = tsCol != null ? String(values[tsCol] ?? '') : '';
    const timeStamp = tsVal ? tsVal.slice(11, 16) : '-';

    return {
        status: 'found',
        type:   qrType,
        alreadyConfirmed,
        confirmedAt,
        name:         nameCol  != null ? String(values[nameCol]  ?? '-') : '-',
        corp:         corpCol  != null ? String(values[corpCol]  ?? '-') : '-',
        ldap:         ldapCol  != null ? String(values[ldapCol]  ?? '')  : '',
        phone:        phoneCol != null ? String(values[phoneCol] ?? '-') : '-',
        lunch:        lunchCol != null ? String(values[lunchCol] ?? '-') : '-',
        schedule:     schedCol != null ? (String(values[schedCol] ?? '') || '-') : '-',
        regStatus:    qrType === 'CHECKIN' && statusCol != null ? String(values[statusCol] ?? '-') : undefined,
        memberStatus: qrType === 'ONSITE'  && statusCol != null ? String(values[statusCol] ?? '-') : undefined,
        checkedAt:    qrType === 'CHECKIN' ? timeStamp : undefined,
        registeredAt: qrType === 'ONSITE'  ? timeStamp : undefined,
    };
}
