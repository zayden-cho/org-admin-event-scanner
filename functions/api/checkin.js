/* POST /api/checkin
   요청 body: { corp, phone, lunch } */

import { checkIn } from '../_shared/logic.js';

export async function onRequestPost(context) {
    try {
        const { corp, phone, lunch } = await context.request.json();
        const result = await checkIn(context.env, corp, phone, lunch);
        return Response.json(result);
    } catch (e) {
        return Response.json({ status: 'error', message: e.message }, { status: 500 });
    }
}
