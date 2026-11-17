import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasConfirmedAge, AGE_CONFIRMATION_REQUIRED_MESSAGE } from "@/lib/account-age";
import { enforceRateLimit } from "@/lib/request-security";
import { hasTrustedRequestOrigin } from "@/lib/request-origin";
import { getHourlyProject, mutateHourlyProject, HourlyProjectError } from "@/lib/hourly-projects";
type Context={params:Promise<{projectId:string}>};
function failure(error:unknown) {if(error instanceof HourlyProjectError)return NextResponse.json({error:error.message},{status:error.status});if(error instanceof SyntaxError||error instanceof RangeError)return NextResponse.json({error:error.message},{status:400});console.error("Hourly project operation failed",error);return NextResponse.json({error:"Unable to update project."},{status:500});}
export async function GET(_request:Request,context:Context) {
  const session=await auth.api.getSession({headers:await headers()});if(!session)return NextResponse.json({error:"Not signed in."},{status:401});
  if(!await hasConfirmedAge(session.user.id))return NextResponse.json({error:AGE_CONFIRMATION_REQUIRED_MESSAGE},{status:403});
  try{return NextResponse.json({project:await getHourlyProject(session.user.id,(await context.params).projectId)});}catch(error){return failure(error);}
}
export async function POST(request:Request,context:Context) {
  const session=await auth.api.getSession({headers:await headers()});if(!session)return NextResponse.json({error:"Not signed in."},{status:401});
  if(!hasTrustedRequestOrigin(request))return NextResponse.json({error:"Untrusted request origin."},{status:403});
  if(!await hasConfirmedAge(session.user.id))return NextResponse.json({error:AGE_CONFIRMATION_REQUIRED_MESSAGE},{status:403});
  if(!await enforceRateLimit({request,userId:session.user.id,bucket:"hourly-project-mutate",limit:60}))return NextResponse.json({error:"Too many requests. Try again shortly."},{status:429});
  try{const body=await request.json();if(!body||typeof body!=="object"||Array.isArray(body))return NextResponse.json({error:"Invalid request."},{status:400});return NextResponse.json({project:await mutateHourlyProject(session.user.id,(await context.params).projectId,body)});}catch(error){return failure(error);}
}
