"use client";

import Link from "next/link";
import { useRef, type ComponentProps } from "react";
import { recordListingDeparture, type ListingLinkKind } from "@/lib/listing-return";

type ListingResultLinkProps = Pick<ComponentProps<typeof Link>, "href" | "className" | "aria-label" | "children"> & {
  listing?: string;
  kind: ListingLinkKind;
};

export default function ListingResultLink({ listing, kind, ...props }: ListingResultLinkProps) {
  const link = useRef<HTMLAnchorElement>(null);
  return <Link
    {...props}
    ref={link}
    data-listing-return-link={listing ? kind : undefined}
    onNavigate={() => { if (listing && link.current) recordListingDeparture(link.current, listing, kind); }}
  />;
}
