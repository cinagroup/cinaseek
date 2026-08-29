import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'ai.cinaseek.app',
  appName: 'CinaSeek',
  webDir: 'web',
  appendUserAgent: ' CinaSeekMobile/1.0',
  backgroundColor: '#5dbfe3',
  loggingBehavior: 'debug',
  includePlugins: [],
  server: {
    allowNavigation: [
      'cinaseek.ai',
      'auth.cinaseek.ai',
      'cinagroup.cloudflareaccess.com',
      'accounts.google.com',
      'github.com',
    ],
    cleartext: false,
    errorPath: 'offline.html',
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
    useLegacyBridge: false,
  },
  ios: {
    allowsLinkPreview: false,
    preferredContentMode: 'mobile',
    webContentsDebuggingEnabled: false,
  },
}

export default config
