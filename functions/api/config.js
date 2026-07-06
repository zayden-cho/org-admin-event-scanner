/* GET /api/config
   브라우저가 페이지 로드 시 호출 → FEATURES, 법인 목록 등 반환 */

import { FEATURES, SCHEDULE_OPTIONS, CORPS } from '../_shared/settings.js';

export async function onRequest(context) {
    const { env } = context;
    return Response.json({
        eventTitle:      env.EVENT_TITLE || '행사',
        corps:           CORPS,
        onSiteOpen:      env.ONSITE_BLOCK !== 'true',
        enableMeal:      FEATURES.enableMeal,
        mealLabel:       FEATURES.mealLabel,
        enableSchedule:  FEATURES.enableSchedule,
        scheduleOptions: FEATURES.enableSchedule ? SCHEDULE_OPTIONS : null,
    });
}
