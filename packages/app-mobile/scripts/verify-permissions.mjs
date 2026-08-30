import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [androidManifest, mainActivity, iosInfo, iosProject, english, simplified, traditional] =
  await Promise.all([
    readFile(resolve(mobileRoot, "android/app/src/main/AndroidManifest.xml"), "utf8"),
    readFile(resolve(mobileRoot, "android/app/src/main/java/ai/cinaseek/app/MainActivity.java"), "utf8"),
    readFile(resolve(mobileRoot, "ios/App/App/Info.plist"), "utf8"),
    readFile(resolve(mobileRoot, "ios/App/App.xcodeproj/project.pbxproj"), "utf8"),
    readFile(resolve(mobileRoot, "ios/App/App/en.lproj/InfoPlist.strings"), "utf8"),
    readFile(resolve(mobileRoot, "ios/App/App/zh-Hans.lproj/InfoPlist.strings"), "utf8"),
    readFile(resolve(mobileRoot, "ios/App/App/zh-Hant.lproj/InfoPlist.strings"), "utf8"),
  ]);

function requireText(source, expected, label) {
  if (!source.includes(expected)) throw new Error(`${label} is missing ${expected}`);
}

requireText(androidManifest, "android.permission.RECORD_AUDIO", "Android manifest");
requireText(androidManifest, "android.permission.MODIFY_AUDIO_SETTINGS", "Android manifest");
requireText(mainActivity, "APP_HOST = \"cinaseek.ai\"", "Android microphone policy");
requireText(mainActivity, "RESOURCE_AUDIO_CAPTURE", "Android microphone policy");
requireText(iosInfo, "NSMicrophoneUsageDescription", "iOS Info.plist");
requireText(iosProject, "InfoPlist.strings in Resources", "iOS project");
for (const [locale, contents] of [
  ["en", english],
  ["zh-Hans", simplified],
  ["zh-Hant", traditional],
]) {
  requireText(contents, "NSMicrophoneUsageDescription", `${locale} InfoPlist.strings`);
}

console.log("Verified native microphone permissions and localized usage descriptions.");
