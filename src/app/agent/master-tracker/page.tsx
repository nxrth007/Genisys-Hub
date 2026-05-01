/**
 * Agent-side Master Tracker. Re-exports the staff page so the two
 * views stay identical — same data, same controls, same styling.
 * Mary uses this exactly the way Ethan does, so any layout / feature
 * change to the staff page automatically lands here too.
 *
 * The middleware permits /api/call-center/master-tracker* for agents
 * so the data + mutation endpoints work the same.
 */
export { default } from '../../call-center/master-tracker/page'
