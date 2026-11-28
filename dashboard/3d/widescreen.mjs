const minimumWidth = 1024;
export const wideViewport = () => matchMedia(`(min-width: ${minimumWidth}px)`);
export const widthNotice = `Open this landscape in a window at least ${minimumWidth} pixels wide.`;
