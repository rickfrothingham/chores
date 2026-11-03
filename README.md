# Household board (chores + projects)

One app with three views:

- **Today:** what needs attention across both boards. Overdue, due this week, projects gone quiet, coming up in the next 30 days, and projects in progress.
- **Chores:** small, often recurring tasks on a To do / Doing / Done board.
- **Projects:** bigger one-off efforts (Ideas / Planned / In progress / Waiting on someone / Done), each with a checklist and an updates log.

The person chips (Everyone / Mine / each person / Unassigned) filter every view.

Runs on Cloudflare Workers with a D1 database. Login is handled by Cloudflare Access.

## Deadlines and "gone quiet"

- Due dates show as relative time ("Due in 5 days", "2 days late"). Color only appears close to the date: amber within 3 days, red when late.
- Projects track **last activity**: any update note, checklist tick, column move or edit. After 2 weeks with no activity a project gets a "Quiet" tag and appears under *Gone quiet* on Today. After 6 weeks the card also fades. Posting an update (even "waiting until spring") clears it.
- Reordering cards within a column doesn't count as activity.

## How it works

- **Columns** for each board are editable in Settings. The **last column is always Done**. Done chores leave the board after 7 days, done projects after 30 (hidden, not erased).
- **Moving cards:** drag on an iPad or computer. On a phone, tap a card and choose a column, or tap the circle to mark it done.
- **Recurring chores** (↻ on the Chores tab) add a card when due, either on a fixed schedule or N days after the last one was done. No duplicates if the previous card is still open.
- Nothing runs on a timer. Due cards are created whenever someone opens the app.
- The app refreshes every 30 seconds and whenever you return to it.

## One-time setup (all in the browser)

1. **Deploy:** Cloudflare dashboard → Workers & Pages → Create → Import a repository → pick this repo → Deploy.
2. **Login:** open the `chores` Worker → **Access** tab → Protect this Worker behind Access → Scope: All traffic → Policy: **Family** → Save.
3. Open `https://chores.<your-subdomain>.workers.dev`, sign in, and enter the household names. Everyone else taps "This is me" in Settings to turn on the "Mine" filter.

## Files

- `src/index.js`: the server (API, database, migrations, recurring logic)
- `src/recur.js`: date math for recurring schedules
- `public/index.html`: the app
- `public/Sortable.min.js`: drag-and-drop library (SortableJS, MIT license)

## Changing the database later

Schema changes go in the `MIGRATIONS` list in `src/index.js`. Add a new entry at the end and never edit old ones. Each runs once, automatically, on the first request after deploy. Migration 2 (projects) only adds tables and columns; existing chore data is untouched.

## Backup

`npx wrangler d1 export chores --remote --output backup.sql`
