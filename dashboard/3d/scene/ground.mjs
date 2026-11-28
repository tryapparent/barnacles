export function groundMaterials(g, rand) {
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
      for (const [spread, fill] of [[.23, "#6a633b99"], [.15, "#907a56"], [.055, "#a28e6882"]]) {
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
      for(let t=0;t<len;t+=.48+rand()*1.3) {
        const center=lane(t,side);
        const offset=(rand()-.5)*width*.48;
        const radius=.15+rand()*.47;
        g.fillStyle=rand()<.54 ? "#4d4836ba" : "#cfb998b8";
        g.beginPath();
        g.ellipse(t,center+offset,radius*1.4,radius,rand()*2,0,Math.PI*2);
        g.fill();
      }
    }
    g.restore();
  }
  return { track };
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

export function plantBoundary(timber, width, random) {
  for (let x=-width; x<width*2;) {
    const grove=2+Math.floor(random()*5);
    for(let i=0;i<grove;i++) {
      const bank=36+14*Math.sin(x*.008)+6*Math.sin(x*.026+1.3);
      timber(x,bank+2+random()*7,1.7+random()*2.9);
      x+=3+random()*5;
    }
    x+=24+random()*72;
  }
}
