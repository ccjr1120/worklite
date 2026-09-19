import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@xyflow/react/dist/style.css';
import { routeTree } from './routeTree.gen';
import { RouteError, RoutePending } from './components/route-boundaries';
import { queryClient } from './lib/query-client';
import { APP_BUILD_TAG, APP_VERSION_LABEL } from './app-version';
import './i18n/config';
import './styles/index.css';

const badgeStyle = 'padding:3px 7px;font:600 11px/1.6 ui-sans-serif,system-ui,sans-serif;color:#fff;';
console.info(
  `%cWorkLite%c${APP_VERSION_LABEL}%c${APP_BUILD_TAG}`,
  `${badgeStyle}background:#2563eb;border-radius:4px 0 0 4px;`,
  `${badgeStyle}background:#3f3f46;`,
  `${badgeStyle}background:#71717a;border-radius:0 4px 4px 0;font-variant-numeric:tabular-nums;`,
);

const router = createRouter({
  routeTree,
  defaultPendingComponent: RoutePending,
  defaultErrorComponent: RouteError,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}
const appRoot = rootElement;

createRoot(appRoot).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
