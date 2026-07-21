/* 비즈니스 로직
   ─────────────────────────────────────────────────────────
   캐시 전략:
     [응답 시트] → Cloudflare KV (1일 TTL)
       - 행사 전 또는 어드민에서 강제 갱신
       - KV miss 시 Sheets에서 fetch 후 KV에 저장
       - 모듈 메모리에도 이중 보관 (KV 읽기 비용 제거)

     [출석 시트] → 모듈 메모리 Map
       - isolate 첫 요청에 Sheets에서 로드 (batchGet 1회)
       - 이후 체크인할 때마다 메모리에 추가 (API 추가 없음)

   결과:
     신규 체크인: appendRow 1회만 API 호출
     중복 체크인: API 호출 0회 (순수 메모리)
   ─────────────────────────────────────────────────────────*/

import { getAccessToken }                           from './auth.js';
import {
    getHeaderMap, batchGetValues, getValues,
    appendRowByHeader, updateCell, findRowByIndex,
    ensureSheet, colLetter,
}                                                   from './sheets.js';
import {
    FEATURES, attendHeaders, onsiteHeaders,
    normalizePhone, formatPhone, nowKST,
}                                                   from './settings.js';

/* ── 상수 ── */
const KV_RESPONSE_KEY = 'krew_response_data';
const KV_TTL_SEC      = 86400; // 1일

/* ── 출석 모듈 캐시 (phoneNorm → qrId) ───────────────────
   isolate 수명 동안 유지. 새 체크인마다 자동 업데이트.     */
const _attendCache      = new Map();
let   _attendCacheReady = false;

/* ── 응답 모듈 캐시 (KV 읽기 비용 제거용 이중 레이어) ──── */
let _responseModuleCache = null;


/* ═══════════════════════════════════════════════════════════
   내부 헬퍼
   ═══════════════════════════════════════════════════════════ */

