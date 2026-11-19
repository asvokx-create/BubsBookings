import BrandMark from "@/components/brand-mark";
import UiIcon from "@/components/ui-icon";
import styles from "./home-provider-showcase.module.css";

// A read-only, privacy-safe excerpt of provider-dashboard.tsx, not a second app.
// Keep labels, empty states, and visual hierarchy aligned with the real overview.
export default function HomeProviderShowcase() {
  return (
    <figure className={styles.showcase}>
      <div className={styles.preview} role="img" aria-label="Provider dashboard overview: a green navigation rail, earnings and booking summaries, latest requests, and listings. Sample empty account; this preview is not interactive.">
        <div aria-hidden="true">
          <div className={styles.brand}><BrandMark className="h-6 w-6" /><strong>BubsBookings</strong><span className={styles.providerBadge}>Provider</span></div>
          <div className={styles.workspace}>
            <div className={styles.sidebar}>
              <small>Business</small>
              <span className={styles.active}><UiIcon name="overview" />Overview</span>
              <span><UiIcon name="projects" />Hourly projects</span>
              <span><UiIcon name="calendar" />Bookings</span>
              <span><UiIcon name="messages" />Messages</span>
              <span><UiIcon name="services" />Listings</span>
              <small>Growth</small>
              <span><UiIcon name="marketing" />Marketing</span>
            </div>
            <div className={styles.content}>
              <div className={styles.heading}><small>Today&apos;s overview</small><strong>Welcome, Provider.</strong><span>Here&apos;s what&apos;s happening with your business.</span></div>
              <div className={styles.metrics}>
                <div><span>Paid out this month</span><strong>$0</strong><small>No payouts received yet</small></div>
                <div><span>Upcoming jobs</span><strong>0</strong><small>Your schedule is clear</small></div>
                <div><span>New requests</span><strong>0</strong><small>No requests yet</small></div>
                <div><span>Average rating</span><strong>Not available</strong><small>No reviews yet</small></div>
              </div>
              <div className={styles.panel}><small>Bookings</small><strong>Latest requests</strong><div className={styles.empty}><b>No requests yet</b><span>New customer booking requests will appear here.</span></div></div>
              <div className={styles.panel}><small>Services</small><strong>Your listings</strong><div className={styles.empty}><b>No active listings</b><span>Create your first service</span></div></div>
            </div>
          </div>
        </div>
      </div>
      <figcaption>Provider dashboard preview. Sample empty account; navigation is shortened to fit.</figcaption>
    </figure>
  );
}
