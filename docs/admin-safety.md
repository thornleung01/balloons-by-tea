# Admin safety and access

Everything here lives in the admin page (`admin.html`) and in one database update,
`supabase-migrations/30-safety.sql`. The admin keeps working without the update; the new
parts just say "run 30-safety.sql" until you do.

## One-time setup

1. Open Supabase, then **SQL Editor, New query**.
2. Paste the whole of `supabase-migrations/30-safety.sql` and press **Run**. It is safe to
   run again later and it never deletes or changes your shop data.
3. Nothing else is needed. The original admin account (`amandatea02@outlook.com`) is an
   **owner** automatically, and stays one forever.
4. For "Forgot password?" to work, in Supabase go to **Authentication, URL Configuration**
   and add the address of your admin page (for example `https://yoursite.com/admin.html`)
   under **Redirect URLs**.

## Backups and restoring

**Settings, bottom of the page.**

- The Backup card shows **Last backup: N days ago**. If it has been more than 14 days (or
  never), a red reminder appears there and as a banner at the top of the admin. Dismiss
  the banner and it stays away until you reopen the admin in a new browser session.
- **Download backup** saves one `.json` file with all your data and a list of your photos.
  Photo files themselves are not inside the file.
- **Restore from backup...** (owners only):
  1. Pick a backup file. It is checked first; a file that isn't a backup, is damaged, or
     is from a newer admin is refused.
  2. You see, for each table, how many rows are in the file, how many are on the site
     now, how many would be **added**, how many would **change**, and how many are
     **only on the site**.
  3. Tick the tables you want. Analytics and layout history start unticked.
  4. Choose a mode:
     - **Merge** adds missing rows and overwrites rows that differ. Nothing is deleted.
       Newer rows that aren't in the backup are kept. This is the safe choice.
     - **Replace** does the same and then also deletes the "only on site" rows so the
       tables match the file exactly.
  5. Type `RESTORE` and press **Restore now**.
  6. Before anything is touched, a fresh backup of what you have now is downloaded
     (`balloons-by-tea-BEFORE-RESTORE-...json`). If that can't be completed, the restore
     does not start.
  7. When it finishes you get a summary (added / changed / already right / deleted per
     table) and a list of **photos that the restored data points to but that are no longer
     in storage**. Re-upload those in the Library.

Restored rows keep their original ids, so links between things (like a gallery photo's
product) still line up. Every restored row also appears in the Activity tab, marked
"(restore from backup)".

## Activity tab (owners only)

A readable history of every change: "Tea changed price of 'Gold Arch' from $120 to $140".
Filter by area, kind of change, person and dates; click an entry for the exact
before/after. Edits and deletes of a single item have an **Undo** button (it warns you if
that value was changed again since). Deleting something always gets logged, even if it was
done outside the admin page. New orders from customers are not logged; changes you make to
an order are.

At the bottom, **Delete old activity** tidies entries older than 90 days to 2 years.

## Logging in

- **Forgot password?** on the login screen emails you a link. It opens the admin page on a
  "choose a new password" screen. A strength hint helps you pick a good one.
- **2-step login** (Settings, Security card): turn it on, scan the QR code with an
  authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy),
  type the 6-digit code. From then on login asks for the code after your password, and
  the database itself refuses an account that hasn't entered its code. You can turn it
  off from the same card. **If you lose your phone** and can't get a code: in Supabase,
  Authentication, Users, open your user and delete the authenticator factor, then log in
  with your password and set it up again.
- **Log out other devices** (Settings, Security): ends every other session, for a lost
  phone or a shared computer. Other devices drop out within about an hour.

## Team: giving someone a staff login

Roles:

| | Owner | Staff |
|---|---|---|
| See products and orders | yes | yes |
| Change an order's status, notes, payment | yes | yes |
| Delete anything | yes | no |
| Edit products, categories, nav, FAQ, photos, settings, delivery | yes | no |
| See Activity, Backup, Team | yes | no |

To add someone:

1. In Supabase: **Authentication, Users, Add user** (or **Invite user**). Enter their
   email and a password (or let them set it from the invite).
2. In the admin: **Settings, Team, Add someone**. Type the same email, choose **Staff**
   (or **Owner**), press **Add to team**.
3. They log in on the admin page. They only see Overview, Orders and a read-only Products
   list.

Change a role or remove someone from the same card. Removing only takes away admin access;
their login still exists in Supabase. The original account can't be demoted or removed,
and the last owner can't be removed.

Staff limits are enforced by the database, not just hidden buttons.

## What can go wrong

- **"Run supabase-migrations/30-safety.sql"** messages: the update hasn't been run yet.
- **Locked out after turning on 2-step login on a new phone**: see the lost phone steps
  above.
- **Restore says a table isn't set up**: that table doesn't exist on this site yet, so it is
  skipped.
