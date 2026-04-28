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
        'INSERT INTO dashboards (user_id, name, user_intent, is_active, updated_at) VALUES ($1, $2, $3, true, CURRENT_TIMESTAMP) RETURNING *',
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
        'UPDATE dashboards SET user_intent = $1, is_active = true, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
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

async function updateDashboardSettings(dashboardId, { name, summary_style, is_active }) {
    const current = await getDashboardById(dashboardId);
    const newSettings = {
        name: name !== undefined ? name : current.name,
        summary_style: summary_style !== undefined ? summary_style : current.summary_style,
        is_active: is_active !== undefined ? is_active : current.is_active,
    };
    const res = await pool.query(
        'UPDATE dashboards SET name = $1, summary_style = $2, is_active = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
        [newSettings.name, newSettings.summary_style, newSettings.is_active, dashboardId]
    );
    return res.rows[0];
}

async function deleteDashboard(dashboardId) {
    await pool.query('DELETE FROM dashboards WHERE id = $1', [dashboardId]);
}

async function getAllActiveDashboards() {
    const res = await pool.query('SELECT * FROM dashboards WHERE is_active = true');
    return res.rows;
}

async function addDashboardArticle(dashboardId, article, relevanceScore, microSummary) {
    const { title, link, pubDate, sourceName } = article;
    
    // --- SIMPLE DEDUPLICATION LOGIC ---
    // We check if an article with a very similar title already exists in this dashboard
    // from the last 24 hours. This prevents "copy-paste" news from filling the feed.
    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
    
    try {
        const existingRes = await pool.query(
            `SELECT id FROM dashboard_articles 
             WHERE dashboard_id = $1 
             AND (
                LOWER(REGEXP_REPLACE(title, '[^a-zA-Z0-9]', '', 'g')) = $2
                OR link = $3
             )
             AND created_at > NOW() - INTERVAL '24 hours' 
             LIMIT 1`,
            [dashboardId, normalizedTitle, link]
        );

        if (existingRes.rows.length > 0) {
            // dbLogger.info(`Skipping duplicate article for dashboard ${dashboardId}: ${title}`);
            return null; // Skip insertion
        }
    } catch (err) {
        dbLogger.error(`Error during deduplication check: ${err.message}`);
    }

    dbLogger.info(`Adding article to dashboard ${dashboardId}: ${title}`);
    const res = await pool.query(
        `INSERT INTO dashboard_articles (dashboard_id, title, link, source_name, pub_date, relevance_score, micro_summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (dashboard_id, link) DO NOTHING
         RETURNING *`,
        [dashboardId, title, link, sourceName || 'Unknown', pubDate ? new Date(pubDate) : null, relevanceScore, microSummary]
    );
    return res.rows[0];
}

async function getDashboardArticles(dashboardId, limit = 50) {
    const res = await pool.query(
        `SELECT * FROM dashboard_articles 
         WHERE dashboard_id = $1 
         ORDER BY COALESCE(pub_date, created_at) DESC, created_at DESC 
         LIMIT $2`,
        [dashboardId, limit]
    );
    return res.rows;
}

async function updateDashboardArticleSummary(id, microSummary) {
    const res = await pool.query(
        `UPDATE dashboard_articles SET micro_summary = $1 WHERE id = $2 RETURNING *`,
        [microSummary, id]
    );
    return res.rows[0];
}

async function isArticleAlreadyInDashboard(dashboardId, link) {
    const res = await pool.query(
        'SELECT 1 FROM dashboard_articles WHERE dashboard_id = $1 AND link = $2 LIMIT 1',
        [dashboardId, link]
    );
    return res.rows.length > 0;
}

async function findExistingSummaryByLink(link) {
    const res = await pool.query(
        'SELECT micro_summary FROM dashboard_articles WHERE link = $1 AND micro_summary IS NOT NULL LIMIT 1',
        [link]
    );
    return res.rows.length > 0 ? res.rows[0].micro_summary : null;
}

async function deleteOldArticles(days = 7) {
    const res = await pool.query(
        'DELETE FROM dashboard_articles WHERE created_at < NOW() - $1 * INTERVAL \'1 day\'',
        [days]
    );
    return res.rowCount;
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
    getAllActiveDashboards,
    updateDashboardCategories,
    updateDashboardSearchTerms,
    addDashboardArticle,
    getDashboardArticles,
    updateDashboardArticleSummary,
    isArticleAlreadyInDashboard,
    findExistingSummaryByLink,
    deleteOldArticles
};