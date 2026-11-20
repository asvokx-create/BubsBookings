import {callRoute,callBody} from '@/lib/calendly-call-route';
import {createCallRequest,listCalls} from '@/lib/calendly-call-requests';
export function GET(request:Request){return callRoute(request,false,async user=>({calls:await listCalls(user.id)}),true);}
export function POST(request:Request){return callRoute(request,true,async user=>({call:await createCallRequest(user,await callBody(request),request)}));}
