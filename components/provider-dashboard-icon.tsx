import UiIcon, { type UiIconName } from "@/components/ui-icon";

export type ProviderDashboardIconName = Extract<UiIconName,
  | "projects"
  | "overview"
  | "bookings"
  | "opportunities"
  | "calendar"
  | "messages"
  | "revenue"
  | "services"
  | "profile"
  | "marketing"
  | "locations"
  | "availability"
  | "reviews"
  | "customers"
  | "team"
  | "billing"
  | "settings">;

export default function ProviderDashboardIcon({ name, className = "h-4 w-4" }: { name: ProviderDashboardIconName; className?: string }) {
  return <UiIcon name={name} className={className} />;
}
