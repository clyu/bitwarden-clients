import { DestroyRef, ElementRef, afterNextRender, inject } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { fromEvent, merge, takeUntil } from "rxjs";

import { ScrollLayoutService } from "@bitwarden/components";

/**
 * Keeps the page of the component at its top until the user scrolls it. It is called where the
 * component is created, such as in its constructor.
 *
 * As a page that account security links to opens, Firefox can scroll it by itself to where the
 * page before it was scrolled to: account security, which the user scrolls down to reach the link.
 * No script asks for that, so whatever scrolls the page before the user does is undone.
 */
export function keepAtTop(): void {
  const destroyRef = inject(DestroyRef);
  const host = inject<ElementRef<HTMLElement>>(ElementRef);
  const scrollLayout = inject(ScrollLayoutService);

  afterNextRender(() => {
    const region = scrollLayout.scrollableRef()?.nativeElement;
    if (region == null || !host.nativeElement.contains(region)) {
      return;
    }
    const passive = { passive: true };
    const userScrolls = merge(
      fromEvent(region, "wheel", passive),
      // The scrollbar as well.
      fromEvent(region, "pointerdown", passive),
      fromEvent(region, "touchstart", passive),
      fromEvent(region.ownerDocument, "keydown"),
    );
    region.scrollTop = 0;
    fromEvent(region, "scroll")
      .pipe(takeUntilDestroyed(destroyRef), takeUntil(userScrolls))
      .subscribe(() => (region.scrollTop = 0));
  });
}
