"use client";

import type { MouseEvent } from "react";

export default function SkipToContent() {
  function skip(event: MouseEvent<HTMLAnchorElement>) {
    // The display:contents wrapper has no focusable box. Move into the real
    // main landmark, beyond repeated navigation, without changing page layout.
    const main = document.querySelector<HTMLElement>("#site-content main, #site-content [role='main']");
    const target = main?.querySelector<HTMLElement>("h1") ?? main;
    if (!target) return;
    event.preventDefault();
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "start" });
  }
  return <a href="#site-content" className="skip-link" onClick={skip}>Skip to main content</a>;
}
