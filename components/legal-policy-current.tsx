"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

const policyPaths = new Set(["/terms","/privacy","/provider-agreement","/partner-agreement","/ai-transparency","/cookies","/content-removal","/accessibility","/cancellations-refunds","/payment-billing","/provider-safety","/marketing-communications","/dmca"]);
const policyLinks = '.legal-page :is(nav[aria-label="Legal policies"], nav[aria-label="Additional legal policies"]) > a';

export function setCurrentPolicyLink(root: ParentNode, pathname: string | null) {
  const path = pathname?.replace(/\/$/, "");
  const links = Array.from(root.querySelectorAll(policyLinks));
  const current = path && policyPaths.has(path)
    ? links.find((link) => link.getAttribute("href") === path)
    : undefined;
  for (const link of links) {
    if (link === current) {
      if (link.getAttribute("aria-current") !== "page") link.setAttribute("aria-current", "page");
    } else if (link.hasAttribute("aria-current")) link.removeAttribute("aria-current");
  }
}

export default function LegalPolicyCurrent() {
  const pathname = usePathname();
  useEffect(() => {
    const content = document.getElementById("site-content");
    if (!content || !pathname || !policyPaths.has(pathname.replace(/\/$/, ""))) return;
    const update = () => setCurrentPolicyLink(content, pathname);
    update();
    // App Router may replace streamed page content after the pathname updates.
    const observer = new MutationObserver(update);
    observer.observe(content, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      setCurrentPolicyLink(content, null);
    };
  }, [pathname]);
  return null;
}
