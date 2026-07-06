/* POST /api/admin
   요청 body: { action, pin, ...params }

   action = "verifyAndConfig" → PIN 확인 + FEATURES 반환 (로그인)
   action = "scanQR"          → QR 스캔 결과 조회 */

import { adminVerifyPin, adminScanQR } from '../_shared/logic.js';
import { FEATURES } from '../_shared/settings.js';

export async function onRequestPost(context) {
    try {
        const body   = await context.request.json();
        const { action, pin } = body;

        let result;

        if (action === 'verifyAndConfig') {
            const verify = adminVerifyPin(context.env, pin);
            if (verify.status !== 'ok') {
                result = verify;
            } else {
                result = {
                    status:         'ok',
                    enableMeal:     FEATURES.enableMeal,
                    mealLabel:      FEATURES.mealLabel,
                    enableSchedule: FEATURES.enableSchedule,
                };
            }

        } else if (action === 'scanQR') {
            result = await adminScanQR(context.env, body.qr, pin);

        } else {
            result = { status: 'error', message: '알 수 없는 요청입니다.' };
        }

        return Response.json(result);
    } catch (e) {
        return Response.json({ status: 'error', message: e.message }, { status: 500 });
    }
}
