"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { lockModalBackground } from "@/lib/modal-environment";

const focusableSelector = "a[href], button, input, select, textarea, [tabindex], [contenteditable='true']";
const modalStack: symbol[] = [];

export function useModalAccessibility<T extends HTMLElement>(open: boolean, onClose: () => void, disabled = false) {
  const dialogRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  const disabledRef = useRef(disabled);

  useEffect(() => { onCloseRef.current = onClose; disabledRef.current = disabled; }, [disabled, onClose]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const token = Symbol("modal");
    modalStack.push(token);
    const unlock = lockModalBackground(dialog);
    const ownsFocus = () => modalStack.at(-1) === token && !dialog.closest("[inert]");
    const items = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter((item) =>
      item.tabIndex >= 0 && !item.closest(".custom-select-menu") && !item.matches(":disabled") && !item.closest('[inert], [hidden], [aria-hidden="true"]') &&
      item.getClientRects().length > 0 && getComputedStyle(item).visibility !== "hidden");
    const focusFirst = () => (items().find((item) => item.hasAttribute("autofocus") || item.hasAttribute("data-modal-autofocus")) ?? items()[0] ?? dialog).focus();
    if (ownsFocus()) focusFirst();
    const scope = dialog.closest('[role="dialog"], [role="alertdialog"]') ?? dialog;
    const nestedDialogOwns = (target: EventTarget | null) => {
      const nested = target instanceof Element ? target.closest('[role="dialog"], [role="alertdialog"]') : null;
      return Boolean(nested && nested !== scope && !nested.contains(scope));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!ownsFocus() || event.defaultPrevented || nestedDialogOwns(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!disabledRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = items();
      const focused = event.target instanceof HTMLElement ? event.target : document.activeElement as HTMLElement | null;
      const controls = focused?.closest(".custom-select-menu") ? focused.getAttribute("aria-controls") : null;
      const owner = controls ? focusable.find((item) => item.getAttribute("aria-controls") === controls) : focused;
      const index = focusable.indexOf(owner as HTMLElement);
      // Trap all Tab steps, excluding hidden and roving-tabindex=-1 controls.
      event.preventDefault();
      event.stopImmediatePropagation();
      const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index + 1) % focusable.length;
      (focusable[next] ?? dialog).focus();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!ownsFocus() || nestedDialogOwns(event.target) || dialog.contains(event.target as Node)) return;
      focusFirst();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    const observer = new MutationObserver(() => {
      if (document.hasFocus() && ownsFocus() && !dialog.contains(document.activeElement) && !nestedDialogOwns(document.activeElement)) focusFirst();
    });
    observer.observe(dialog, { childList: true, subtree: true });
    return () => {

      observer.disconnect();
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      const wasTopmost = modalStack.at(-1) === token;
      const index = modalStack.indexOf(token);
      if (index >= 0) modalStack.splice(index, 1);
      unlock();
      if (wasTopmost && previousFocus?.isConnected && !previousFocus.closest("[inert]")) previousFocus.focus();
    };
  }, [open]);

  return dialogRef;
}
