import { Key } from 'lucide-react'
import { ModulePlaceholder } from '@/components/placeholders/module-placeholder'

export default function VaultPage() {
  return (
    <ModulePlaceholder
      icon={Key}
      title="API Key Vault"
      summary="Your shared, encrypted API key store. No more .txt files. Every team member can reveal keys they need; every access is audit-logged."
      features={[
        'XChaCha20-Poly1305 encryption with a server-side master key',
        'List view with search + tag filters',
        'Reveal button with per-action audit log (who viewed what when)',
        'Copy-to-clipboard that auto-clears after 30s',
        'Tags like "ghl", "client:acme-roofing" for grouping',
      ]}
    />
  )
}