async function getToken(env) {
    return getAccessToken(env.SERVICE_ACCOUNT_EMAIL,
        env.SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'));
}

function col(map, candidates) {
    for (const c of candidates) if (map[c] !== undefined) return map[c];
    return null;
}

/** 응답 시트 전체를 가져와 정규화된 객체 배열로 변환 */
async function _fetchAndProcessResponse(tk, env) {
    const eId  = env.EVENT_SHEET_ID;
    const rMap = await getHeaderMap(tk, eId, '응답');

    const rPhoneCol    = col(rMap, ['전화번호']);
    const rCorpCol     = col(rMap, ['법인']);
    const rLdapCol     = col(rMap, ['LDAP']);
    const rNameCol     = col(rMap, ['이름']);
    const rScheduleCol = col(rMap, ['참여일정']);
    const rIndexCol    = col(rMap, ['index', 'Index']);
    const rStatusCol   = col(rMap, ['참여상태']);

    if (rPhoneCol == null || rIndexCol == null) {
        throw new Error('응답 시트 헤더를 확인해 주세요.');
    }

    const rows = await getValues(tk, eId, '응답!A2:Z');

    return rows
        .filter(row => row.length > 0)
        .map(row => ({
            phoneNorm: normalizePhone(String(row[rPhoneCol] || '')),
            corp:      String(row[rCorpCol]     || '').trim(),
            ldap:      rLdapCol     != null ? String(row[rLdapCol]     || '').trim() : '',
            name:      rNameCol     != null ? String(row[rNameCol]     || '').trim() : '',
            index:     String(row[rIndexCol]    || '').trim(),
            schedule:  rScheduleCol != null ? String(row[rScheduleCol] || '').trim() : '',
            regStatus: rStatusCol   != null ? String(row[rStatusCol]   || '').trim() : '',
        }))
        .filter(r => r.phoneNorm && r.corp && r.index);
}

/** 응답 캐시 읽기 (모듈 → KV → Sheets 순서로 fallback) */
async function _getResponseCache(env) {
    // Layer 1: 모듈 메모리 (가장 빠름, 0ms)
    if (_responseModuleCache) return _responseModuleCache;

    // Layer 2: KV (~10ms, isolate 재시작해도 유지)
    if (env.KV_CACHE) {
        const kvData = await env.KV_CACHE.get(KV_RESPONSE_KEY, 'json');
        if (kvData) {
            _responseModuleCache = kvData; // 모듈 캐시에도 저장
            return kvData;
        }
    }

    // Layer 3: Sheets API (캐시 미스 시 1회만 호출)
    const tk   = await getToken(env);
    const data = await _fetchAndProcessResponse(tk, env);
    _responseModuleCache = data;

    if (env.KV_CACHE) {
        await env.KV_CACHE.put(KV_RESPONSE_KEY, JSON.stringify(data),
            { expirationTtl: KV_TTL_SEC });
    }

    return data;
}

/** 출석 캐시 로드 (isolate 첫 checkIn 요청 시 1회만 실행) */
async function _loadAttendCache(tk, env, sheetName, aMap) {
    if (_attendCacheReady) return;

    const aPhoneCol = col(aMap, ['전화번호']);
    const aIndexCol = col(aMap, ['Index', 'index']);

    if (aPhoneCol == null || aIndexCol == null) {
        _attendCacheReady = true;
        return;
    }

    const [phones, indexes] = await batchGetValues(tk, env.EVENT_SHEET_ID, [
        `${sheetName}!${colLetter(aPhoneCol)}2:${colLetter(aPhoneCol)}`,
        `${sheetName}!${colLetter(aIndexCol)}2:${colLetter(aIndexCol)}`,
    ]);

    phones.forEach((row, i) => {
        const p   = normalizePhone(String((row || [])[0] || ''));
        const idx = String((indexes[i] || [])[0] || '');
        if (p && idx) _attendCache.set(p, idx);
    });

    _attendCacheReady = true;
}


/* ═══════════════════════════════════════════════════════════
   캐시 관리 (어드민에서 호출)
   ═══════════════════════════════════════════════════════════ */

/** 응답 캐시 강제 갱신 — 어드민 버튼에서 호출
 Sheets에서 최신 데이터 fetch → KV + 모듈 캐시 갱신
 반환: { count: 캐시된 행 수 } */
export async function preloadResponseCache(env) {
    const tk   = await getToken(env);
    const data = await _fetchAndProcessResponse(tk, env);

    _responseModuleCache = data;

    if (env.KV_CACHE) {
        await env.KV_CACHE.put(KV_RESPONSE_KEY, JSON.stringify(data),
            { expirationTtl: KV_TTL_SEC });
    }

    return { status: 'ok', count: data.length };
}

/** 캐시 전체 초기화 (강제 갱신 전 단계) */
export async function invalidateCache(env) {
    _responseModuleCache = null;
    _attendCacheReady    = false;
    _attendCache.clear();

    if (env.KV_CACHE) {
        await env.KV_CACHE.delete(KV_RESPONSE_KEY);
    }

    return { status: 'ok' };
}

/** 캐시 상태 조회 (어드민 UI 표시용) */
export async function getCacheStatus(env) {
    let kvStatus = 'KV 미설정';
    let kvCount  = 0;

    if (env.KV_CACHE) {
        const kvData = await env.KV_CACHE.get(KV_RESPONSE_KEY, 'json');
        kvStatus = kvData ? '캐시됨' : '미캐시';
        kvCount  = kvData ? kvData.length : 0;
    }

    return {
        status:         'ok',
        responseCache:  _responseModuleCache ? '모듈 캐시 있음' : '없음',
        responseCount:  _responseModuleCache ? _responseModuleCache.length : 0,
        kvStatus,
        kvCount,
        attendCacheReady:  _attendCacheReady,
        attendCacheCount:  _attendCache.size,
    };
}


/* ═══════════════════════════════════════════════════════════
   참석확인 (checkIn)

   핫패스 API 호출 횟수 (완전 워밍업 후):
     신규:   1회 (appendRow)
     중복:   0회 (순수 메모리)
   ═══════════════════════════════════════════════════════════ */
export async function checkIn(env, corp, phone, lunch) {
    lunch = FEATURES.enableMeal ? lunch : '';

    const phoneNorm = normalizePhone(phone);
    const phoneFmt  = formatPhone(phone);
    const sheetName = env.ATTEND_SHEET_NAME || '테스트';

    /* ① 출석 캐시 + 응답 캐시 병렬 준비
          (두 작업이 독립적이므로 Promise.all로 동시 실행) */
    const tk = await getToken(env);

    await ensureSheet(tk, env.EVENT_SHEET_ID, sheetName, attendHeaders());
    const aMap = await getHeaderMap(tk, env.EVENT_SHEET_ID, sheetName);

    const [responseData] = await Promise.all([
        _getResponseCache(env),                        // 응답 캐시 (KV or 모듈)
        _loadAttendCache(tk, env, sheetName, aMap),    // 출석 캐시 (첫 요청만 API)
    ]);

    /* ② 중복 체크 (순수 메모리, API 없음) */
    if (_attendCache.has(phoneNorm)) {
        return {
            status: 'ok', qrType: 'CHECKIN', isDuplicate: true,
            qrId: _attendCache.get(phoneNorm),
        };
    }

    /* ③ 사전신청 매칭 (순수 메모리, API 없음) */
    const matched = responseData.find(r =>
        r.phoneNorm === phoneNorm && r.corp === corp
    );

    if (!matched) return { status: 'ok', qrType: 'NOSUB', qrId: 'KU-NOSUB' };

    /* ④ 출석 저장 (1회 API 호출, 불가피) */
    await appendRowByHeader(tk, env.EVENT_SHEET_ID, sheetName, {
        '응답시간': nowKST(),
        '법인':     corp,
        'LDAP':     matched.ldap,
        '이름':     matched.name,
        '전화번호': phoneFmt,
        '식사여부': lunch,
        '참여일정': FEATURES.enableSchedule ? matched.schedule : '',
        '참여상태': matched.regStatus,
        'Index':    matched.index,
        '어드민확인': '',
    }, aMap);

    /* ⑤ 출석 캐시 업데이트 (메모리만, 이후 중복 체크 즉시 처리) */
    _attendCache.set(phoneNorm, matched.index);

    return { status: 'ok', qrType: 'CHECKIN', qrId: matched.index, isDuplicate: false };
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

    const phoneNorm = normalizePhone(phone);
    const phoneFmt  = formatPhone(phone);
    const sheetName = env.ATTEND_SHEET_NAME || '테스트';
    const tk        = await getToken(env);
    const eId       = env.EVENT_SHEET_ID;

    /* ① 응답 캐시에서 사전신청자 확인 */
    const responseData = await _getResponseCache(env);
    const preMatch     = responseData.find(r => r.phoneNorm === phoneNorm);

    if (preMatch) {
        /* 사전신청자 → 출석 처리 */
        await ensureSheet(tk, eId, sheetName, attendHeaders());
        const aMap      = await getHeaderMap(tk, eId, sheetName);
        const aPhoneCol = col(aMap, ['전화번호']);
        const aIndexCol = col(aMap, ['Index', 'index']);

        /* 출석 캐시에서 중복 확인 */
        await _loadAttendCache(tk, env, sheetName, aMap);

        if (_attendCache.has(phoneNorm)) {
            return {
                status: 'ok', qrType: 'CHECKIN', isDuplicate: true,
                qrId: _attendCache.get(phoneNorm),
            };
        }

        await appendRowByHeader(tk, eId, sheetName, {
            '응답시간': nowKST(),
            '법인':     preMatch.corp,
            'LDAP':     preMatch.ldap,
            '이름':     preMatch.name,
            '전화번호': phoneFmt,
            '식사여부': lunch,
            '참여일정': FEATURES.enableSchedule ? preMatch.schedule : '',
            '참여상태': preMatch.regStatus,
            'Index':    preMatch.index,
            '어드민확인': '',
        }, aMap);

        _attendCache.set(phoneNorm, preMatch.index);
        return { status: 'ok', qrType: 'CHECKIN', qrId: preMatch.index, isDuplicate: false };
    }

    /* ② 현장 시트 중복 확인 */
    await ensureSheet(tk, eId, '현장', onsiteHeaders());
    const oMap      = await getHeaderMap(tk, eId, '현장');
    const oPhoneCol = col(oMap, ['전화번호']);
    const oIndexCol = col(oMap, ['Index', 'index']);

    /* 현장 전화번호 컬럼 스캔 (1회 API) */
    const oPhones = oPhoneCol != null
        ? await getValues(tk, eId, `현장!${colLetter(oPhoneCol)}2:${colLetter(oPhoneCol)}`)
        : [];

    for (let i = 0; i < oPhones.length; i++) {
        if (normalizePhone(String((oPhones[i] || [])[0] || '')) === phoneNorm) {
            /* 중복 — 해당 행의 Index만 추가 조회 */
            const idxRow = await getValues(tk, eId,
                `현장!${colLetter(oIndexCol)}${i + 2}:${colLetter(oIndexCol)}${i + 2}`);
            return {
                status: 'ok', qrType: 'ONSITE',
                qrId: String((idxRow[0] || [])[0] || ''),
            };
        }
    }

    /* ③ 조합원 확인 */
    let memberStatus = '비조합원';
    let krewId       = null;
    try {
        const kMap      = await getHeaderMap(tk, env.KREW_SHEET_ID, '크루유니언');
        const kIdCol    = col(kMap, ['krewunionId', 'KrewunionId', 'Index', 'index']) ?? 0;
        const kCorpCol  = col(kMap, ['법인'])              ?? 1;
        const kNameCol  = col(kMap, ['한글명', '이름'])     ?? 2;
        const kLdapCol  = col(kMap, ['영문명', 'LDAP'])     ?? 3;
        const kPhoneCol = col(kMap, ['연락처', '전화번호']) ?? 4;

        const kPhones = await getValues(tk, env.KREW_SHEET_ID,
            `크루유니언!${colLetter(kPhoneCol)}2:${colLetter(kPhoneCol)}`);

        for (let i = 0; i < kPhones.length; i++) {
            if (normalizePhone(String((kPhones[i] || [])[0] || '')) === phoneNorm) {
                const rowNum = i + 2;
                const row    = (await getValues(tk, env.KREW_SHEET_ID,
                    `크루유니언!A${rowNum}:Z${rowNum}`))[0] || [];

                const baseMatch = String(row[kCorpCol] || '').trim() === corp
                    && String(row[kNameCol] || '').trim() === name;
                const ldapMatch = ldap ? String(row[kLdapCol] || '').trim() === ldap : true;

                if (baseMatch && ldapMatch) {
                    memberStatus = '조합원';
                    krewId       = String(row[kIdCol] || '').trim();
                    break;
                }
            }
        }
    } catch { memberStatus = '조합원DB조회실패'; }

    /* ④ 비조합원 */
    if (!krewId) {
        await appendRowByHeader(tk, eId, '현장', {
            '응답시간': nowKST(), '법인': corp, 'LDAP': ldap, '이름': name,
            '전화번호': phoneFmt, '식사여부': lunch, '참여일정': schedule,
            '조합원여부': memberStatus, 'Index': 'KU-NOMEM', '어드민확인': '',
        }, oMap);
        return { status: 'ok', qrType: 'NOMEM', qrId: 'KU-NOMEM' };
    }

    /* ⑤ 조합원 */
    await appendRowByHeader(tk, eId, '현장', {
        '응답시간': nowKST(), '법인': corp, 'LDAP': ldap, '이름': name,
        '전화번호': phoneFmt, '식사여부': lunch, '참여일정': schedule,
        '조합원여부': memberStatus, 'Index': krewId, '어드민확인': '',
    }, oMap);
    return { status: 'ok', qrType: 'ONSITE', qrId: krewId };
}


/* ═══════════════════════════════════════════════════════════
   어드민
   ═══════════════════════════════════════════════════════════ */
export function adminVerifyPin(env, pin) {
    const correct = env.ADMIN_PIN;
    if (!correct) return { status: 'error',  message: 'ADMIN_PIN 환경변수가 설정되지 않았습니다.' };
    if (String(pin).trim() !== String(correct).trim()) return { status: 'wrong', message: 'PIN이 올바르지 않습니다.' };
    return { status: 'ok' };
}

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

    const adminVal         = adminCol != null ? (values[adminCol] ?? '') : '';
    const alreadyConfirmed = adminVal && String(adminVal).trim() !== '';
    const confirmedAt      = alreadyConfirmed ? String(adminVal).slice(11, 16) : null;

    if (!alreadyConfirmed && adminCol != null) {
        await updateCell(tk, eId, `${sheetName}!${colLetter(adminCol)}${rowNum}`, nowKST());
    }

    const tsCol     = col(map, ['응답시간']);
    const corpCol   = col(map, ['법인']);
    const ldapCol   = col(map, ['LDAP']);
    const nameCol   = col(map, ['이름']);
    const phoneCol  = col(map, ['전화번호']);
    const lunchCol  = col(map, ['식사여부']);
    const schedCol  = col(map, ['참여일정']);
    const statusCol = qrType === 'CHECKIN' ? col(map, ['참여상태']) : col(map, ['조합원여부']);

    const tsVal     = tsCol != null ? String(values[tsCol] ?? '') : '';
    const timeStamp = tsVal ? tsVal.slice(11, 16) : '-';

    return {
        status: 'found', type: qrType, alreadyConfirmed, confirmedAt,
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
