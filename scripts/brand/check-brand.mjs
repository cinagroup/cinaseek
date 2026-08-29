import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function text(path) {
  return readFile(resolve(ROOT, path), "utf8");
}

const lock = JSON.parse(await text("brand/brand.lock.json"));
const product = JSON.parse(await text("brand/cinaseek.json"));
const terminology = JSON.parse(await text("brand/terminology.json"));

if (lock.schemaVersion !== 1 || product.schemaVersion !== 1 || terminology.schemaVersion !== 1) {
  throw new Error("Unsupported CinaSeek brand schema version.");
}
if (lock.source?.version !== product.brandVersion || product.product?.name !== "CinaSeek" ||
    product.product?.parentBrand !== "CinaGroup") {
  throw new Error("CinaSeek brand identity does not match its lock file.");
}

for (const [path, expected] of Object.entries(lock.files ?? {})) {
  const data = await readFile(resolve(ROOT, path));
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected) throw new Error(`Brand file is out of sync: ${path}`);
}

const boundaryFiles = await Promise.all([
  text("packages/workshop-frontend/index.html"),
  text("packages/workshop-frontend/public/site.webmanifest"),
  text("packages/app-mobile/web/index.html"),
  text("packages/app-mobile/web/offline.html"),
]);
for (const content of boundaryFiles) {
  if (/Cloudflare OS|Gadgets Workshop/i.test(content)) {
    throw new Error("An upstream product name leaked into a public brand boundary.");
  }
  if (/#ff4801|#f4511e|#59c4e2|rgba\(255\s*,\s*72\s*,\s*1/i.test(content)) {
    throw new Error("A legacy accent color leaked into a public brand boundary.");
  }
}

const indexHtml = boundaryFiles[0];
for (const marker of [
  '<meta name="application-name" content="CinaSeek"',
  '<meta name="description"',
  '<meta property="og:title" content="CinaSeek"',
  '<link rel="manifest" href="/site.webmanifest"',
]) {
  if (!indexHtml.includes(marker)) throw new Error(`Missing Web brand metadata: ${marker}`);
}

const frontendTheme = await text("packages/workshop-frontend/src/theme.ts");
if (!frontendTheme.includes(`DEFAULT_ACCENT_COLOR = '${product.visual.colors.accent.toLowerCase()}'`)) {
  throw new Error("The frontend default accent does not match the CinaSeek brand manifest.");
}

const mobilePackage = JSON.parse(await text("packages/app-mobile/package.json"));
if (!mobilePackage.scripts?.assets?.includes(product.visual.colors.splash.toLowerCase())) {
  throw new Error("Mobile generated assets do not use the CinaSeek splash color.");
}

const electronPackage = JSON.parse(await text("packages/app-electron/package.json"));
if (electronPackage.build?.productName !== "CinaSeek" ||
    electronPackage.author?.name !== "CinaGroup" ||
    !electronPackage.build?.copyright?.includes("CinaGroup")) {
  throw new Error("Electron package metadata does not match the CinaSeek brand contract.");
}

const trustBoundary = await Promise.all([
  text("SECURITY.md"),
  text("docs/brand.md"),
  text("packages/workshop-frontend/src/components/trust/TrustPage.tsx"),
  text("packages/workshop-frontend/src/routes/legal.privacy.tsx"),
  text("packages/workshop-frontend/src/routes/legal.terms.tsx"),
  text("packages/workshop-frontend/src/routes/security.tsx"),
  text("packages/workshop-frontend/src/routes/support.tsx"),
]);
if (!trustBoundary.every((content) => content.includes("CinaSeek") || content.includes("TrustPage"))) {
  throw new Error("A required CinaSeek trust or support boundary is missing product attribution.");
}

console.log(
  `Validated CinaSeek brand ${product.brandVersion}: ${Object.keys(lock.files).length} locked files.`,
);
