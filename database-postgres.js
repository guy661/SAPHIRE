const pool = require('./postgres');
const bcrypt = require('bcrypt');
const { Logger, EMOJIS } = require('./utils');

const dbLogger = new Logger('Database', 'cyan', EMOJIS.db);

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

async function getJobsByDashboardId(dashboardId) {
    const res = await pool.query(
        'SELECT id, status, meta_summary, created_at FROM jobs WHERE dashboard_id = $1 ORDER BY created_at DESC', 
        [dashboardId]
    );
    return res.rows;
}

module.exports = {
    createUser,
    getUserByUsername,
    getUserById,
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
    getJobsByDashboardId, // <-- Export the new function
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
};