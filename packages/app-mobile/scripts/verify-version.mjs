import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [mobilePackage, desktopPackage, androidGradle, iosProject] = await Promise.all([
  readFile(resolve(mobileRoot, "package.json"), "utf8").then(JSON.parse),
  readFile(resolve(mobileRoot, "../app-electron/package.json"), "utf8").then(JSON.parse),
  readFile(resolve(mobileRoot, "android/app/build.gradle"), "utf8"),
  readFile(resolve(mobileRoot, "ios/App/App.xcodeproj/project.pbxproj"), "utf8"),
]);

const version = desktopPackage.version;
if (mobilePackage.version !== version) {
  throw new Error(`desktop ${version} and mobile ${mobilePackage.version} versions differ`);
}

const androidVersion = androidGradle.match(/versionName\s+"([^"]+)"/)?.[1];
const androidBuild = Number(androidGradle.match(/versionCode\s+(\d+)/)?.[1]);
if (androidVersion !== version || !Number.isInteger(androidBuild) || androidBuild < 1) {
  throw new Error(`invalid Android version: ${androidVersion} (${androidBuild})`);
}

const iosVersions = [...iosProject.matchAll(/MARKETING_VERSION = ([^;]+);/g)]
  .map((match) => match[1]);
const iosBuilds = [...iosProject.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)]
  .map((match) => Number(match[1]));
if (iosVersions.length === 0 || iosVersions.some((value) => value !== version)) {
  throw new Error(`invalid iOS marketing versions: ${iosVersions.join(", ")}`);
}
if (iosBuilds.length === 0 || iosBuilds.some((value) => value !== androidBuild)) {
  throw new Error(`Android and iOS build numbers differ: ${androidBuild} / ${iosBuilds.join(", ")}`);
}

console.log(`Verified native app version ${version} (build ${androidBuild}).`);
