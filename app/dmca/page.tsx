import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/app/terms/page";
import { publicPageMetadata } from "@/lib/seo";

export const metadata: Metadata = publicPageMetadata({
  title: "DMCA Copyright Policy",
  description: "Learn how to submit a copyright notice or counter-notice about content hosted on BubsBookings.",
  pathname: "/dmca",
});

const sections = [
  ["1. Reporting claimed copyright infringement", <>Send a written copyright notice to <a href="mailto:christian@bubsbookings.com?subject=BubsBookings%20copyright%20notice" className="font-bold underline">christian@bubsbookings.com</a> with “Copyright notice” in the subject. Include: your physical or electronic signature; identification of the copyrighted work; identification and location of the material claimed to infringe; contact information; a statement of good-faith belief that the use is not authorized; and a statement, under penalty of perjury, that the notice is accurate and that you are authorized to act for the owner.</>],
  ["2. Review and action", "BubsBookings may request information needed to locate the material, notify the person who posted it, remove or restrict access to material, preserve relevant records, or decline an incomplete or unsupported notice. BubsBookings may take action against repeat infringers in appropriate circumstances. This policy does not promise any particular outcome or imply that all notices qualify under the DMCA."],
  ["3. Counter-notices", "If your material was removed or restricted for a copyright claim and you believe it was removed by mistake or misidentification, send a written counter-notice identifying the removed material and its former location, your name, address, telephone number, consent to federal-court jurisdiction in the appropriate district, consent to accept service from the claimant, and a statement under penalty of perjury that you have a good-faith belief the removal was a mistake or misidentification. Do not submit a counter-notice unless you understand its legal consequences."],
  ["4. Other reports", <><p>For privacy, trademark, nonconsensual-intimate-content, or other removal requests, use the <Link href="/content-removal" className="font-bold underline">Content Removal</Link> policy. This DMCA policy does not replace another legal remedy or emergency response.</p></>],
  ["5. Designated agent information", <>BubsBookings will maintain a current public designated-agent contact only after a designation has been made and maintained through the U.S. Copyright Office’s <a href="https://copyright.gov/dmca-directory/" target="_blank" rel="noreferrer" className="font-bold underline">DMCA Designated Agent Directory</a>. Publishing this process does not by itself state that BubsBookings qualifies for any DMCA safe harbor.</>],
] as const;

export default function DmcaPage() {
  return <LegalPage eyebrow="Copyright" title="DMCA Copyright Policy" intro="How to submit a copyright notice or counter-notice about material hosted through BubsBookings." sections={sections} />;
}
