import {CallCancellationError} from '@/lib/calendly-call-cancellation';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { hasConfirmedAge } from '@/lib/account-age';
import { hasTrustedRequestOrigin } from '@/lib/request-origin';
import { enforceRateLimit } from '@/lib/request-security';
import { CallRequestError,requireCallsEnabled,requireExistingCallsEnabled } from '@/lib/calendly-call-offers';
export async function callRoute(request:Request,mutating:boolean,action:(user:{id:string;email:string;name?:string})=>Promise<unknown>,existing=false){try{if(existing)requireExistingCallsEnabled();else requireCallsEnabled();const session=await auth.api.getSession({headers:await headers()});if(!session)throw new CallRequestError('Sign in to continue.',401);if(!await hasConfirmedAge(session.user.id))throw new CallRequestError('Confirm your age to continue.',403);if(mutating&&!hasTrustedRequestOrigin(request))throw new CallRequestError('Untrusted request origin.',403);if(!await enforceRateLimit({request,userId:session.user.id,bucket:'calendly-call-actions',limit:30}))throw new CallRequestError('Too many requests. Try shortly.',429);return NextResponse.json(await action(session.user),{headers:{'Cache-Control':'no-store'}});}catch(error){const status=(error instanceof CallRequestError||error instanceof CallCancellationError)?error.status:400;return NextResponse.json({error:(error instanceof CallRequestError||error instanceof CallCancellationError)?error.message:'Unable to complete this call action. Refresh and try again.'},{status});}}
export async function callBody(request:Request){const body=await request.json();if(!body||typeof body!=='object'||Array.isArray(body))throw new CallRequestError('Invalid request.',400);return body as Record<string,unknown>;}
