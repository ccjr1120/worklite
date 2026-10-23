type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: { platform?: string };
};

function platformName(): string {
  const navigatorWithUserAgentData = navigator as NavigatorWithUserAgentData;
  return navigatorWithUserAgentData.userAgentData?.platform ?? navigator.platform;
}

function isApplePlatform(): boolean {
  return /mac|iphone|ipad|ipod/i.test(platformName());
}

function commandShortcutLabel(): string {
  return isApplePlatform() ? '⌘K' : 'Ctrl K';
}

export { commandShortcutLabel };
