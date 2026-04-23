# billing

Billing project.

## Infrastructure
- Database: `proj_billing` on self-hosted Supabase (`db.bios.co.il`)
- Server: vps-ad565027.vps.ovh.net
- Path: `/var/www/billing`

## Connection
See `.env.local` (not committed) for Supabase keys and pooled DB URLs:
- `DATABASE_URL` → Supavisor transaction pooler (port 6543)
- `DIRECT_URL`  → Supavisor session pooler (port 5432)

## DB admin
```bash
docker exec supabase-db psql -U postgres -d proj_billing -c "\dt"
```
