export function paintRows(g, board) {
  for (const thread of board.threads) {
    const r = thread.rail;
    g.fillStyle = "rgba(58,66,31,.25)";
    g.fillRect(r.x, r.y, r.w, r.h);
    g.fillStyle = "rgba(239,220,160,.31)";
    g.fillRect(board.timeline.x, r.y + r.h, board.timeline.w, 0.8);
  }
}
