const pool = require('./postgres');
const bcrypt = require('bcrypt');
const { Logger, EMOJIS } = require('./utils');

const dbLogger = new Logger('Database', 'cyan', EMOJIS.db);

async function init() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                language VARCHAR(10) DEFAULT 'de',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS dashboards (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                user_intent TEXT,
                interval_minutes INTEGER,
                is_active BOOLEAN NOT NULL DEFAULT false,
                summary_style VARCHAR(255),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
                status VARCHAR(50) NOT NULL,
                meta_summary TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS articles (
                id SERIAL PRIMARY KEY,
                job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                title TEXT,
                link TEXT NOT NULL,
                pub_date TIMESTAMP WITH TIME ZONE,
                content TEXT,
                is_relevant BOOLEAN,
                relevance_reason TEXT,
                status VARCHAR(50) DEFAULT 'pending',
                error_message TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query('COMMIT');
        dbLogger.info('Database tables ensured successfully.');
    } catch (error) {
        await client.query('ROLLBACK');
        dbLogger.error('Error ensuring database tables:', error);
        throw error;
    } finally {
        client.release();
    }
}

async function createUser(username, password, language) {
    const hashedPassword = await bcrypt.hash(password, 10);
    const res = await pool.query(
        'INSERT INTO users (username, password, language) VALUES ($1, $2, $3) RETURNING id, username, language',
        [username, hashedPassword, language]
    );
    return res.rows[0];
}

async function getUserByUsername(username) {
    const res = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    return res.rows[0];
}

async function getUserById(id) {
    const res = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return res.rows[0];
}

async function updateUserLanguage(userId, language) {
    await pool.query('UPDATE users SET language = $1 WHERE id = $2', [language, userId]);
}

// Dashboard CRUD functions
async function createDashboard(userId, name, userIntent = '') {
    const res = await pool.query(
        'INSERT INTO dashboards (user_id, name, user_intent, updated_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) RETURNING *',
        [userId, name, userIntent]
    );
    return res.rows[0];
}

async function getDashboardById(dashboardId) {
    const res = await pool.query('SELECT * FROM dashboards WHERE id = $1', [dashboardId]);
    return res.rows[0];
}

