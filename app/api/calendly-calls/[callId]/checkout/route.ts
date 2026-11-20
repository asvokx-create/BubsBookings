import {callRoute,callBody} from '@/lib/calendly-call-route';
import {CallRequestError} from '@/lib/calendly-call-offers';
import {startCallCheckoutRuntime} from '@/lib/calendly-call-runtime';
export async function POST(request:Request,context:{params:Promise<{callId:string}>}){const {callId}=await context.params;return callRoute(request,true,async user=>{const body=await callBody(request);if(body.authorizeHold!==true||!Number.isSafeInteger(body.version))throw new CallRequestError('Review and authorize the temporary card hold.',400);return startCallCheckoutRuntime(callId,user,new URL(request.url).origin,body.version as number);});}
