import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_SOURCE = resolve(ROOT, "../cinabrand");
const SOURCE = resolve(process.env.CINABRAND_ROOT || process.argv[2] || DEFAULT_SOURCE);
const PRODUCT_ROOT = resolve(SOURCE, "products/cinaseek");

const product = JSON.parse(await readFile(resolve(PRODUCT_ROOT, "brand.json"), "utf8"));
const terminology = JSON.parse(await readFile(resolve(PRODUCT_ROOT, product.terminology), "utf8"));

if (product.schemaVersion !== 1 || product.product?.name !== "CinaSeek") {
  throw new Error(`Unsupported CinaSeek brand manifest in ${PRODUCT_ROOT}`);
}

const destinations = {
  logo: ["assets/logo.png", "packages/workshop-frontend/public/logo.png"],
  logoRounded3px: ["packages/app-electron/build/logo-rounded-3px.png"],
  markBlack: ["packages/workshop-frontend/public/logo-transparent.png"],
  favicon: ["packages/workshop-frontend/public/favicon.ico"],
  favicon16: ["packages/workshop-frontend/public/favicon-16.png"],
  favicon32: ["packages/workshop-frontend/public/favicon-32.png"],
  appleTouchIcon: ["packages/workshop-frontend/public/apple-touch-icon.png"],
  pwa192: ["packages/workshop-frontend/public/pwa-192.png"],
  pwa512: ["packages/workshop-frontend/public/pwa-512.png"],
  windowsIcon: ["packages/app-electron/build/icon.ico"],
  appIcon1024: [
    "packages/app-mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
  ],
};

await mkdir(resolve(ROOT, "brand"), { recursive: true });
await writeFile(resolve(ROOT, "brand/cinaseek.json"), `${JSON.stringify(product, null, 2)}\n`);
await writeFile(resolve(ROOT, "brand/terminology.json"), `${JSON.stringify(terminology, null, 2)}\n`);

const copied = ["brand/cinaseek.json", "brand/terminology.json"];
for (const [assetName, outputPaths] of Object.entries(destinations)) {
  const sourcePath = product.assets?.[assetName];
  if (!sourcePath) throw new Error(`Missing CinaSeek brand asset: ${assetName}`);
  const absoluteSource = resolve(PRODUCT_ROOT, sourcePath);
  for (const outputPath of outputPaths) {
    const absoluteOutput = resolve(ROOT, outputPath);
    await mkdir(dirname(absoluteOutput), { recursive: true });
    await copyFile(absoluteSource, absoluteOutput);
    copied.push(outputPath);
  }
}

const files = {};
for (const path of copied.toSorted()) {
  const data = await readFile(resolve(ROOT, path));
  files[path] = createHash("sha256").update(data).digest("hex");
}

const lock = {
  schemaVersion: 1,
  source: {
    package: "@cinagroup/brand",
    repository: "https://github.com/cinagroup/cinabrand",
    version: product.brandVersion,
  },
  files,
};
await writeFile(resolve(ROOT, "brand/brand.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);

console.log(`Synced CinaSeek brand ${product.brandVersion} from ${SOURCE}.`);
