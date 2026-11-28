export function paintRows(g, board) {
  for (const thread of board.threads) {
    const r = thread.rail;
    g.fillStyle = "rgba(58,66,31,.25)";
    g.fillRect(r.x, r.y, r.w, r.h);
    for (let y = r.y + 2; y < r.y + r.h; y += 5) {
      g.strokeStyle = "rgba(169,161,91,.19)";
      g.beginPath();
      g.moveTo(r.x, y);
      g.bezierCurveTo(
        r.x + r.w * 0.34,
        y + 2,
        r.x + r.w * 0.77,
        y - 2,
        r.x + r.w,
        y,
      );
      g.stroke();
    }
    g.fillStyle = "rgba(239,220,160,.31)";
    g.fillRect(board.timeline.x, r.y + r.h, board.timeline.w, 0.8);
  }
}
