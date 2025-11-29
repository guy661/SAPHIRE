// scheduler.mjs
import * as db from './database-postgres.js';
import { startSearchJob } from './job-starter.js';
import { Logger, EMOJIS } from './utils.js';

const schedulerLogger = new Logger('Scheduler', 'yellow', EMOJIS.scheduler);

const CHECK_INTERVAL_MS = 60 * 1000; // Check every 60 seconds

async function checkAndRunScheduledJobs() {
    schedulerLogger.info('Checking for scheduled jobs to run...');
    const dashboards = await db.getAllDashboardsWithInterval();
    
    if (dashboards.length === 0) {
        schedulerLogger.info('No dashboards with active intervals. Standing by.');
        return;
    }

    schedulerLogger.info(`Found ${dashboards.length} dashboards with intervals.`);

    for (const dashboard of dashboards) {
        const dashboardId = dashboard.id;
        schedulerLogger.info(`Checking dashboard #${dashboardId} ("${dashboard.name}")...`);

        // 1. Check if a job is already running for this dashboard
        const activeJob = await db.getActiveJobForDashboard(dashboardId);
        if (activeJob) {
            schedulerLogger.info(`Dashboard #${dashboardId} has an active job (${activeJob.id}). Skipping.`);
            continue;
        }

        // 2. Determine the last event time (either last job completion or when the interval was set)
        const latestJob = await db.getLatestCompletedJobForDashboard(dashboardId);
        const lastEventTime = latestJob ? new Date(latestJob.created_at) : new Date(dashboard.updated_at);
        
        const intervalMillis = dashboard.interval_minutes * 60 * 1000;
        const timeSinceLastEvent = Date.now() - lastEventTime.getTime();

        schedulerLogger.info(`Dashboard #${dashboardId}: ${Math.round(timeSinceLastEvent / 60000)} min passed since last event. Interval is ${dashboard.interval_minutes} min.`);

        // 3. If the interval has passed, start a new job
        if (timeSinceLastEvent >= intervalMillis) {
            schedulerLogger.info(`Dashboard #${dashboardId} is due for a new job. Starting...`);
            try {
                // For scheduled jobs, we assume to use the default search (Google News)
                // and not the custom RSS feeds, as we haven't stored which categories to use.
                // This can be a future enhancement.
                await startSearchJob(dashboard.id, dashboard.user_id, []);
                schedulerLogger.info(`Successfully started a new job for dashboard #${dashboardId}.`);
            } catch (error) {
                schedulerLogger.error(`Failed to start a scheduled job for dashboard #${dashboardId}:`, error);
            }
        } else {
            schedulerLogger.info(`Dashboard #${dashboardId} is not due yet. Skipping.`);
        }
    }
}

function startScheduler() {
    schedulerLogger.info(`Starting scheduler to run every ${CHECK_INTERVAL_MS / 1000} seconds.`);
    
    // Run once on startup, then set the interval
    checkAndRunScheduledJobs().catch(err => schedulerLogger.error("Error during initial scheduler run:", err));
    
    setInterval(() => {
        checkAndRunScheduledJobs().catch(err => schedulerLogger.error("Error during scheduled check:", err));
    }, CHECK_INTERVAL_MS);

    // Graceful shutdown
    const gracefulShutdown = () => {
        schedulerLogger.warn('Scheduler shutting down gracefully.');
        process.exit(0);
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
}

startScheduler();
