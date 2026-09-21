// Bake the existing SVG materials once, keeping noise/filter work off mobile frames.
// Run from frontend: node scripts/generate-journey-textures.mjs
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
const scene = await readFile(
  new URL("../src/components/marketing/journey/journey-scene.tsx", import.meta.url),
  "utf8",
);
const foundation = await readFile(
  new URL("../src/components/marketing/marketing-foundation.module.css", import.meta.url),
  "utf8",
);
const filter = (name) => {
  const match = scene.match(new RegExp(`<filter\\s+id=\\{ids\\.${name}\\}[\\s\\S]*?</filter>`));
  if (!match) throw new Error(`Missing original filter: ${name}`);
  return match[0]
    .replace(`id={ids.${name}}`, `id="${name}"`)
    .replaceAll("colorInterpolationFilters", "color-interpolation-filters");
};
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
