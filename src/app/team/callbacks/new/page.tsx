import { CallbackForm } from '@/components/agent/callback-form'

/**
 * Team #1 new-callback page — same form Mary uses, posts to the
 * role-gated team endpoint.
 */
export default function NewTeamCallbackPage() {
  return (
    <div className="p-6">
      <CallbackForm
        mode="create"
        apiBase="/api/team/callbacks"
        pageBase="/team/callbacks"
      />
    </div>
  )
}
