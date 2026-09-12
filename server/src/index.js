import env from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { createApp } from './app.js';
import { attachCollabServer } from './collab/index.js';
import { sweepTrashOnBoot } from './services/trash.service.js';
import { sweepBookingReminders } from './services/booking-reminders.service.js';
import { sweepRecurringEngagements } from './services/recurrence-reminders.service.js';
import { buildLabel } from './utils/build-info.js';
import { migrateApprovalsOnBoot } from './services/approvals-migration.service.js';
import { backfillApprovals } from './services/account-approval.service.js';
import { renameFinanceRoleToSales } from './services/role-rename.service.js';
import { backfillTemplatePurpose } from './services/template-purpose.service.js';
import { backfillRoles } from './services/roles-migration.service.js';
import { backfillLibrarySnippets } from './services/library-migration.service.js';
import { backfillRedTeamKind } from './services/redteam-kind.service.js';
import {
  moveEnumerationText,
  repairContentFlags,
} from './services/enumeration-move.service.js';
import { installNotificationMail } from './services/notification-mail.service.js';
import { installWebhooks } from './services/webhooks/index.js';
import { installRenderQueue } from './services/render-queue.service.js';
import { backfillNotificationExpiry } from './services/notification-expiry.service.js';
import { log } from './utils/logger.js';

