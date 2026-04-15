import { Sidebar } from './sidebar'
import { Header } from './header'

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto bg-zinc-50 p-6 dark:bg-zinc-950">
          {children}
        </main>
      </div>
    </div>
  )
}
