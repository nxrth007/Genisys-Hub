/**
 * Backward-compat re-export. The component lives at
 * @/components/ui/address-input now (since both /agent and the
 * public client onboarding form use it). Keeping this thin shim so
 * existing imports keep working without a churn-y rename PR.
 */
export { AddressInput as AddressFields } from '@/components/ui/address-input'