async function main() {
  await connectDatabase();

  /*
   * Notifications can now leave the building as mail.
   *
   * Installed here rather than at import time so that a script which pulls in the models to read
   * data — the seeder, a migration, the template linter — does not acquire a mail sender by
   * accident. It does nothing until an administrator configures a server under Settings → Email.
   */
  installNotificationMail();
  /*
   * Beside the mail for the same reason: both listen to something the app writes anyway, and both
   * are a line somebody can find rather than a side effect of an import.
   */
  installWebhooks();
  /*
   * And the report worker, which is the third of these and the only one that does work rather than
   * listens for it.
   *
   * Here rather than at import time so the seeder and the migrations do not acquire a background
   * renderer, and here rather than lazily so that jobs left `running` by a process that died are
   * put back in the queue at the one moment it is safe to assume nobody is working on them.
   */
  installRenderQueue();

  // Before the first request, not alongside it: an engagement whose approvals are
  // still bare user ids cannot be hydrated, so this is a load-bearing migration
  // rather than housekeeping.
  await migrateApprovalsOnBoot();

  /*
   * Also load-bearing, and for the same reason: accounts now need an administrator's
   * approval before they can hold a session, and every account that predates the field
   * has none. Without this an instance that worked a minute ago would lock out its own
   * admin — so it runs before the first request rather than in a script somebody has to
   * remember. The filter matches nothing once it has run.
   */
  await backfillApprovals();

  /*
   * The Sales section was called Financial for one commit. An account created under the
   * old spelling holds a role that is no longer in the enum, which leaves it confined by
   * the API gate *and* refused by the Sales router — locked out of everything. One
   * `updateMany` that matches nothing on every boot after the first.
   */
  await renameFinanceRoleToSales();

  /*
   * And the third of the same kind: templates uploaded before they had a `purpose` have no such
   * field, so a query for report templates skipped them — which took somebody's only report
   * template out of the engagement picker. A default fills in new documents and never old ones.
   */
  await backfillTemplatePurpose();

  /*
   * And the fourth. An account holds a list of roles now rather than one, and a schema change
   * describes new documents only — without this every existing account would have no `roles`
   * array and the instance would find itself with no administrators.
   */
  await backfillRoles();

  /*
   * And the fifth. The seed upserts with `$setOnInsert` so it can never overwrite a firm's edits,
   * which means a field added to a seeded row later never reaches an install that already had it:
   * the "Red Team Engagement" type on any existing instance carries no kind, so choosing it built
   * a standard engagement and the Enumeration tab never appeared. Matches nothing after the first
   * boot.
   */
  await backfillRedTeamKind();

  /*
   * Enumeration text out of the engagement documents that still hold it inline.
   *
   * A step could carry 400KB of output and write-up inside a document MongoDB caps at 16MB, which
   * is a wall at about forty steps — and the wall shows up as a save being refused mid-operation,
   * not as a slow page. Matches nothing once an install has been through it.
   */
  await moveEnumerationText();

  /*
   * And steps whose write-up is a screenshot with no words round it. The old rule called those
   * empty, so a template's `{{#hasContent}}` skipped them and the picture never reached the report.
   * Matches nothing once an install has been through it.
   */
  await repairContentFlags();

  /*
   * And notifications written before they had an expiry.
   *
   * A TTL index skips documents with no such field, so without this the collection would keep
   * growing on exactly the installs that have most to clear. Matches nothing after the first boot.
   */
  await backfillNotificationExpiry();

  /*
   * And library entries written before a list had a line to draw under each title.
   *
   * The snippet is stored because deriving one per request measured at over a second on a
   * five-hundred-entry library — see `library-payload.service.js`. Stored means every entry
   * already here has none, and would list with a blank line that reads exactly like a description
   * nobody wrote. The only migration of the set that cannot be a pipeline: HTML becomes text in
   * Node, not in Mongo. Matches nothing after the first boot.
   */
  await backfillLibrarySnippets();

  const app = createApp();
  const server = app.listen(env.port, () => {
    log.info(`Engy Report API listening on http://localhost:${env.port}/api`);
      // Said at boot, so a log tells you which code produced the lines under it.
      log.info(`Build ${buildLabel()} on Node ${process.versions.node}`);
    log.info(`Allowed origins: ${env.corsOrigin.join(', ')}`);
    if (
      env.jwt.accessSecret.startsWith('dev-only') ||
      env.jwt.refreshSecret.startsWith('dev-only')
    ) {
      log.warn('JWT secrets are still the development defaults — set them in .env before deploying.');
    }
    // Housekeeping, not part of startup: the trash empties itself even on an
    // instance nobody has set a scheduled task up for.
    void sweepTrashOnBoot();

    /*
     * Booking reminders, on boot and then daily.
     *
     * A timer as well as the boot sweep because this instance runs for days at a time, and a
     * reminder that only fires when somebody restarts the server is not a reminder. `unref` so
     * it never holds the process open on shutdown, and the sweep is idempotent, so a machine
     * that boots twice in a morning does not send twice.
     */
    void sweepBookingReminders();
    const DAY_MS = 24 * 60 * 60 * 1000;
    setInterval(() => void sweepBookingReminders(), DAY_MS).unref();

    /*
     * And the work that comes round again, on the same rhythm and for the same reason: a
     * reminder that only fires when somebody restarts the server is not a reminder.
     */
    void sweepRecurringEngagements();
    setInterval(() => void sweepRecurringEngagements(), DAY_MS).unref();
  });
  /*
   * Collaborative editing, on the same server and the same origin.
   *
   * Attached before anybody can connect rather than inside the listen callback: an upgrade can
   * arrive on the first tick after the port is open, and a handler added a moment later would
   * refuse it. Nothing here starts a second listener — see `collab/index.js`.
   */
  attachCollabServer(server);


  // Without this, a busy port surfaces as an unhandled 'error' event and a raw
  // stack trace, which buries the one thing worth knowing.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`Port ${env.port} is already in use — another copy of the server is running.`);
      log.error(`Find it:  netstat -ano | findstr :${env.port}`);
      log.error('Stop that process, or set a different PORT in .env.');
    } else if (err.code === 'EACCES') {
      log.error(`Not allowed to bind port ${env.port}. Ports below 1024 need elevation.`);
    } else {
      log.error(`Could not start the server: ${err.message}`);
    }
    process.exit(1);
  });

  const shutdown = async (signal) => {
    log.info(`${signal} received, shutting down`);
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    // Don't hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 8000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection:', reason));
}

main().catch((err) => {
  log.error('Failed to start:', err.message);
  process.exit(1);
});
