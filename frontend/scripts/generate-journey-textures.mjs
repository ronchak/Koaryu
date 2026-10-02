// Bake the journey's paper materials once, so no noise filters run in the browser.
// The filter definitions below are the source of truth for the textures in
// public/marketing. Run from frontend: node scripts/generate-journey-textures.mjs
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
const foundation = await readFile(
  new URL("../src/components/marketing/marketing-foundation.module.css", import.meta.url),
  "utf8",
);
const noise = (id, baseFrequency, seed, slope) =>
  `<filter id="${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${baseFrequency}" numOctaves="2" seed="${seed}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="${slope}"/></feComponentTransfer></filter>`;
const filters = {
  pulp: noise("pulp", "0.018 0.035", 17, 0.72),
  fine: noise("fine", "0.68", 7, 0.58),
  washiNoise: noise("washiNoise", "0.026 0.44", 29, 0.76),
  crumpleTile:
    '<filter id="crumpleTile" filterUnits="userSpaceOnUse" x="0" y="0" width="360" height="360" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.0111" numOctaves="4" seed="9" stitchTiles="stitch"/><feDiffuseLighting surfaceScale="1.9" diffuseConstant="1.05" lighting-color="#FFFFFF"><feDistantLight azimuth="235" elevation="58"/></feDiffuseLighting><feColorMatrix type="matrix" values="0.2067 0.2067 0.2067 0 0.0273 0.1667 0.1667 0.1667 0 0.0127 0.1133 0.1133 0.1133 0 -0.0484 0 0 0 0 1"/></filter>',
};
const filter = (name) => filters[name];
const svg = (size, defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs>${defs}</defs>${body}</svg>`;
const materials = {
  "scene-grain": svg(
    360,
    filter("pulp") + filter("fine"),
    '<rect width="360" height="360" filter="url(#pulp)" opacity="0.07"/><rect width="360" height="360" filter="url(#fine)" opacity="0.05"/>',
  ),
  crumple: svg(
    360,
    filter("crumpleTile"),
    '<rect width="360" height="360" filter="url(#crumpleTile)"/>',
  ),
  washi: svg(
    220,
    filter("washiNoise"),
    '<rect width="220" height="220" fill="#8B7B60" filter="url(#washiNoise)" opacity="0.24"/>',
  ),
  paper: decodeURIComponent(foundation.match(/url\("data:image\/svg\+xml,([^"\n]+)"\)/)[1]).replace(
    "viewBox='0 0 180 180'",
    "viewBox='0 0 180 180' width='180' height='180'",
  ),
};
for (const [name, source] of Object.entries(materials)) {
  const raster = sharp(Buffer.from(source));
  if (name === "scene-grain" || name === "paper") raster.flatten({ background: "#fff" });
  const output = await raster.webp({ quality: 75, alphaQuality: 60, effort: 6 }).toBuffer();
  await writeFile(new URL(`../public/marketing/${name}.webp`, import.meta.url), output);
  console.log(`${name}.webp: ${output.length} bytes`);
}
