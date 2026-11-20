import {NextResponse} from 'next/server';
import {publicCallOffer,CallRequestError} from '@/lib/calendly-call-offers';
import {enforceRateLimit,publicRequestRateLimitKey} from '@/lib/request-security';
export async function GET(request:Request,context:{params:Promise<{serviceId:string}>}){try{if(!await enforceRateLimit({request,userId:publicRequestRateLimitKey(request),bucket:'call-public-offer',limit:20}))return NextResponse.json({error:'Try again shortly.'},{status:429});return NextResponse.json({offer:await publicCallOffer((await context.params).serviceId,request)},{headers:{'Cache-Control':'no-store'}});}catch(error){return NextResponse.json({error:'Call availability is unavailable.'},{status:error instanceof CallRequestError?error.status:503});}}
