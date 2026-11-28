import type { Metadata, Viewport } from 'next'

/**
 * Genisys OS as a phone app: what /genisys-os and /login (where contractors sign in) tell the
 * browser, so "Add to Home Screen" makes a full-screen app called Genisys OS with its own icon
 * (public/genisys-os.webmanifest; the icons come from scripts/build-genisys-os-icons.mjs). The rest
 * of the Hub, and the /hl pages on client websites, don't offer to install anything.
 */
export const APP_METADATA: Metadata = {
  applicationName: 'Genisys OS',
  manifest: '/genisys-os.webmanifest',
  // The status bar sits over the app's own top bar (the shell pads under it).
  appleWebApp: { capable: true, title: 'Genisys OS', statusBarStyle: 'black-translucent' },
  // Next writes the newer mobile-web-app-capable; iPhones before iOS 16.4 only read Apple's name for it.
  other: { 'apple-mobile-web-app-capable': 'yes' },
}

export const APP_VIEWPORT: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Edge to edge on notched phones; the shell keeps clear of the notch and the home bar.
  viewportFit: 'cover',
  themeColor: '#09090b',
  // Android: the keyboard shrinks the page, so the message box stays above it.
  interactiveWidget: 'resizes-content',
}
