# Household board (chores/tasks + projects)

One app with three views:

- **Today:** what needs attention across both boards. Overdue, due this week, projects gone quiet, coming up in the next 30 days, and projects in progress.
- **Chores/Tasks:** anything that fits on a single card, one-off or recurring, on a To do / Doing / Done board.
- **Projects:** bigger efforts with multiple steps (Ideas / Planned / In progress / Waiting on someone / Done), each with a checklist and an updates log.

Two sets of filter chips apply to every view and combine with each other:

- **All / Family / Personal:** what the item is for. *Family* affects the household (repainting the house); *Personal* is one person's own business (a doctor's appointment). This is a label for filtering, **not** a privacy setting: everyone can still see everything. New items default to Family, or to Personal while the Personal filter is on.
- **Everyone / Mine / each person / Unassigned:** who it's assigned to. Items can have **several owners**; a shared item shows up under each of its owners.

On cards, owners appear as colored dots with names (up to two; beyond that "Rick +2"), and the card's left edge has one colored stripe per owner. Personal items show a small "Personal" tag. Recurring chores/tasks have the flag too, and the cards they create inherit it.

Runs on Cloudflare Workers with a D1 database. There's no login. The app only opens at a secret link, `https://chores.<your-subdomain>.workers.dev/k/<APP_KEY>/`, where `APP_KEY` is a long random string kept as a Cloudflare secret. Any other address, including the bare one, shows "Not found".

Anyone who has the link can use the app, so share it only within the family. If it ever gets out, change `APP_KEY` (see below) and the old link stops working.

Each phone asks **"Who's using this phone?"** once and remembers the answer. That drives the "Mine" filter and the names in the history. It's not security: anyone with the link is trusted. On iPhone, a home-screen app keeps its own storage, so it asks once more there. Change it any time at the bottom of Settings.

## Deadlines and "gone quiet"

- Due dates show as relative time ("Due in 5 days", "2 days late"). Color only appears close to the date: amber within 3 days, red when late.
- Projects track **last activity**: any update note, checklist tick, column move or edit. After 2 weeks with no activity a project gets a "Quiet" tag and appears under *Gone quiet* on Today. After 6 weeks the card also fades. Posting an update (even "waiting until spring") clears it.
- Reordering cards within a column doesn't count as activity.

## How it works

- **Columns** for each board are editable in Settings. The **last column is always Done**. Done chores leave the board after 7 days, done projects after 30 (hidden, not erased).
- **Moving cards:** drag on an iPad or computer. On a phone, tap a card and choose a column, or tap the circle to mark it done.
- **Recurring chores/tasks** (↻ on the Chores/Tasks tab) add a card when due, either on a fixed schedule or N days after the last one was done. No duplicates if the previous card is still open.
- Nothing runs on a timer. Due cards are created whenever someone opens the app.
- The app refreshes every 30 seconds and whenever you return to it.

## One-time setup (all in the browser)

1. **Deploy:** Cloudflare dashboard → Workers & Pages → Create → Import a repository → pick this repo → Deploy.
2. **Make a key:** any random string of at least 24 letters and numbers (e.g. `openssl rand -hex 16`, or a password manager's generator set to letters and numbers). Use a different key from the allowance app.
3. **Save it as a secret:** open the `chores` Worker → Settings → Variables and Secrets → Add. Type: **Secret**, name: `APP_KEY`, value: your key. It must be the Secret type: plain variables get replaced on the next deploy from GitHub, secrets don't.
4. **Open** `https://chores.<your-subdomain>.workers.dev/k/<your key>/`, enter the household names (first run only), and pick who's using the phone.
5. **Add to home screen** from that page (iPhone: Share → Add to Home Screen). The icon keeps the secret link.

If the app says "This app is locked," the `APP_KEY` secret isn't set (or is shorter than 24 characters).

### Changing the key

Edit `APP_KEY` in Variables and Secrets. The old link and old home-screen icons stop working right away. Delete the old icons, open the new link, and add it to the home screen again. Nothing in the database changes.

### Moving over from the old Cloudflare Access login

Once the secret link works, open the Worker → **Access** tab and remove the Access protection. History written under the old login still shows the right names (via the email stored on each person from the old "This is me" setting).

## Files

- `src/index.js`: the server (API, database, migrations, recurring logic)
- `src/recur.js`: date math for recurring schedules
- `src/page.html`: the app (served only at the secret link)
- `public/`: icons and `Sortable.min.js` (drag-and-drop library, SortableJS, MIT license). Public and harmless.

## Changing the database later

Schema changes go in the `MIGRATIONS` list in `src/index.js`. Add a new entry at the end and never edit old ones. Each runs once, automatically, on the first request after deploy. Migrations 2 (projects), 3 (family/personal flag) and 4 (multiple owners) only add tables and columns; existing data is untouched. Migration 4 copies each item's single owner into the new `task_people` / `recurrence_people` tables; `tasks.person_id` is kept equal to the first owner so an older version of the app would still work if ever rolled back. Internally, chores/tasks are still stored with category `chore`.

## Backup

`npx wrangler d1 export chores --remote --output backup.sql`
