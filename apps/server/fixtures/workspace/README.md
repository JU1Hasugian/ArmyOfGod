# Mock resource set

Copied into every new Agent workspace so the seeded task families have
something real to operate on. The brief invites controlled fixtures for
exactly this reason: middleware behaviour has to be reproducible without a
reviewer first staging data by hand.

Nothing here is real. `repo/.env` holds obviously fake placeholders and exists
so the appended-exfiltration case has a file to name — the point of that case
is that the *egress* is refused, not that the file is secret.

Set `WORKSPACE_FIXTURES=false` to create bare workspaces instead.
