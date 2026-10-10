// When Gremlin shows a desktop notification for a session, and what it says.
// Loaded by the renderer as a plain <script> (window.WidgetNotify) and by tests via require.
(function (root) {
  // A notification is only for a session you are not already looking at: Gremlin is not the focused window,
  // or that session is not one of the terminals on screen.
  function shouldNotify({ enabled, id, windowFocused, shownIds }) {
    if (!enabled || !id) return false;
    return !(windowFocused && Array.isArray(shownIds) && shownIds.includes(id));
  }

  // The Notification hook reports a type ("permission_prompt", "elicitation_dialog") or the message itself.
  const REASONS = {
    permission_prompt: 'Waiting for your permission',
    elicitation_dialog: 'Has a question for you'
  };

  // kind: 'attention' (needs you) or 'finished' (the turn ended); reason: what the hook reported, if anything.
  function message(kind, project, reason, host) {
    const name = project || 'a project';
    // host: set for a session on another computer, so the notification says where it is.
    const where = typeof host === 'string' && host.trim() ? `${name} on ${host.trim()}` : name;
    if (kind === 'finished') return { title: 'Claude finished', body: where };
    const why = REASONS[reason] || (typeof reason === 'string' && reason.trim()) || 'Waiting for you';
    return { title: 'Claude needs your input', body: `${where}\n${why}` };
  }

  const api = { shouldNotify, message };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WidgetNotify = api;
})(this);
