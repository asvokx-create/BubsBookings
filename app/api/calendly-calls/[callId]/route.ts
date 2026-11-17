import {callRoute,callBody} from '@/lib/calendly-call-route';
import {updateCallRequest} from '@/lib/calendly-call-requests';
import {reconcileCallRuntime} from '@/lib/calendly-call-runtime';
export async function PATCH(request:Request,context:{params:Promise<{callId:string}>}){const {callId}=await context.params;return callRoute(request,true,async user=>{await updateCallRequest(user.id,callId,await callBody(request));await reconcileCallRuntime(callId);return {accepted:true};},true);}
