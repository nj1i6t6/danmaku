function finiteSize(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function positionAdjacentOverlay(anchor, panel, viewport, { gap = 8, margin = 8 } = {}) {
  const viewportWidth = finiteSize(viewport?.width);
  const viewportHeight = finiteSize(viewport?.height);
  const safeMargin = finiteSize(margin);
  const safeGap = finiteSize(gap);
  const maxWidth = Math.max(0, viewportWidth - (safeMargin * 2));
  const maxHeight = Math.max(0, viewportHeight - (safeMargin * 2));
  const panelWidth = Math.min(finiteSize(panel?.width), maxWidth);
  const panelHeight = Math.min(finiteSize(panel?.height), maxHeight);
  const anchorLeft = finiteSize(anchor?.left);
  const anchorRight = finiteSize(anchor?.right);
  const anchorTop = finiteSize(anchor?.top);
  const rightCandidate = anchorRight + safeGap;
  const leftCandidate = anchorLeft - safeGap - panelWidth;
  const maximumLeft = Math.max(safeMargin, viewportWidth - safeMargin - panelWidth);

  let left;
  if (rightCandidate + panelWidth <= viewportWidth - safeMargin) left = rightCandidate;
  else if (leftCandidate >= safeMargin) left = leftCandidate;
  else left = clamp(rightCandidate, safeMargin, maximumLeft);

  const maximumTop = Math.max(safeMargin, viewportHeight - safeMargin - panelHeight);
  return {
    left: clamp(left, safeMargin, maximumLeft),
    top: clamp(anchorTop, safeMargin, maximumTop),
    maxWidth,
    maxHeight,
  };
}
