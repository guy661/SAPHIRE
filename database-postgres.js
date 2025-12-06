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

async function updateDashboardCategories(dashboardId, categories) {
    const res = await pool.query(
        'UPDATE dashboards SET selected_categories = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
        [JSON.stringify(categories), dashboardId]
    );
    return res.rows[0];
}

async function updateDashboardSearchTerms(dashboardId, searchTerms) {
    const res = await pool.query(
        'UPDATE dashboards SET search_terms = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
        [JSON.stringify(searchTerms), dashboardId]
    );
    return res.rows[0];
}

async function updateDashboardSettings(dashboardId, { name, interval_minutes, summary_style, is_active }) {
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
    await pool.query('INSERT INTO jobs (id, dashboard_id, status) VALUES ($1, $2, $3)', [jobId, dashboardId, status]);
}

async function getJob(jobId) {
    const res = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
    return res.rows[0];
}

async function createArticle(jobId, article, clusterId, sourceName) {
    const { title, link, pubDate, fetchedContent } = article;
    const res = await pool.query(
        `INSERT INTO articles (job_id, title, link, pub_date, content, cluster_id, source_name, status) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
         RETURNING id`,
        [jobId, title, link, pubDate ? new Date(pubDate) : null, fetchedContent, clusterId, sourceName, 'processing']
    );
    return res.rows[0];
}

async function getRecentClusters(since = '24 hours') {
    const res = await pool.query(`SELECT id, representative_title FROM clusters WHERE last_seen_at > NOW() - $1::interval`, [since]);
    return res.rows;
}

async function createCluster(representativeTitle) {
    const res = await pool.query('INSERT INTO clusters (representative_title) VALUES ($1) RETURNING id', [representativeTitle]);
    return res.rows[0];
}

async function touchCluster(clusterId) {
    await pool.query('UPDATE clusters SET last_seen_at = CURRENT_TIMESTAMP WHERE id = $1', [clusterId]);
}

async function updateClusterWithAnalysis(clusterId, { summary, sentiment, focus, bias }) {
    await pool.query('UPDATE clusters SET summary = $1, sentiment = $2, focus = $3, bias = $4 WHERE id = $5', [summary, sentiment, focus, bias, clusterId]);
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
    await pool.query('UPDATE articles SET content = $1, title = $2, link = $3, status = $4 WHERE id = $5', [content, title, finalUrl, 'processing', articleId]);
}

async function updateArticleSemanticRelevance(articleId, isRelevant, reasoning) {
    await pool.query('UPDATE articles SET is_relevant = $1, relevance_reason = $2, status = $3 WHERE id = $4', [isRelevant, reasoning, 'completed', articleId]);
}

async function updateArticleStatus(articleId, status, error = null) {
    await pool.query('UPDATE articles SET status = $1, error_message = $2 WHERE id = $3', [status, error, articleId]);
}

async function updateJobStatus(jobId, status) {
    await pool.query('UPDATE jobs SET status = $1 WHERE id = $2', [status, jobId]);
}

async function updateJobMetaSummary(jobId, summary) {
    await pool.query('UPDATE jobs SET meta_summary = $1 WHERE id = $2', [summary, jobId]);
}

async function getLatestCompletedJobForDashboard(dashboardId) {
    const res = await pool.query(`SELECT * FROM jobs WHERE dashboard_id = $1 AND status = 'completed' ORDER BY created_at DESC LIMIT 1`, [dashboardId]);
    return res.rows[0];
}

async function getActiveJobForDashboard(dashboardId) {
    const res = await pool.query(`SELECT * FROM jobs WHERE dashboard_id = $1 AND status IN ('processing', 'generating_summary', 'pending')`, [dashboardId]);
    return res.rows[0];
}

async function getAllDashboardsWithInterval() {
    const res = await pool.query('SELECT * FROM dashboards WHERE interval_minutes IS NOT NULL AND interval_minutes > 0 AND is_active = true');
    return res.rows;
}

async function getJobsByDashboardId(dashboardId) {
    const res = await pool.query('SELECT id, status, meta_summary, created_at FROM jobs WHERE dashboard_id = $1 ORDER BY created_at DESC', [dashboardId]);
    return res.rows;
}

