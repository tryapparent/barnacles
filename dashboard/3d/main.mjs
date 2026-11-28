import { createCamera } from "./view/camera.mjs";
import { mountLandscape } from "./scene/renderer.mjs";
const first = (selector) => document.querySelector(selector);
function start() {
  if (!first(".summary-tiles")) {
    requestAnimationFrame(start);
    return;
  }
  const controller = createCamera(first);
  const sources = JSON.parse(first("#landscape-textures").textContent);
  mountLandscape(controller, first, sources);
}
start();
