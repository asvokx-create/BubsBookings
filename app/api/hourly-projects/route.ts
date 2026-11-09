import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasConfirmedAge, AGE_CONFIRMATION_REQUIRED_MESSAGE } from "@/lib/account-age";
import { enforceRateLimit } from "@/lib/request-security";
import { hasTrustedRequestOrigin } from "@/lib/request-origin";
import { createHourlyProject, listHourlyProjects, HourlyProjectError } from "@/lib/hourly-projects";
export async function GET() {
  const session=await auth.api.getSession({headers:await headers()});
  if(!session) return NextResponse.json({error:"Not signed in."},{status:401});
  if(!await hasConfirmedAge(session.user.id)) return NextResponse.json({error:AGE_CONFIRMATION_REQUIRED_MESSAGE},{status:403});
  try {return NextResponse.json({projects:await listHourlyProjects(session.user.id)});} catch(error) {console.error("Hourly projects read failed",error);return NextResponse.json({error:"Unable to load projects."},{status:500});}
}
export async function POST(request:Request) {
  const session=await auth.api.getSession({headers:await headers()});
  if(!session) return NextResponse.json({error:"Not signed in."},{status:401});
  if(!hasTrustedRequestOrigin(request)) return NextResponse.json({error:"Untrusted request origin."},{status:403});
  if(!await hasConfirmedAge(session.user.id)) return NextResponse.json({error:AGE_CONFIRMATION_REQUIRED_MESSAGE},{status:403});
  if(!await enforceRateLimit({request,userId:session.user.id,bucket:"hourly-project-create",limit:8})) return NextResponse.json({error:"Too many requests. Try again shortly."},{status:429});
  try {const body=await request.json();if(!body||typeof body!=="object"||Array.isArray(body)) return NextResponse.json({error:"Invalid request."},{status:400});return NextResponse.json({project:await createHourlyProject(session.user.id,body)},{status:201});}
  catch(error) {if(error instanceof HourlyProjectError) return NextResponse.json({error:error.message},{status:error.status});if(error instanceof SyntaxError||error instanceof RangeError)return NextResponse.json({error:error.message},{status:400});console.error("Hourly project create failed",error);return NextResponse.json({error:"Unable to request project."},{status:500});}
}
