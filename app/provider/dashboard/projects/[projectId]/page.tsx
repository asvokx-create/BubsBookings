import { HourlyProjectDetail } from "@/components/hourly-projects";
export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) { const { projectId } = await params; return <HourlyProjectDetail projectId={projectId} mode="provider" />; }
