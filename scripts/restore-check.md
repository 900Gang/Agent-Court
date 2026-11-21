# Restore drill (N10, AC-1008)

A backup that has never been restored is a hope, not a backup. This drill proves that the production database can be
brought back to an earlier moment, and that what comes back passes the same role audit as the live one. Do it once before
launch, and again after any change of plan or provider. About 30 minutes.

You need: the production Neon project on a paid plan, its owner connection string (`DATABASE_URL_DIRECT`) and the
application one (`DATABASE_URL`), and this repository checked out on your machine. Nothing in the drill changes the live
production data. It reads from a branch that Neon makes from the past, and you delete that branch at the end.

Never paste a connection string, a password or a key into chat, a ticket or the runbook. The runbook records the date and
the result only.

## 1. Check the retention

In the Neon console, open the production project's settings and read how far back the plan can restore (the history
retention window). Write it down. It must be at least as long as you want to be able to go back, and at least 24 hours
for this drill. If it is shorter, change the plan before you go on.

## 2. Note the moment and the numbers

Pick a moment a few minutes in the past and write down the time in UTC. Then, on the **live** production database
(Neon's SQL editor, as the owner role), run this and write down the three numbers:

```sql
select
  (select count(*) from operators) as operators,
  (select count(*) from cases)     as cases,
  (select count(*) from audit_log) as audit_rows;
```

Wait a few minutes. Make no other change. The numbers must still be the same when you are ready for step 3. (If the court
is live and busy, they will have grown. Then use the numbers from the moment you picked, which step 4 compares against, and
expect the live ones to be higher.)

## 3. Restore to a branch

In the Neon console, create a new branch of the production project from a **past point in time**: the moment you noted in
step 2. Call it `restore-drill-<yyyy-mm-dd>`. (The exact menu names change from time to time. What you need is a branch that
holds the data as it was at that moment, not a copy of today's data.) Wait until the branch is ready. Open its connection
details and copy the owner and the application connection strings for **this branch**.

## 4. Check what came back

On the branch, as the owner role, run the query from step 2 again.

- The three numbers must equal the numbers you wrote down for that moment. If they do not, stop: the restore is not what you
  asked for. Note what you saw (numbers only) and see "If it fails" below.

Then run the role audit against the branch from your machine, with the branch's two strings in the environment of this shell
only (never in `.env.local` and never committed):

```bash
DATABASE_URL="<branch application string>" DATABASE_URL_DIRECT="<branch owner string>" pnpm db:live-check
```

- Every check must say PASS, and the last line must say `All 11 checks passed.` Row-level security forced on every table,
  nothing granted to PUBLIC, the application role unable to change the audit log: all of it must hold on restored data too.

## 5. Delete the branch

Delete `restore-drill-<yyyy-mm-dd>` in the Neon console. Check the project's branch list: only the branches you expect are
left. A forgotten branch keeps costing money and holds a copy of production data.

## 6. Record it

Add one dated line to the "Records" table of the runbook (`docs/runbook.md`): the date, who did it, the retention window you
read, and PASS (or what failed). A step with no dated line is not done.

## If it fails

- **The numbers differ.** The branch was made from the wrong moment, or the retention window does not reach that far. Delete
  the branch, check the window (step 1), and try again with a moment that is well inside it.
- **A role audit check fails.** Do not use that restore for anything. Compare with the live database by running
  `pnpm db:live-check` against production itself. If production passes and the branch fails, the restore has dropped
  something (for example the application role or a policy). That is a finding: write it in the runbook, raise it with Neon
  support, and do not call the drill done.
- **You cannot make a branch from the past at all.** The plan does not include point-in-time restore. Production is not
  ready to launch until it does (plan section 4.2).