async function getDashboardsByUserId(userId) {
    const res = await pool.query('SELECT * FROM dashboards WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    return res.rows;
}

async function updateDashboardTopic(dashboardId, userIntent) {
    const res = await pool.query(
        'UPDATE dashboards SET user_intent = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
        [userIntent, dashboardId]
    );
    return res.rows[0];
}

async function updateDashboardSettings(dashboardId, { name, interval_minutes, summary_style, is_active }) {
    // Fetch current values first to prevent them from being overwritten with null
    const current = await getDashboardById(dashboardId);
    
    const newSettings = {
        name: name !== undefined ? name : current.name,
        interval_minutes: interval_minutes !== undefined ? interval_minutes : current.interval_minutes,
        summary_style: summary_style !== undefined ? summary_style : current.summary_style,
        is_active: is_active !== undefined ? is_active : current.is_active,
    };

    const res = await pool.query(
        'UPDATE dashboards SET name = $1, interval_minutes = $2, summary_style = $3, is_active = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5 RETURNING *',
        [newSettings.name, newSettings.interval_minutes, newSettings.summary_style, newSettings.is_active, dashboardId]
    );
    return res.rows[0];
}

async function deleteDashboard(dashboardId) {
    await pool.query('DELETE FROM dashboards WHERE id = $1', [dashboardId]);
}


async function createJob(jobId, dashboardId, status) {
    await pool.query(
        'INSERT INTO jobs (id, dashboard_id, status) VALUES ($1, $2, $3)',
        [jobId, dashboardId, status]
    );
}

async function getJob(jobId) {
    const res = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
    return res.rows[0];
}

async function createJobArticle(jobId, article) {
    const res = await pool.query(
        'INSERT INTO articles (job_id, title, link, pub_date) VALUES ($1, $2, $3, $4) RETURNING id, link',
        [jobId, article.title, article.link, article.pubDate ? new Date(article.pubDate) : null]
    );
    return res.rows[0];
}

async function getJobArticles(jobId) {
    const res = await pool.query('SELECT * FROM articles WHERE job_id = $1 ORDER BY pub_date DESC', [jobId]);
    return res.rows;
}

async function getArticle(articleId) {
    const res = await pool.query('SELECT * FROM articles WHERE id = $1', [articleId]);
    return res.rows[0];
}

async function updateArticleContent(articleId, content, title, finalUrl) {
    await pool.query(
        'UPDATE articles SET content = $1, title = $2, link = $3, status = $4 WHERE id = $5',
        [content, title, finalUrl, 'processing', articleId]
    );
}

async function updateArticleSemanticRelevance(articleId, isRelevant, reasoning) {
    await pool.query(
        'UPDATE articles SET is_relevant = $1, relevance_reason = $2, status = $3 WHERE id = $4',
        [isRelevant, reasoning, 'completed', articleId]
    );
}

async function updateArticleStatus(articleId, status, error = null) {
    await pool.query(
        'UPDATE articles SET status = $1, error_message = $2 WHERE id = $3',
        [status, error, articleId]
    );
}

async function updateJobStatus(jobId, status) {
    await pool.query(
        'UPDATE jobs SET status = $1 WHERE id = $2',
        [status, jobId]
    );
}

async function updateJobMetaSummary(jobId, summary) {
    await pool.query(
        'UPDATE jobs SET meta_summary = $1 WHERE id = $2',
        [summary, jobId]
    );
}

async function clearDatabase() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM articles');
        await client.query('DELETE FROM jobs');
        await client.query('DELETE FROM dashboards');
        await client.query('DELETE FROM users');
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function runMigrations() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        dbLogger.info('Checking for necessary database migrations...');

        // Migration 1: Drop 'topics' table if it exists
        const topicsTableRes = await client.query("SELECT to_regclass('public.topics')");
        if (topicsTableRes.rows[0].to_regclass) {
            dbLogger.warn('Old "topics" table detected. Dropping it...');
            await client.query('DROP TABLE public.topics CASCADE');
            dbLogger.info('Migration successful: "topics" table dropped.');
        }

        // Migration 2: Check if 'jobs' table needs to be migrated (from user_id to dashboard_id)
        const jobsColumnRes = await client.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='jobs' AND column_name='user_id'
        `);

        if (jobsColumnRes.rows.length > 0) {
            dbLogger.warn('Old schema detected in "jobs" table (user_id column found). Running migration...');
            
            // Because old jobs cannot be mapped to non-existent dashboards,
            // we will clear the dependent tables to ensure consistency.
            dbLogger.warn('Deleting all records from "articles" and "jobs" to apply new schema...');
            await client.query('DELETE FROM articles');
            await client.query('DELETE FROM jobs');

            // Find the foreign key constraint name to drop it
            const constraintRes = await client.query(`
                SELECT conname
                FROM pg_constraint
                WHERE conrelid = 'jobs'::regclass AND confrelid = 'users'::regclass;
            `);

            for (const row of constraintRes.rows) {
                dbLogger.warn(`Dropping foreign key constraint "${row.conname}" on "jobs" table.`);
                await client.query(`ALTER TABLE jobs DROP CONSTRAINT "${row.conname}"`);
            }
            
            dbLogger.warn('Dropping old "user_id" column from "jobs" table...');
            await client.query('ALTER TABLE jobs DROP COLUMN user_id');

            dbLogger.warn('Adding new "dashboard_id" column to "jobs" table...');
            await client.query('ALTER TABLE jobs ADD COLUMN dashboard_id INTEGER NOT NULL');
            
            dbLogger.warn('Adding new foreign key constraint for "dashboard_id"...');
            await client.query(`
                ALTER TABLE jobs 
                ADD CONSTRAINT jobs_dashboard_id_fkey 
                FOREIGN KEY (dashboard_id) 
                REFERENCES dashboards(id) 
                ON DELETE CASCADE
            `);
            
            dbLogger.info('Migration successful: "jobs" table updated.');
        } else {
            dbLogger.info('"jobs" table schema is up to date.');
        }

        // Migration 3: Add is_active to dashboards if it doesn't exist
        const dashboardColumnRes = await client.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name='dashboards' AND column_name='is_active'
        `);

        if (dashboardColumnRes.rows.length === 0) {
            dbLogger.warn('Old schema detected in "dashboards" table (is_active column missing). Running migration...');
            await client.query('ALTER TABLE dashboards ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT false');
            await client.query('UPDATE dashboards SET is_active = false');
            dbLogger.info('Migration successful: "is_active" column added and updated on "dashboards" table.');
        } else {
            dbLogger.info('"dashboards" table schema is up to date.');
        }

        await client.query('COMMIT');
        dbLogger.info('Database migrations checked successfully.');

    } catch (error) {
        await client.query('ROLLBACK');
        dbLogger.error('Error running migrations:', error);
        throw error;
    } finally {
        client.release();
    }
}

async function getLatestCompletedJobForDashboard(dashboardId) {
    const res = await pool.query(
        `SELECT * FROM jobs 
         WHERE dashboard_id = $1 AND status = 'completed' 
         ORDER BY created_at DESC 
         LIMIT 1`,
        [dashboardId]
    );
    return res.rows[0];
}

async function getActiveJobForDashboard(dashboardId) {
    const res = await pool.query(
        `SELECT * FROM jobs 
         WHERE dashboard_id = $1 AND status IN ('processing', 'generating_summary', 'pending')`,
        [dashboardId]
    );
    return res.rows[0];
}

async function getAllDashboardsWithInterval() {
    const res = await pool.query('SELECT * FROM dashboards WHERE interval_minutes IS NOT NULL AND interval_minutes > 0 AND is_active = true');
    return res.rows;
}

init().then(runMigrations).catch(err => {
    dbLogger.error("Failed to init or migrate database on startup", err);
});

module.exports = {
    init,
    createUser,
    getUserByUsername,
    getUserById,
    updateUserLanguage,
    // Dashboard functions
    createDashboard,
    getDashboardById,
    getDashboardsByUserId,
    getAllDashboardsWithInterval,
    updateDashboardTopic,
    updateDashboardSettings,
    deleteDashboard,
    // Job functions
    createJob,
    getJob,
    getActiveJobForDashboard,
    getLatestCompletedJobForDashboard,
    createJobArticle,
    getJobArticles,
    getArticle,
    updateArticleContent,
    updateArticleSemanticRelevance,
    updateArticleStatus,
    updateJobStatus,
    updateJobMetaSummary,
    clearDatabase,
};