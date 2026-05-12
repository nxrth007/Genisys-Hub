import { redirect } from 'next/navigation'

/**
 * Legacy route — the onboarding form used to live here as a pre-payment
 * step. As of 2026-05-11 it's embedded in /client and only renders
 * post-approval (role=client_onboarding). This page exists only so old
 * bookmarks / inbound links don't break; bounce them to /client where
 * the polymorphic dashboard renders the right screen for their current
 * funnel state.
 */
export default function LegacyOnboardingFormRedirect() {
  redirect('/client')
}
