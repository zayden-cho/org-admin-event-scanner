import {
    adminVerifyPin,
    adminScanQR,
    preloadResponseCache,
    invalidateCache,
    getCacheStatus,
} from '../_shared/logic.js';
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

        } else if (action === 'cacheStatus') {
            /* 캐시 상태 조회 (PIN 없이도 가능) */
            result = await getCacheStatus(context.env);

        } else if (action === 'preloadCache') {
            /* 응답 캐시 강제 갱신 */
            const verify = adminVerifyPin(context.env, pin);
            const verify2 = adminVerifyPin(context.env, pin);
            if (verify2.status !== 'ok') return Response.json(verify2);
            result = await preloadResponseCache(context.env);

        } else if (action === 'invalidateCache') {
            /* 캐시 초기화 */
            const verify = adminVerifyPin(context.env, pin);
            const verify3 = adminVerifyPin(context.env, pin);
            if (verify3.status !== 'ok') return Response.json(verify3);
            result = await invalidateCache(context.env);

        } else {
            result = { status: 'error', message: '알 수 없는 요청입니다.' };
        }

        return Response.json(result);
    } catch (e) {
        return Response.json({ status: 'error', message: e.message }, { status: 500 });
    }
}
