// Household chore board: the server side.
//
// Data:
//   columns      board columns, left to right. The LAST column is always "Done".
//   people       who cards can be assigned to. `email` links a person to a login.
//   tasks        the cards.
//   recurrences  templates that create cards on a schedule.
//
// Like the allowance app, nothing runs on a timer: whenever someone loads the
// board, the server creates any recurring cards that have come due, and tidies
// away cards that have sat in Done for more than 7 days.
//
// Login is Cloudflare Access (header `cf-access-authenticated-user-email`).
// Without that header every request is refused.

import { Hono } from 'hono';
import { addDays, describe, isYmd, nextOccurrence, todayIn } from './recur.js';

const app = new Hono();
const DONE_DAYS_VISIBLE = 7;
const COLORS = ['#2f7d6d', '#c0613a', '#6a5acd', '#b8860b', '#2b6cb0', '#b83280', '#4a7c2b', '#7a5c45'];

// ---------- Database schema, applied in numbered steps ----------
// To change the schema later, ADD a new entry to the end of this list. Never
// edit an entry that has already been deployed.
const MIGRATIONS = [
  [
    `CREATE TABLE IF NOT EXISTS columns (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       position INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS people (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       color TEXT NOT NULL,
       email TEXT,
       position INTEGER NOT NULL,
       deleted_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS recurrences (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       title TEXT NOT NULL,
       notes TEXT NOT NULL DEFAULT '',
       person_id INTEGER,
       mode TEXT NOT NULL,            -- 'schedule' or 'after_done'
       freq TEXT,                     -- schedule: 'daily' | 'weekly' | 'monthly'
       every INTEGER,                 -- schedule: every N days/weeks/months
       weekdays TEXT,                 -- schedule weekly: e.g. '1,4' (Mon, Thu)
       month_day INTEGER,             -- schedule monthly: 1-31
       anchor TEXT,                   -- schedule: first possible date
       interval_days INTEGER,         -- after_done: days after completion
       next_date TEXT,                -- next date a card is due to appear
       paused INTEGER NOT NULL DEFAULT 0,
       created_by TEXT,
       created_at TEXT NOT NULL,
       deleted_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS tasks (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       title TEXT NOT NULL,
       notes TEXT NOT NULL DEFAULT '',
       column_id INTEGER NOT NULL,
       person_id INTEGER,
       position REAL NOT NULL,
       due_date TEXT,
       recurrence_id INTEGER,
       created_by TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       done_at TEXT,
       archived_at TEXT,              -- set after 7 days in Done (hidden, kept)
       deleted_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS tasks_open ON tasks(column_id) WHERE deleted_at IS NULL AND archived_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS tasks_by_recurrence ON tasks(recurrence_id) WHERE deleted_at IS NULL AND archived_at IS NULL`,
  ],
];

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) schemaReady = migrate(db).catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}
async function migrate(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first();
  let version = row ? parseInt(row.value, 10) : 0;
  for (; version < MIGRATIONS.length; version++) {
    const stmts = MIGRATIONS[version].map((s) => db.prepare(s));
    stmts.push(
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(String(version + 1))
    );
    await db.batch(stmts);
  }
}

// ---------- Helpers ----------

const now = () => new Date().toISOString();
const tz = (c) => c.env.TIMEZONE || 'America/New_York';
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const intOrNull = (v) => (v === null || v === undefined || v === '' ? null : parseInt(v, 10));
const bad = (c, msg) => c.json({ error: msg }, 400);

async function getColumns(db) {
  const { results } = await db.prepare('SELECT id, name, position FROM columns ORDER BY position, id').all();
  return results;
}
const doneColumnId = (cols) => (cols.length ? cols[cols.length - 1].id : null);

function ruleOf(r) {
  return {
    mode: r.mode,
    freq: r.freq,
    every: r.every,
    weekdays: r.weekdays ? r.weekdays.split(',').map(Number) : [],
    month_day: r.month_day,
    anchor: r.anchor,
    interval_days: r.interval_days,
  };
}

// Is there already an open (not done, not removed) card from this recurrence?
async function hasOpenCard(db, recurrenceId, doneId) {
  const row = await db
    .prepare(
      `SELECT 1 FROM tasks WHERE recurrence_id = ? AND column_id != ?
          AND deleted_at IS NULL AND archived_at IS NULL LIMIT 1`
    )
    .bind(recurrenceId, doneId)
    .first();
  return !!row;
}

