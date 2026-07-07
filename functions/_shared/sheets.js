/* Google Sheets REST API 래퍼
   GAS의 SpreadsheetApp 대체 — fetch 기반, npm 불필요 */

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

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

/** 범위 값 가져오기 */
export async function getValues(token, sheetId, range) {
    const url  = `${BASE}/${sheetId}/values/${encodeURIComponent(range)}`;
    const data = await req(token, url);
    return data.values || [];
}

/** 행 추가 */
export async function appendRow(token, sheetId, sheetName, values) {
    const url = `${BASE}/${sheetId}/values/${encodeURIComponent(sheetName + '!A1')}:append`
        + `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    return req(token, url, { method: 'POST', body: JSON.stringify({ values: [values] }) });
}

/** 단일 셀 업데이트 */
export async function updateCell(token, sheetId, range, value) {
    const url = `${BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
    return req(token, url, { method: 'PUT', body: JSON.stringify({ values: [[value]] }) });
}

/** 헤더 이름 → 0-based 컬럼 인덱스 맵 반환
 예) { "법인": 1, "전화번호": 4, "Index": 8 } */
export async function getHeaderMap(token, sheetId, sheetName) {
    const rows = await getValues(token, sheetId, `${sheetName}!1:1`);
    const map  = {};
    if (rows[0]) rows[0].forEach((h, i) => {
        const k = String(h).trim();
        if (k) map[k] = i;
    });
    return map;
}

/** 0-based 인덱스 → 컬럼 문자 변환 (0→A, 1→B, 26→AA ...) */
export function colLetter(idx) {
    let col = '', n = idx + 1;
    while (n > 0) {
        const r = (n - 1) % 26;
        col = String.fromCharCode(65 + r) + col;
        n   = Math.floor((n - 1) / 26);
    }
    return col;
}

/** 전화번호 컬럼만 가볍게 읽어서 일치하는 행 반환 (최적화)
 extraCheck(rowValues) 로 법인 등 추가 조건 검사 가능 */
export async function findRowByPhone(token, sheetId, sheetName, phoneColIdx, phoneNorm, extraCheck) {
    const lastRow = await _getLastRow(token, sheetId, sheetName);
    if (lastRow < 2) return null;

    const col    = colLetter(phoneColIdx);
    const phones = await getValues(token, sheetId, `${sheetName}!${col}2:${col}${lastRow}`);

    for (let i = 0; i < phones.length; i++) {
        const cell = String((phones[i] || [])[0] || '').replace(/[^0-9]/g, '');
        if (cell === phoneNorm) {
            const rowNum    = i + 2;
            const rowValues = (await getValues(token, sheetId, `${sheetName}!A${rowNum}:Z${rowNum}`))[0] || [];
            if (!extraCheck || extraCheck(rowValues)) return { rowNum, values: rowValues };
            // 전화번호 일치 but 추가조건 불일치 → 계속 검색
        }
    }
    return null;
}

/** Index 컬럼에서 qrId 검색 (GAS TextFinder 대체) */
export async function findRowByIndex(token, sheetId, sheetName, indexColIdx, qrId) {
    const lastRow = await _getLastRow(token, sheetId, sheetName);
    if (lastRow < 2) return null;

    const col  = colLetter(indexColIdx);
    const vals = await getValues(token, sheetId, `${sheetName}!${col}2:${col}${lastRow}`);

    for (let i = 0; i < vals.length; i++) {
        if (String((vals[i] || [])[0] || '').trim() === qrId) {
            const rowNum    = i + 2;
            const rowValues = (await getValues(token, sheetId, `${sheetName}!A${rowNum}:Z${rowNum}`))[0] || [];
            return { rowNum, values: rowValues };
        }
    }
    return null;
}

/** 헤더 이름 기준으로 행 추가 (컬럼 순서 무관) */
export async function appendRowByHeader(token, sheetId, sheetName, valuesByHeader) {
    const map    = await getHeaderMap(token, sheetId, sheetName);
    const maxCol = Object.keys(map).length || 10;
    const row    = new Array(maxCol).fill('');
    Object.entries(valuesByHeader).forEach(([k, v]) => {
        if (map[k] !== undefined) row[map[k]] = v ?? '';
    });
    await appendRow(token, sheetId, sheetName, row);
}

/** 시트가 없으면 생성 후 헤더 추가 */
export async function ensureSheet(token, sheetId, sheetName, headers) {
    try {
        const rows = await getValues(token, sheetId, `${sheetName}!1:1`);
        if (!rows[0] || !rows[0].some(v => String(v).trim())) {
            await appendRow(token, sheetId, sheetName, headers);
        }
    } catch {
        await req(token, `${BASE}/${sheetId}:batchUpdate`, {
            method: 'POST',
            body:   JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] }),
        });
        await appendRow(token, sheetId, sheetName, headers);
    }
}

async function _getLastRow(token, sheetId, sheetName) {
    const url  = `${BASE}/${sheetId}/values/${encodeURIComponent(sheetName + '!A:A')}`;
    const data = await req(token, url);
    return (data.values || []).length;
}
