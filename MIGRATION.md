# Database migration decision

The new API uses PostgreSQL and owns its database on the API VPS. The website reads operational
data through HTTPS and does not connect to this database.

The old cPanel MySQL database can be used remotely only if the hosting account allows remote
MySQL, the OVHcloud VPS IP is allow-listed, and encrypted database connections are available. This
is not the recommended production design: it preserves shared-host resource limits and adds
cross-host latency to every API operation.

For the production cutover:

- Regenerate sectors, positions and boundaries with `npm run dataset:sync`.
- Start ownership and request tables empty during a communicated maintenance window.
- Start FDR and ATIS tables empty; both contain short-lived live data and repopulate automatically.
- Keep a full export of the old MySQL database for rollback and audit purposes.
- Do not copy active ownership rows while controllers are connected. A stale ownership imported at
  cutover could prevent a legitimate claim or assign authority to the wrong session.

This avoids transforming framework-specific tables that contain no durable user data while still
preserving a complete rollback copy.