async function endPosition(db, columnId) {
  const row = await db
    .prepare('SELECT MAX(position) AS p FROM tasks WHERE column_id = ? AND deleted_at IS NULL AND archived_at IS NULL')
    .bind(columnId)
    .first();
  return (row && row.p != null ? row.p : 0) + 1;
}

// Create recurring cards that have come due, and archive old Done cards.
async function housekeeping(db, today) {
  const cols = await getColumns(db);
  if (cols.length < 2) return;
  const firstId = cols[0].id, doneId = doneColumnId(cols);

  const { results: recs } = await db
    .prepare('SELECT * FROM recurrences WHERE deleted_at IS NULL AND paused = 0 AND next_date IS NOT NULL AND next_date <= ?')
    .bind(today)
    .all();

  for (const r of recs) {
    const rule = ruleOf(r);
    let due = r.next_date, next = null;

    if (r.mode === 'schedule') {
      // Skip forward to the most recent occurrence; never create a backlog.
      let d = r.next_date;
      for (let i = 0; d && d <= today && i < 5000; i++) { due = d; d = nextOccurrence(rule, d); }
      next = d;
    }
    // after_done: next_date stays empty until this card is completed.

    const stmts = [db.prepare('UPDATE recurrences SET next_date = ? WHERE id = ?').bind(next, r.id)];
    if (!(await hasOpenCard(db, r.id, doneId))) {
      const ts = now();
      stmts.push(
        db.prepare(
          `INSERT INTO tasks (title, notes, column_id, person_id, position, due_date, recurrence_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'automatic', ?, ?)`
        ).bind(r.title, r.notes, firstId, r.person_id, await endPosition(db, firstId), due, r.id, ts, ts)
      );
    }
    await db.batch(stmts);
  }

  const cutoff = new Date(Date.now() - DONE_DAYS_VISIBLE * 86400000).toISOString();
  await db
    .prepare('UPDATE tasks SET archived_at = ? WHERE column_id = ? AND done_at IS NOT NULL AND done_at < ? AND archived_at IS NULL')
    .bind(now(), doneId, cutoff)
    .run();
}

// When a card lands in (or leaves) Done.
async function onCompleted(db, task, today) {
  if (!task.recurrence_id) return;
  const r = await db.prepare('SELECT * FROM recurrences WHERE id = ?').bind(task.recurrence_id).first();
  if (r && r.mode === 'after_done' && !r.deleted_at) {
    await db.prepare('UPDATE recurrences SET next_date = ? WHERE id = ?').bind(addDays(today, r.interval_days), r.id).run();
  }
}

// ---------- Middleware ----------

app.use('/api/*', async (c, next) => {
  let email = c.req.header('cf-access-authenticated-user-email');
  if (!email && c.env.DEV_USER) email = c.env.DEV_USER; // local testing only (.dev.vars)
  if (!email) {
    return c.json({ error: 'not_signed_in', message: 'Login is not set up yet. Turn on Cloudflare Access for this app, then reload.' }, 401);
  }
  c.set('email', email.toLowerCase());
  await ensureSchema(c.env.DB);
  await next();
});

// ---------- Board state ----------

app.get('/api/state', async (c) => {
  const db = c.env.DB;
  const today = todayIn(tz(c));
  await housekeeping(db, today);

  const [cols, people, tasks, recs] = await Promise.all([
    getColumns(db),
    db.prepare('SELECT id, name, color, email FROM people WHERE deleted_at IS NULL ORDER BY position, id').all(),
    db.prepare(
      `SELECT id, title, notes, column_id, person_id, position, due_date, recurrence_id, created_by, created_at, done_at
         FROM tasks WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY position, id`
    ).all(),
    db.prepare('SELECT * FROM recurrences WHERE deleted_at IS NULL ORDER BY title').all(),
  ]);

  const email = c.get('email');
  const me = people.results.find((p) => p.email === email);
  return c.json({
    today,
    setup_done: cols.length > 0,
    me: { email, person_id: me ? me.id : null },
    columns: cols,
    done_column_id: doneColumnId(cols),
    people: people.results,
    tasks: tasks.results,
    recurrences: recs.results.map((r) => ({
      id: r.id, title: r.title, notes: r.notes, person_id: r.person_id, mode: r.mode,
      freq: r.freq, every: r.every, weekdays: ruleOf(r).weekdays, month_day: r.month_day,
      anchor: r.anchor, interval_days: r.interval_days, next_date: r.next_date, paused: !!r.paused,
      description: describe(ruleOf(r)),
    })),
  });
});

