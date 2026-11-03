# Chores

A household chore board: cards in columns, assigned to people, with recurring tasks that add themselves.

Runs on Cloudflare Workers with a D1 database. Login is handled by Cloudflare Access.

## How it works

- **Columns** are editable in Settings. The **last column is always Done**. Cards there leave the board after 7 days (they're hidden, not erased).
- **Moving cards:** drag between columns on an iPad or computer. On a phone, tap a card and choose a column, or tap the circle to mark it done.
- **Recurring tasks** (the ↻ button) add a card to the first column when they come due:
  - *On a schedule:* daily, weekly on chosen days, or monthly on a date, every N days/weeks/months.
  - *Some days after it's done:* the next card appears N days after the last one is completed. Deleting the card counts as skipping it.
  - If the previous card is still open when the next one is due, no duplicate is added. The existing card just shows as overdue.
- Nothing runs on a timer. Due cards are created whenever someone opens the board.
- The board refreshes every 30 seconds and whenever you come back to it, so changes from the other phone show up.

## One-time setup (all in the browser)

1. **Deploy:** Cloudflare dashboard → Workers & Pages → Create → Import a repository → pick this repo → Deploy.
2. **Login:** open the `chores` Worker → **Access** tab → Protect this Worker behind Access → Scope: All traffic → Policy: **Family** → Save.
3. Open `https://chores.<your-subdomain>.workers.dev`, sign in, and enter the household names. Whoever sets it up is linked to the first name. Everyone else taps "This is me" in Settings to turn on the "Mine" filter.

## Files

- `src/index.js`: the server (API, database, recurring-task logic)
- `src/recur.js`: date math for recurring schedules
- `public/index.html`: the board
- `public/Sortable.min.js`: drag-and-drop library (SortableJS, MIT license)

## Changing the database later

Schema changes go in the `MIGRATIONS` list in `src/index.js`. Add a new entry at the end and never edit old ones. Each runs once, automatically, on the next request after deploy.

## Backup

`npx wrangler d1 export chores --remote --output backup.sql`
