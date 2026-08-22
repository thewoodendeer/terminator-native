/**
 * HIT FLASH — a lit step brightens the instant it is triggered, then decays.
 *
 * Under the 4K finish every step cell is an LED (see the emissive block in
 * terminator.css). This makes them BEHAVE like LEDs: when the playhead crosses
 * an "on" cell, the cell flares and settles over ~400ms — the note visibly
 * fires. Driven from the two existing rAF playheads (Timeline.tsx and
 * DrumSection.tsx), which already know the current column each frame and
 * already avoid React for it. Called at most once per column change.
 *
 * Implementation: the Web Animations API on `filter`, not a class toggle — no
 * forced reflow to restart it, and a cell hit again on the next bar simply
 * gets a fresh animation from the current value (interruptible, per
 * apple-design-motion). `filter` also brightens the element's own box-shadow,
 * so the LED's spill flares with it for free.
 *
 * Inert unless body[data-finish="4k"] — the classic look is untouched.
 */

const FLARE: Keyframe[] = [
  { filter: 'brightness(2.1) saturate(1.15)', offset: 0 },
  { filter: 'brightness(1.35) saturate(1.05)', offset: 0.35 },
  { filter: 'brightness(1)', offset: 1 },
];
const TIMING: KeyframeAnimationOptions = { duration: 420, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'none' };

export function is4k(): boolean {
  return document.body.dataset.finish === '4k';
}

/** Flare every element in `cells`. Cheap no-op when the finish is classic. */
export function flashCells(cells: Iterable<Element>): void {
  if (!is4k()) return;
  for (const el of cells) {
    // Cancel a still-running flare so the new one starts from its current
    // brightness rather than stacking two filters.
    for (const a of (el as HTMLElement).getAnimations()) if (a.id === 'luxe-hit') a.cancel();
    const anim = (el as HTMLElement).animate(FLARE, TIMING);
    anim.id = 'luxe-hit';
  }
}

/** The "on" cells of column `col` inside `container`, one per row. Rows are
 *  the elements matching `rowSel`; a row's cells are its `cellSel` children in
 *  DOM order. */
export function onCellsInColumn(container: ParentNode, rowSel: string, cellSel: string, col: number): Element[] {
  const out: Element[] = [];
  const rows = container.querySelectorAll(rowSel);
  for (const row of rows) {
    const cell = row.querySelectorAll(cellSel)[col];
    if (cell && cell.classList.contains('on')) out.push(cell);
  }
  return out;
}
