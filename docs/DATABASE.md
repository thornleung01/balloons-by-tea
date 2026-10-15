# Database setup (Supabase)

All of the site's database setup is plain SQL that you paste into
**Supabase Dashboard -> SQL Editor -> New query -> Run**. There are no
tools to install.

## New project: run one file

Run **`supabase-all.sql`** once. That is everything: the original setup plus
all six upgrades, in the right order. You are done with the database.

## Existing project: run what you are missing

If you already ran `supabase-setup.sql` earlier, do **not** start over. Run
only the upgrade files you have not run yet, in this order, one per query:

| File (in `supabase-migrations/`) | What it adds | Needs first |
| --- | --- | --- |
| `10-orders-v2.sql` | Orders: items list, real event date, payment tracking, the "quoted" status, the order timeline | `supabase-setup.sql` |
| `20-notifications.sql` | Emails/texts when a new order arrives (database half; also needs the `notify-new-order` function, see `docs/admin-notifications.md`) | `supabase-setup.sql` |
| `30-safety.sql` | Team roles (owner / staff), 2-step login support, Activity log, Restore from backup | `supabase-setup.sql` |
| `40-products.sql` | Products: trash / undo, scheduling, pricing and option fields | `supabase-setup.sql` |
| `50-analytics.sql` | Faster, richer Analytics tab | `supabase-setup.sql` |
| `60-content.sql` | Revert-able Settings/FAQ history, photo alt text | `supabase-setup.sql` |

The files do not depend on each other for their tables, so skipping one
never breaks another. The admin page shows a "run ... first" notice for any
feature whose file is missing. Running them in the order above is simply the
tested order, and it is the order `supabase-all.sql` uses.

## Is it safe to run a file twice?

Yes. Every file is written to be re-run: it only adds what is missing and
never deletes your shop data. Re-running the original `supabase-setup.sql`
after the upgrades is also safe now: it detects that upgrades are in place
and leaves these three things alone instead of putting the old versions back:

- the admin check (`is_admin()`), so team roles and 2-step login keep working;
- the public products policy, so trashed or not-yet-launched products stay hidden;
- the order status rule, so the "quoted" status keeps working.

(Verified by installing from scratch, installing twice, running the original
file then each upgrade, and re-running the original file at the end; all
leave the database identical.)

## For whoever maintains the code

- `supabase-setup.sql` and `supabase-migrations/*.sql` are the source of
  truth. **`supabase-all.sql` is generated**: never edit it by hand.
- After changing any of those files (or adding `70-something.sql`), run:

  ```
  node scripts/build-sql.js
  ```

  and commit the updated `supabase-all.sql`.
- Checks (Node only, no installs):

  ```
  node scripts/build-sql.js --check        # fails if supabase-all.sql is stale
  node scripts/check-backup-coverage.js    # fails if a table is forgotten by Backup/Restore
  ```

- **Adding a new table?** Add it to `TABLES` in `js/admin-backup.js` and to the
  `allowed` list in `admin_restore_rows()` (`30-safety.sql`), or list it as
  excluded (with a reason) in `scripts/check-backup-coverage.js`. The coverage
  check names any table that is in neither place.
- Backup deliberately includes `admin_users` and `audit_log` for the record but
  **never restores them** (restoring role rows could grant admin access, and the
  activity log must not be rewritable). The private anti-spam tables
  (`rate_limit_secret`, `rate_limit_hits`, `order_upload_folders`) are not backed up.
