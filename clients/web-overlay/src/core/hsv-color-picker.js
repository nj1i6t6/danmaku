const HEX = /^#[0-9a-f]{6}$/i;

function round(value, places) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clamp(value, minimum, maximum) {
  const number = Number(value);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(number) ? number : minimum));
}

function canonicalHue(value) {
  const hue = Number(value);
  if (!Number.isFinite(hue)) return 0;
  return ((hue % 360) + 360) % 360;
}

export function hsvToRgb({ h, s, v }) {
  const hue = canonicalHue(h);
  const saturation = clamp(s, 0, 1);
  const value = clamp(v, 0, 1);
  const chroma = value * saturation;
  const section = hue / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  const match = value - chroma;
  let rgb;
  if (section < 1) rgb = [chroma, x, 0];
  else if (section < 2) rgb = [x, chroma, 0];
  else if (section < 3) rgb = [0, chroma, x];
  else if (section < 4) rgb = [0, x, chroma];
  else if (section < 5) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];
  const [r, g, b] = rgb.map((channel) => Math.round((channel + match) * 255));
  return { r, g, b };
}

export function rgbToHsv({ r, g, b }) {
  const red = clamp(r, 0, 255) / 255;
  const green = clamp(g, 0, 255) / 255;
  const blue = clamp(b, 0, 255) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta !== 0) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) hue = 60 * (((blue - red) / delta) + 2);
    else hue = 60 * (((red - green) / delta) + 4);
  }
  return {
    h: round(canonicalHue(hue), 1),
    s: round(maximum === 0 ? 0 : delta / maximum, 3),
    v: round(maximum, 3),
  };
}

function channelHex(channel) {
  return channel.toString(16).padStart(2, '0').toUpperCase();
}

export function hsvToHex(hsv) {
  const { r, g, b } = hsvToRgb(hsv);
  return `#${channelHex(r)}${channelHex(g)}${channelHex(b)}`;
}

export function hexToHsv(value) {
  const hex = String(value || '');
  if (!HEX.test(hex)) throw new TypeError('Color must use #RRGGBB');
  return rgbToHsv({
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  });
}

export function createColorDraft(initialColor, onCommit) {
  if (!HEX.test(String(initialColor || ''))) throw new TypeError('Color must use #RRGGBB');
  if (typeof onCommit !== 'function') throw new TypeError('onCommit must be a function');
  let committed = String(initialColor).toUpperCase();
  let draft = committed;
  return {
    preview(hsv) {
      draft = hsvToHex(hsv);
      return draft;
    },
    cancel() {
      draft = committed;
      return draft;
    },
    apply() {
      committed = draft;
      onCommit(committed);
      return committed;
    },
    current() {
      return draft;
    },
  };
}
