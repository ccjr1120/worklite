import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="space-y-2 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">WorkLite</h1>
        <p className="text-muted-foreground">Create and run team AI agents and workflows.</p>
      </div>
    </main>
  );
}
