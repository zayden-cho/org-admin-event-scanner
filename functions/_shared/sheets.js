/* Google Sheets REST API 래퍼 + 로컬 캐시
   ─────────────────────────────────────────────────────────
   캐시 전략:
     - _headerCache   : 헤더맵을 모듈 수준에서 영구 캐시
                        시트 구조는 행사 중 바뀌지 않으므로 TTL 없음
     - _sheetReady    : ensureSheet 완료 여부 캐시 (매 요청마다 중복 조회 방지)
     - access token   : auth.js 모듈 캐시 (58분 TTL)
   ─────────────────────────────────────────────────────────*/

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/* ── 모듈 캐시 ── */
const _headerCache = new Map();   // key: `${sheetId}::${sheetName}`
const _sheetReady  = new Set();   // key: `${sheetId}::${sheetName}`

async function req(token, url, opts = {}) {
    const res = await fetch(url, {
        ...opts,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(opts.headers || {}),
        },
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Sheets API ${res.status}: ${err}`);
    }
    return res.json();
}

/* ── 기본 CRUD ─────────────────────────────────────────── */

/** 범위 값 가져오기 */
export async function getValues(token, sheetId, range) {
    const url  = `${BASE}/${sheetId}/values/${encodeURIComponent(range)}`;
    const data = await req(token, url);
    return data.values || [];
}

/** 행 추가 (RAW: 날짜 시리얼 변환 방지) */
export async function appendRow(token, sheetId, sheetName, values) {
    const url = `${BASE}/${sheetId}/values/${encodeURIComponent(sheetName + '!A1')}:append`
        + `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    return req(token, url, { method: 'POST', body: JSON.stringify({ values: [values] }) });
}

/** 여러 범위를 한 번에 가져오기 (순차 API 호출 → 1회로 통합)
 ranges: ['Sheet1!A2:A', 'Sheet2!B2:Z'] 형식
 반환: 각 범위의 values 배열 (ranges 순서와 동일) */
export async function batchGetValues(token, sheetId, ranges) {
    const params = ranges.map(r => `ranges=${encodeURIComponent(r)}`).join('&');
    const url    = `${BASE}/${sheetId}/values:batchGet?${params}`;
    const data   = await req(token, url);
    return (data.valueRanges || []).map(vr => vr.values || []);
}

/** 단일 셀 업데이트 (RAW) */
export async function updateCell(token, sheetId, range, value) {
    const url = `${BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
    return req(token, url, { method: 'PUT', body: JSON.stringify({ values: [[value]] }) });
}

/* ── 헤더 맵 (캐시 우선) ────────────────────────────────── */

/** 헤더 이름 → 0-based 인덱스 맵 (캐시) */
export async function getHeaderMap(token, sheetId, sheetName) {
    const key = `${sheetId}::${sheetName}`;
    if (_headerCache.has(key)) return _headerCache.get(key);

    const rows = await getValues(token, sheetId, `${sheetName}!1:1`);
    const map  = {};
    if (rows[0]) rows[0].forEach((h, i) => {
        const k = String(h).trim();
        if (k) map[k] = i;
    });
    _headerCache.set(key, map);
    return map;
}

/* ── 유틸 ─────────────────────────────────────────────── */

/** 0-based 인덱스 → 컬럼 문자 (0→A, 25→Z, 26→AA …) */
export function colLetter(idx) {
    let col = '', n = idx + 1;
    while (n > 0) {
        const r = (n - 1) % 26;
        col = String.fromCharCode(65 + r) + col;
        n   = Math.floor((n - 1) / 26);
    }
    return col;
}

/* ── 검색 ──────────────────────────────────────────────── */

/** 전화번호 컬럼만 읽어 매칭 행 반환 (최적화)
 - _getLastRow 호출 없이 오픈형 범위로 전체 컬럼 읽기
 - 매칭 시 해당 행만 추가 1회 조회
 - extraCheck(rowValues): 법인 등 추가 조건 */
export async function findRowByPhone(token, sheetId, sheetName, phoneColIdx, phoneNorm, extraCheck) {
    if (phoneColIdx == null) return null;

    const col    = colLetter(phoneColIdx);
    /* 오픈형 범위 → _getLastRow API 호출 불필요 */
    const phones = await getValues(token, sheetId, `${sheetName}!${col}2:${col}`);

    for (let i = 0; i < phones.length; i++) {
        const cell = String((phones[i] || [])[0] || '').replace(/[^0-9]/g, '');
        if (cell === phoneNorm) {
            const rowNum    = i + 2;
            const rowValues = (await getValues(token, sheetId, `${sheetName}!A${rowNum}:Z${rowNum}`))[0] || [];
            if (!extraCheck || extraCheck(rowValues)) return { rowNum, values: rowValues };
            /* 전화번호 일치 but 추가 조건 불일치 → 계속 */
        }
    }
    return null;
}

/** Index 컬럼에서 qrId 검색 (오픈형 범위) */
export async function findRowByIndex(token, sheetId, sheetName, indexColIdx, qrId) {
    if (indexColIdx == null) return null;

    const col  = colLetter(indexColIdx);
    const vals = await getValues(token, sheetId, `${sheetName}!${col}2:${col}`);

    for (let i = 0; i < vals.length; i++) {
        if (String((vals[i] || [])[0] || '').trim() === qrId) {
            const rowNum    = i + 2;
            const rowValues = (await getValues(token, sheetId, `${sheetName}!A${rowNum}:Z${rowNum}`))[0] || [];
            return { rowNum, values: rowValues };
        }
    }
    return null;
}

/* ── 행 추가 (헤더 기반) ───────────────────────────────── */

/** 헤더 이름 기준으로 행 추가
 preloadedMap: 이미 가져온 헤더맵 → getHeaderMap 재호출 방지 */
export async function appendRowByHeader(token, sheetId, sheetName, valuesByHeader, preloadedMap) {
    const map    = preloadedMap || await getHeaderMap(token, sheetId, sheetName);
    const maxCol = Object.keys(map).length || 10;
    const row    = new Array(maxCol).fill('');
    Object.entries(valuesByHeader).forEach(([k, v]) => {
        if (map[k] !== undefined) row[map[k]] = v ?? '';
    });
    await appendRow(token, sheetId, sheetName, row);
}

/* ── 시트 초기화 (캐시, 최초 1회만 실행) ──────────────── */

/** 시트 없으면 생성+헤더 추가, 있으면 헤더 캐시만 적재
 같은 isolate 수명 동안 두 번 다시 실행하지 않음 */
export async function ensureSheet(token, sheetId, sheetName, headers) {
    const key = `${sheetId}::${sheetName}`;
    if (_sheetReady.has(key)) return;

    try {
        const rows = await getValues(token, sheetId, `${sheetName}!1:1`);
        if (!rows[0] || !rows[0].some(v => String(v).trim())) {
            await appendRow(token, sheetId, sheetName, headers);
            /* 방금 만든 헤더로 캐시 적재 */
            const map = {};
            headers.forEach((h, i) => { const k = String(h).trim(); if (k) map[k] = i; });
            _headerCache.set(key, map);
        } else {
            /* 기존 헤더로 캐시 적재 */
            const map = {};
            rows[0].forEach((h, i) => { const k = String(h).trim(); if (k) map[k] = i; });
            _headerCache.set(key, map);
        }
    } catch {
        /* 시트 없음 → 생성 */
        await req(token, `${BASE}/${sheetId}:batchUpdate`, {
            method: 'POST',
            body:   JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] }),
        });
        await appendRow(token, sheetId, sheetName, headers);
        const map = {};
        headers.forEach((h, i) => { const k = String(h).trim(); if (k) map[k] = i; });
        _headerCache.set(key, map);
    }

    _sheetReady.add(key);
}
