export function groundMaterials(g, images, rand) {
  function pat(k, sx, sy = sx) {
    const pat = g.createPattern(images[k], "repeat");
    pat.setTransform(new DOMMatrix().scale(sx, sy));
    return pat;
  }
  function gradient(x, y, r, inner, outer) {
    const a = g.createRadialGradient(x, y, 0, x, y, r);
    a.addColorStop(0, inner);
    a.addColorStop(1, outer);
    return a;
  }
  function shade(x, y, rx, ry, color) {
    g.save();
    g.translate(x, y);
    g.scale(1, ry / rx);
    g.fillStyle = gradient(0, 0, rx, color, "transparent");
    g.fillRect(-rx, -rx, 2 * rx, 2 * rx);
    g.restore();
  }
  function track(x1, z1, x2, z2, width) {
    const dx = x2 - x1,
      dz = z2 - z1,
      len = Math.hypot(dx, dz),
      steps = Math.ceil(len / 4);
    g.save();
    g.translate(x1, z1);
    g.rotate(Math.atan2(dz, dx));
    const wav = (t) =>
      1.2 * Math.sin(t * 0.021) +
      0.55 * Math.sin(t * 0.073) +
      2.1 * Math.sin(t * 0.006);
    const lane = (t, side) => wav(t) + side * width * (.28 + .024 * Math.sin(t / 37));
    for (const side of [-1, 1]) {
      for (const [spread, fill] of [[.23, "#6a633b99"], [.15, pat("road", .85)], [.055, "#c2a47882"]]) {
        g.beginPath();
        for (const direction of [1, -1]) {
          for (let i = 0; i <= steps; i++) {
            const t = len * (direction === 1 ? i : steps - i) / steps;
            g.lineTo(t, lane(t, side) + direction * (width * spread + rand() * .8));
          }
        }
        g.closePath();
        g.fillStyle = fill;
        g.fill();
      }
    }
    g.restore();
  }
  return { shade, track };
}

const crossfall = .049;
const backslope = -.23;
const nearSlope = .11;
export function hillside(board) {
  const crease = board.summary.y + board.summary.h;
  const intercept = slope => -crossfall * board.width * .5 - slope * crease;
  function height(x,z) {
    const slope=z>crease?nearSlope:backslope;
    return crossfall*x+slope*z+intercept(slope);
  }
  return {
    height,
    plane(near) {
      const slope=near?nearSlope:backslope;
      return [1,0,crossfall,0, 0,1,slope,0, 0,0,1,0, 0,0,intercept(slope),1];
    },
  };
}

export const hillsideShader = `
uniform highp float crease;
float slopeAt(float z){return z>crease?${nearSlope}:${backslope};}
float heightAt(vec2 xz){return (xz.x-view.x*.5)*${crossfall}+(xz.y-crease)*slopeAt(xz.y);}
float riseAlong(vec2 ray,float slope){return ray.x*${crossfall}+ray.y*slope;}`;

export function groundMesh() {
  const vertices = [];
  for (const [back, front] of [[-16,0],[0,8]])
    for (const [x,z] of [[-12,back],[12,back],[-12,front],[-12,front],[12,back],[12,front]])
      vertices.push(x,0,z,1,1,1,-6,0,0);
  return vertices;
}