async function getClustersByJobId(jobId, userId) {

    const res = await pool.query(

        `SELECT

            c.id, c.representative_title, c.summary, c.sentiment, c.focus, c.bias, c.created_at,

            uf.feedback_type as "user_feedback",

            json_agg(json_build_object('id', a.id, 'title', a.title, 'link', a.link, 'source_name', a.source_name, 'pub_date', a.pub_date) ORDER BY a.pub_date DESC) as articles

        FROM clusters c

        JOIN articles a ON c.id = a.cluster_id

        LEFT JOIN user_feedback uf ON c.id = uf.cluster_id AND uf.user_id = $2

        WHERE a.job_id = $1

        GROUP BY c.id, c.representative_title, c.summary, c.sentiment, c.focus, c.bias, c.created_at, uf.feedback_type

        ORDER BY c.created_at DESC`,

        [jobId, userId]

    );

    return res.rows;

}

async function addUserFeedback(userId, clusterId, feedbackType) {
    dbLogger.info(`Adding/updating feedback for user ${userId}, cluster ${clusterId}: ${feedbackType}`);
    const res = await pool.query(
        `INSERT INTO user_feedback (user_id, cluster_id, feedback_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, cluster_id)
         DO UPDATE SET feedback_type = $3, created_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [userId, clusterId, feedbackType]
    );
    return res.rows[0];
}

async function getClusterIdsByJobId(jobId) {
    const res = await pool.query('SELECT DISTINCT cluster_id FROM articles WHERE job_id = $1', [jobId]);
    return res.rows.map(r => r.cluster_id);
}

async function getUserFeedback(userId) {
    const res = await pool.query('SELECT cluster_id, feedback_type FROM user_feedback WHERE user_id = $1', [userId]);
    return res.rows;
}

async function getClusterTitlesByIds(clusterIds) {
    if (!clusterIds || clusterIds.length === 0) return [];
    const res = await pool.query('SELECT id, representative_title FROM clusters WHERE id = ANY($1)', [clusterIds]);
    return res.rows;
}

async function getFeedbackAndHistory(userId, dashboardId) {
    dbLogger.info(`Getting feedback and history for user ${userId} and dashboard ${dashboardId}`);
    const allFeedback = await getUserFeedback(userId);
    const likes = allFeedback.filter(f => f.feedback_type === 'like').map(f => f.cluster_id);
    const dislikes = allFeedback.filter(f => f.feedback_type === 'dislike').map(f => f.cluster_id);
    const lastJob = await getLatestCompletedJobForDashboard(dashboardId);
    let previousClusters = [];
    if (lastJob) {
        previousClusters = await getClusterIdsByJobId(lastJob.id);
    }
    return {
        likedClusterIds: likes,
        dislikedClusterIds: dislikes,
        previousClusterIds: previousClusters
    };
}

async function deleteUserFeedback(userId, clusterId) {
    dbLogger.info(`Deleting feedback for user ${userId}, cluster ${clusterId}`);
    await pool.query(
        'DELETE FROM user_feedback WHERE user_id = $1 AND cluster_id = $2',
        [userId, clusterId]
    );
}

module.exports = {
    createUser,
    getUserByUsername,
    getUserById,
    createDashboard,
    getDashboardById,
    getDashboardsByUserId,
    updateDashboardTopic,
    updateDashboardSettings,
    deleteDashboard,
    createJob,
    getJob,
    createArticle,
    getRecentClusters,
    createCluster,
    touchCluster,
    updateClusterWithAnalysis,
    getJobArticles,
    getArticle,
    updateArticleContent,
    updateArticleSemanticRelevance,
    updateArticleStatus,
    updateJobStatus,
    updateJobMetaSummary,
    getLatestCompletedJobForDashboard,
    getActiveJobForDashboard,
    getAllDashboardsWithInterval,
    getJobsByDashboardId,
    addUserFeedback,
    getClusterIdsByJobId,
    getUserFeedback,
    getFeedbackAndHistory,
    getClusterTitlesByIds,
    deleteUserFeedback,
    updateDashboardCategories,
    updateDashboardSearchTerms,
    getClustersByJobId
};
