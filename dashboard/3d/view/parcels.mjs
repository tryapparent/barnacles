export function* operationParcels(nativeButtons, r, narrow) {
  const weights = nativeButtons.map(
    (b) => parseFloat(b.getAttribute("aria-description")) || 1,
  );
  const sum = weights.reduce((a, b) => a + b, 0);
  let offset = 0;
  for (const [i, native] of nativeButtons.entries()) {
    const fraction = weights[i] / sum,
      vertical = narrow || nativeButtons.length > 2;
    const piece = vertical
      ? { x: r.x, y: r.y + offset * r.h, w: r.w, h: r.h * fraction }
      : { x: r.x + offset * r.w, y: r.y, w: r.w * fraction, h: r.h };
    offset += fraction;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "parcel-button";
    button.setAttribute("aria-pressed", "false");
    const label = document.createElement("span"),
      metric = document.createElement("small");
    label.textContent = native.querySelector(".operation-name").textContent;
    metric.textContent = native
      .querySelector(".operation-metric")
      .textContent.replace("✓", "");
    button.setAttribute(
      "aria-label",
      label.textContent + " · " + metric.textContent,
    );
    label.append(metric);
    button.append(label);
    yield { native, piece, button, metric };
  }
}

export function projectLabels(root, camera, plots, labelAnchors) {
  for (const { button, r } of plots) {
    const x = camera.x + r.x * camera.s,
      y = camera.y + r.y * camera.s * camera.p;
    button.tabIndex =
      x + r.w * camera.s < 8 ||
      y + r.h * camera.s * camera.p < 8 ||
      x > root.clientWidth - 8 ||
      y > root.clientHeight - 8
        ? -1
        : 0;
    Object.assign(button.style, {
      left: camera.x + r.x * camera.s + "px",
      top: camera.y + r.y * camera.s * camera.p + "px",
      width: r.w * camera.s + "px",
      height: r.h * camera.s * camera.p + "px",
    });
  }
  for (const { tag, r } of labelAnchors) {
    const width = r.w * camera.s;
    tag.hidden = width < tag.offsetWidth + 14 || width < 106;
    tag.style.transform =
      "translate(" +
      Math.round(camera.x + r.x * camera.s + 5) +
      "px," +
      Math.round(camera.y + r.y * camera.s * camera.p + 6) +
      "px)";
  }
}
