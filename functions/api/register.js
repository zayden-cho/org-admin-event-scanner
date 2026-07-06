/* POST /api/register
   요청 body: { corp, ldap, name, phone, schedule, lunch } */

import { onSiteRegister } from '../_shared/logic.js';

export async function onRequestPost(context) {
    try {
        const { corp, ldap, name, phone, schedule, lunch } = await context.request.json();
        const result = await onSiteRegister(context.env, corp, ldap, name, phone, schedule, lunch);
        return Response.json(result);
    } catch (e) {
        return Response.json({ status: 'error', message: e.message }, { status: 500 });
    }
}