// First run: create default columns and the household members.
app.post('/api/setup', async (c) => {
  const db = c.env.DB;
  if ((await getColumns(db)).length) return c.json({ error: 'Already set up.' }, 409);
  const body = await c.req.json();
  const names = (body.people || []).map((p) => str(p.name, 30)).filter(Boolean);
  if (!names.length) return bad(c, 'Add at least one person.');

  const stmts = ['To do', 'Doing', 'Done'].map((n, i) =>
    db.prepare('INSERT INTO columns (name, position) VALUES (?, ?)').bind(n, i)
  );
  names.forEach((n, i) => {
    const email = i === 0 ? c.get('email') : null; // the first person is whoever is setting up
    stmts.push(db.prepare('INSERT INTO people (name, color, email, position) VALUES (?, ?, ?, ?)').bind(n, COLORS[i % COLORS.length], email, i));
  });
  await db.batch(stmts);
  return c.json({ ok: true });
});

// ---------- Tasks ----------

app.post('/api/tasks', async (c) => {
  const db = c.env.DB;
  const b = await c.req.json();
  const title = str(b.title, 120);
  if (!title) return bad(c, 'Give the task a name.');
  const cols = await getColumns(db);
  const columnId = cols.some((x) => x.id === b.column_id) ? b.column_id : cols[0].id;
  if (b.due_date && !isYmd(b.due_date)) return bad(c, 'Bad due date.');
  const ts = now();
  const doneId = doneColumnId(cols);
  await db
    .prepare(
      `INSERT INTO tasks (title, notes, column_id, person_id, position, due_date, created_by, created_at, updated_at, done_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(title, str(b.notes, 1000), columnId, intOrNull(b.person_id), await endPosition(db, columnId),
      b.due_date || null, c.get('email'), ts, ts, columnId === doneId ? ts : null)
    .run();
  return c.json({ ok: true });
});

app.patch('/api/tasks/:id', async (c) => {
  const db = c.env.DB;
  const id = parseInt(c.req.param('id'), 10);
  const task = await db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!task) return c.json({ error: 'That card no longer exists.' }, 404);
  const b = await c.req.json();
  const cols = await getColumns(db);
  const doneId = doneColumnId(cols);

  const sets = [], vals = [];
  const set = (col, v) => { sets.push(col + ' = ?'); vals.push(v); };

  if (b.title !== undefined) { const t = str(b.title, 120); if (!t) return bad(c, 'Give the task a name.'); set('title', t); }
  if (b.notes !== undefined) set('notes', str(b.notes, 1000));
  if (b.person_id !== undefined) set('person_id', intOrNull(b.person_id));
  if (b.due_date !== undefined) {
    if (b.due_date && !isYmd(b.due_date)) return bad(c, 'Bad due date.');
    set('due_date', b.due_date || null);
  }

  let completed = false;
  if (b.column_id !== undefined && b.column_id !== task.column_id) {
    if (!cols.some((x) => x.id === b.column_id)) return bad(c, 'Unknown column.');
    set('column_id', b.column_id);
    if (b.column_id === doneId) { set('done_at', now()); completed = true; }
    else if (task.column_id === doneId) set('done_at', null);
    if (b.position === undefined) set('position', await endPosition(db, b.column_id));
  }
  if (b.position !== undefined) {
    const p = Number(b.position);
    if (!Number.isFinite(p)) return bad(c, 'Bad position.');
    set('position', p);
  }
  if (!sets.length) return c.json({ ok: true });
  set('updated_at', now());
  vals.push(id);
  await db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  if (completed) await onCompleted(db, task, todayIn(tz(c)));
  return c.json({ ok: true });
});

// Removing a recurring card counts as "skip this one" for after-done tasks.
app.delete('/api/tasks/:id', async (c) => {
  const db = c.env.DB;
  const id = parseInt(c.req.param('id'), 10);
  const task = await db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!task) return c.json({ ok: true });
  await db.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').bind(now(), id).run();
  const cols = await getColumns(db);
  if (task.column_id !== doneColumnId(cols)) await onCompleted(db, task, todayIn(tz(c)));
  return c.json({ ok: true });
});

// ---------- Columns ----------

app.post('/api/columns', async (c) => {
  const db = c.env.DB;
  const name = str((await c.req.json()).name, 30);
  if (!name) return bad(c, 'Name the column.');
  const cols = await getColumns(db);
  if (cols.length >= 8) return bad(c, 'That’s plenty of columns.');
  // New columns go just before Done, so Done stays last.
  const stmts = [db.prepare('INSERT INTO columns (name, position) VALUES (?, ?)').bind(name, cols.length - 1)];
  stmts.push(db.prepare('UPDATE columns SET position = ? WHERE id = ?').bind(cols.length, doneColumnId(cols)));
  await db.batch(stmts);
  return c.json({ ok: true });
});

app.patch('/api/columns/:id', async (c) => {
  const name = str((await c.req.json()).name, 30);
  if (!name) return bad(c, 'Name the column.');
  await c.env.DB.prepare('UPDATE columns SET name = ? WHERE id = ?').bind(name, parseInt(c.req.param('id'), 10)).run();
  return c.json({ ok: true });
});

app.put('/api/columns/order', async (c) => {
  const db = c.env.DB;
  const ids = (await c.req.json()).ids;
  const cols = await getColumns(db);
  if (!Array.isArray(ids) || ids.length !== cols.length || !cols.every((x) => ids.includes(x.id)))
    return bad(c, 'Column list is out of date. Reload and try again.');
  const oldDone = doneColumnId(cols), newDone = ids[ids.length - 1];
  const stmts = ids.map((id, i) => db.prepare('UPDATE columns SET position = ? WHERE id = ?').bind(i, id));
  if (oldDone !== newDone) {
    // Keep "done" bookkeeping consistent with whichever column is now last.
    stmts.push(db.prepare('UPDATE tasks SET done_at = NULL WHERE column_id = ?').bind(oldDone));
    stmts.push(db.prepare('UPDATE tasks SET done_at = ? WHERE column_id = ? AND done_at IS NULL').bind(now(), newDone));
  }
  await db.batch(stmts);
  return c.json({ ok: true });
});

app.delete('/api/columns/:id', async (c) => {
  const db = c.env.DB;
  const id = parseInt(c.req.param('id'), 10);
  const cols = await getColumns(db);
  if (cols.length <= 2) return bad(c, 'The board needs at least two columns.');
  if (id === doneColumnId(cols)) return bad(c, 'The last column is Done and can’t be deleted. Reorder first if needed.');
  const used = await db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE column_id = ? AND deleted_at IS NULL AND archived_at IS NULL').bind(id).first();
  if (used.n) return bad(c, 'Move or remove the cards in this column first.');
  await db.prepare('DELETE FROM columns WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// ---------- People ----------

app.post('/api/people', async (c) => {
  const db = c.env.DB;
  const name = str((await c.req.json()).name, 30);
  if (!name) return bad(c, 'Enter a name.');
  const n = await db.prepare('SELECT COUNT(*) AS n FROM people').first();
  await db.prepare('INSERT INTO people (name, color, position) VALUES (?, ?, ?)').bind(name, COLORS[n.n % COLORS.length], n.n).run();
  return c.json({ ok: true });
});

app.patch('/api/people/:id', async (c) => {
  const db = c.env.DB;
  const id = parseInt(c.req.param('id'), 10);
  const b = await c.req.json();
  if (b.name !== undefined) {
    const name = str(b.name, 30);
    if (!name) return bad(c, 'Enter a name.');
    await db.prepare('UPDATE people SET name = ? WHERE id = ?').bind(name, id).run();
  }
  if (b.color !== undefined && /^#[0-9a-f]{6}$/i.test(b.color)) {
    await db.prepare('UPDATE people SET color = ? WHERE id = ?').bind(b.color, id).run();
  }
  if (b.this_is_me) {
    // Link the signed-in login to this person (and unlink it from anyone else).
    const email = c.get('email');
    await db.batch([
      db.prepare('UPDATE people SET email = NULL WHERE email = ?').bind(email),
      db.prepare('UPDATE people SET email = ? WHERE id = ?').bind(email, id),
    ]);
  }
  return c.json({ ok: true });
});

app.delete('/api/people/:id', async (c) => {
  const db = c.env.DB;
  const id = parseInt(c.req.param('id'), 10);
  await db.batch([
    db.prepare('UPDATE people SET deleted_at = ?, email = NULL WHERE id = ?').bind(now(), id),
    db.prepare('UPDATE tasks SET person_id = NULL WHERE person_id = ?').bind(id),
    db.prepare('UPDATE recurrences SET person_id = NULL WHERE person_id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// ---------- Recurring tasks ----------

function parseRecurrence(b, today) {
  const r = { title: str(b.title, 120), notes: str(b.notes, 1000), person_id: intOrNull(b.person_id) };
  if (!r.title) return { error: 'Give the task a name.' };
  if (b.mode === 'after_done') {
    const n = parseInt(b.interval_days, 10);
    if (!(n >= 1 && n <= 3650)) return { error: 'Days must be between 1 and 3650.' };
    Object.assign(r, { mode: 'after_done', interval_days: n, freq: null, every: null, weekdays: null, month_day: null, anchor: null });
    r.first_date = isYmd(b.start_date) ? b.start_date : today;
    return r;
  }
  if (!['daily', 'weekly', 'monthly'].includes(b.freq)) return { error: 'Pick how often.' };
  const every = parseInt(b.every, 10);
  if (!(every >= 1 && every <= 52)) return { error: '“Every” must be between 1 and 52.' };
  const anchor = isYmd(b.start_date) ? b.start_date : today;
  Object.assign(r, { mode: 'schedule', freq: b.freq, every, anchor, interval_days: null, weekdays: null, month_day: null });
  if (b.freq === 'weekly') {
    const days = [...new Set((b.weekdays || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
    if (!days.length) return { error: 'Pick at least one day of the week.' };
    r.weekdays = days.join(',');
  }
  if (b.freq === 'monthly') {
    const d = parseInt(b.month_day, 10);
    if (!(d >= 1 && d <= 31)) return { error: 'Pick a day of the month.' };
    r.month_day = d;
  }
  // First date on or after the start date.
  r.first_date = nextOccurrence(ruleOf({ ...r }), addDays(anchor, -1));
  return r;
}

app.post('/api/recurrences', async (c) => {
  const db = c.env.DB;
  const today = todayIn(tz(c));
  const r = parseRecurrence(await c.req.json(), today);
  if (r.error) return bad(c, r.error);
  await db
    .prepare(
      `INSERT INTO recurrences (title, notes, person_id, mode, freq, every, weekdays, month_day, anchor, interval_days, next_date, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(r.title, r.notes, r.person_id, r.mode, r.freq, r.every, r.weekdays, r.month_day, r.anchor, r.interval_days, r.first_date, c.get('email'), now())
    .run();
  return c.json({ ok: true });
});

app.patch('/api/recurrences/:id', async (c) => {
  const db = c.env.DB;
  const id = parseInt(c.req.param('id'), 10);
  const b = await c.req.json();
  if (b.paused !== undefined && Object.keys(b).length === 1) {
    await db.prepare('UPDATE recurrences SET paused = ? WHERE id = ?').bind(b.paused ? 1 : 0, id).run();
    return c.json({ ok: true });
  }
  const today = todayIn(tz(c));
  const r = parseRecurrence(b, today);
  if (r.error) return bad(c, r.error);
  // Editing restarts the schedule from the given start date.
  // (If an open card exists for an after-done task, the next date waits for it.)
  const existing = await db.prepare('SELECT next_date, mode FROM recurrences WHERE id = ?').bind(id).first();
  let next = r.first_date;
  if (r.mode === 'after_done' && existing && existing.mode === 'after_done' && existing.next_date === null) next = null;
  await db
    .prepare(
      `UPDATE recurrences SET title=?, notes=?, person_id=?, mode=?, freq=?, every=?, weekdays=?, month_day=?, anchor=?, interval_days=?, next_date=?
        WHERE id = ?`
    )
    .bind(r.title, r.notes, r.person_id, r.mode, r.freq, r.every, r.weekdays, r.month_day, r.anchor, r.interval_days, next, id)
    .run();
  return c.json({ ok: true });
});

app.delete('/api/recurrences/:id', async (c) => {
  await c.env.DB.prepare('UPDATE recurrences SET deleted_at = ? WHERE id = ?').bind(now(), parseInt(c.req.param('id'), 10)).run();
  return c.json({ ok: true });
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Something went wrong on the server.' }, 500);
});

export default app;
