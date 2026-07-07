/* 비즈니스 로직 — GAS Code.gs 변환본
   SpreadsheetApp → Sheets REST API
   PropertiesService → Cloudflare env 변수 */

import { getAccessToken } from './auth.js';
import {
    getHeaderMap, findRowByPhone, findRowByIndex,
    appendRowByHeader, updateCell, ensureSheet, colLetter,
} from './sheets.js';
import {
    FEATURES, attendHeaders, onsiteHeaders,
    normalizePhone, formatPhone, nowKST,
} from './settings.js';

/* ── 토큰 취득 헬퍼 ── */
async function getToken(env) {
    const key = env.SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n');
    return getAccessToken(env.SERVICE_ACCOUNT_EMAIL, key);
}

/* ── 헤더맵에서 후보 컬럼 찾기 ── */
function col(map, candidates) {
    for (const c of candidates) if (map[c] !== undefined) return map[c];
    return null;
}


/* ═══════════════════════════════════════════════════════════
   참석확인 (checkIn)
   ═══════════════════════════════════════════════════════════ */
export async function checkIn(env, corp, phone, lunch) {
    lunch = FEATURES.enableMeal ? lunch : '';

    const tk        = await getToken(env);
    const phoneNorm = normalizePhone(phone);
    const phoneFmt  = formatPhone(phone);
    const eId       = env.EVENT_SHEET_ID;
    const sheetName = env.ATTEND_SHEET_NAME || '테스트';

    // 출석 시트 헤더 확인 (없으면 생성)
    await ensureSheet(tk, eId, sheetName, attendHeaders());
    const aMap      = await getHeaderMap(tk, eId, sheetName);
    const aPhoneCol = col(aMap, ['전화번호']);
    const aIndexCol = col(aMap, ['Index', 'index']);

    // ① 중복 체크인 → 기존 Index 반환
    const existing = await findRowByPhone(tk, eId, sheetName, aPhoneCol, phoneNorm);
    if (existing) {
        return { status: 'ok', qrType: 'CHECKIN', qrId: String(existing.values[aIndexCol] ?? ''), isDuplicate: true };
    }

    // ② 사전신청 매칭 (전화번호 + 법인)
    const rMap         = await getHeaderMap(tk, eId, '응답');
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

    const found = await findRowByPhone(tk, eId, '응답', rPhoneCol, phoneNorm,
        row => String(row[rCorpCol] ?? '').trim() === corp
    );

    // ③ 미매칭 → NOSUB (사전신청 없음)
    if (!found) return { status: 'ok', qrType: 'NOSUB', qrId: 'KU-NOSUB' };

    // ④ 출석 저장
    const r        = found.values;
    const index    = String(r[rIndexCol] ?? '').trim();
    const schedule = (FEATURES.enableSchedule && rScheduleCol != null)
        ? String(r[rScheduleCol] ?? '').trim() : '';

    await appendRowByHeader(tk, eId, sheetName, {
        '응답시간': nowKST(),
        '법인':     corp,
        'LDAP':     rLdapCol  != null ? String(r[rLdapCol]  ?? '').trim() : '',
        '이름':     rNameCol  != null ? String(r[rNameCol]  ?? '').trim() : '',
        '전화번호': phoneFmt,
        '식사여부': lunch,
        '참여일정': schedule,
        '참여상태': rStatusCol != null ? String(r[rStatusCol] ?? '').trim() : '',
        'Index':    index,
        '어드민확인': '',
    });

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

    // ① 사전신청자 → 출석 처리 후 CHECKIN QR 반환
    const rMap = await getHeaderMap(tk, eId, '응답');
    const rPhoneCol    = col(rMap, ['전화번호']);
    const rCorpCol     = col(rMap, ['법인']);
    const rLdapCol     = col(rMap, ['LDAP']);
    const rNameCol     = col(rMap, ['이름']);
    const rScheduleCol = col(rMap, ['참여일정']);
    const rIndexCol    = col(rMap, ['index', 'Index']);
    const rStatusCol   = col(rMap, ['참여상태']);

    if (rPhoneCol != null) {
        const preMatch = await findRowByPhone(tk, eId, '응답', rPhoneCol, phoneNorm);
        if (preMatch) {
            // 이미 출석 처리됐는지 확인
            await ensureSheet(tk, eId, sheetName, attendHeaders());
            const aMap      = await getHeaderMap(tk, eId, sheetName);
            const aPhoneCol = col(aMap, ['전화번호']);
            const aIndexCol = col(aMap, ['Index', 'index']);

            const already = await findRowByPhone(tk, eId, sheetName, aPhoneCol, phoneNorm);
            if (already) {
                return { status: 'ok', qrType: 'CHECKIN', qrId: String(already.values[aIndexCol] ?? ''), isDuplicate: true };
            }

            // 출석 미처리 → 저장 후 반환
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
            });
            return { status: 'ok', qrType: 'CHECKIN', qrId: rIndex, isDuplicate: false };
        }
    }

    // ② 현장신청 중복 확인
    await ensureSheet(tk, eId, '현장', onsiteHeaders());
    const oMap      = await getHeaderMap(tk, eId, '현장');
    const oPhoneCol = col(oMap, ['전화번호']);
    const oIndexCol = col(oMap, ['Index', 'index']);

    const dup = await findRowByPhone(tk, eId, '현장', oPhoneCol, phoneNorm);
    if (dup) {
        return { status: 'ok', qrType: 'ONSITE', qrId: String(dup.values[oIndexCol] ?? '') };
    }

    // ③ 조합원 여부 확인 (전화번호 컬럼만 스캔)
    let memberStatus = '비조합원';
    let krewId       = null;
    try {
        const kMap      = await getHeaderMap(tk, env.KREW_SHEET_ID, '크루유니언');
        const kIdCol    = col(kMap, ['krewunionId', 'KrewunionId', 'Index', 'index']) ?? 0;
        const kCorpCol  = col(kMap, ['법인'])               ?? 1;
        const kNameCol  = col(kMap, ['한글명', '이름'])      ?? 2;
        const kLdapCol  = col(kMap, ['영문명', 'LDAP'])      ?? 3;
        const kPhoneCol = col(kMap, ['연락처', '전화번호'])  ?? 4;

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

    // ④ 비조합원 → NOMEM QR
    if (!krewId) {
        await appendRowByHeader(tk, eId, '현장', {
            '응답시간': nowKST(), '법인': corp, 'LDAP': ldap, '이름': name,
            '전화번호': phoneFmt, '식사여부': lunch, '참여일정': schedule,
            '조합원여부': memberStatus, 'Index': 'KU-NOMEM', '어드민확인': '',
        });
        return { status: 'ok', qrType: 'NOMEM', qrId: 'KU-NOMEM' };
    }

    // ⑤ 조합원 → ONSITE QR
    await appendRowByHeader(tk, eId, '현장', {
        '응답시간': nowKST(), '법인': corp, 'LDAP': ldap, '이름': name,
        '전화번호': phoneFmt, '식사여부': lunch, '참여일정': schedule,
        '조합원여부': memberStatus, 'Index': krewId, '어드민확인': '',
    });
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

    const map      = await getHeaderMap(tk, eId, sheetName);
    const indexCol = col(map, ['Index', 'index']);
    const adminCol = col(map, ['어드민확인']);

    if (indexCol == null) return { status: 'error', message: 'Index 컬럼을 찾을 수 없습니다.' };

    const found = await findRowByIndex(tk, eId, sheetName, indexCol, qrId);
    if (!found) return { status: 'notfound', message: 'QR 정보를 찾을 수 없습니다.\n다시 스캔해 주세요.' };

    const { rowNum, values } = found;

    // 어드민확인 컬럼 처리
    const adminVal         = adminCol != null ? (values[adminCol] ?? '') : '';
    const alreadyConfirmed = adminVal && String(adminVal).trim() !== '';
    const confirmedAt      = alreadyConfirmed ? String(adminVal).slice(11, 16) : null;

    if (!alreadyConfirmed && adminCol != null) {
        await updateCell(tk, eId, `${sheetName}!${colLetter(adminCol)}${rowNum}`, nowKST());
    }

    // 각 컬럼 추출
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
