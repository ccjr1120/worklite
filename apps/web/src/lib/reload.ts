// One entry point for full-page reloads, so a component test can observe the intent instead
// of relying on jsdom's unimplemented navigation.
function reloadPage(): void {
  window.location.reload();
}

export { reloadPage };
