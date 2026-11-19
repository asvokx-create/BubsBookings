const inertLocks = new Map<HTMLElement, { count: number; previous: boolean }>();
let scrollLocks = 0;
let previousOverflow = "";
let previousOverflowPriority = "";

export function lockModalBackground(dialog: HTMLElement) {
  const locked: HTMLElement[] = [];
  let branch: HTMLElement = dialog;
  while (branch.parentElement) {
    for (const sibling of Array.from(branch.parentElement.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
      const existing = inertLocks.get(sibling);
      if (existing) existing.count += 1;
      else inertLocks.set(sibling, { count: 1, previous: sibling.inert });
      sibling.inert = true;
      locked.push(sibling);
    }
    if (branch.parentElement === document.body) break;
    branch = branch.parentElement;
  }
  if (scrollLocks++ === 0) {
    previousOverflow = document.body.style.getPropertyValue("overflow");
    previousOverflowPriority = document.body.style.getPropertyPriority("overflow");
    document.body.style.setProperty("overflow", "hidden");
  }
  return () => {
    for (const element of locked) {
      const lock = inertLocks.get(element);
      if (!lock || --lock.count > 0) continue;
      element.inert = lock.previous;
      inertLocks.delete(element);
    }
    if (--scrollLocks === 0) document.body.style.setProperty("overflow", previousOverflow, previousOverflowPriority);
  };
}
