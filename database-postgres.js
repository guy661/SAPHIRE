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
            CREATE TABLE IF NOT EXISTS topics (
                id SERIAL PRIMARY KEY,
                user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                main_topic TEXT NOT NULL,
                include_keywords TEXT,
                exclude_keywords TEXT,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                status VARCHAR(50) NOT NULL,
                summary_style VARCHAR(50) DEFAULT 'paragraph', -- New column
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
                summary TEXT,
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

async function getTopicByUserId(userId) {
    const res = await pool.query('SELECT * FROM topics WHERE user_id = $1', [userId]);
    return res.rows[0];
}

async function upsertTopic(userId, { main_topic, include_keywords, exclude_keywords }) {
    await pool.query(
        `INSERT INTO topics (user_id, main_topic, include_keywords, exclude_keywords)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
         main_topic = EXCLUDED.main_topic,
         include_keywords = EXCLUDED.include_keywords,
         exclude_keywords = EXCLUDED.exclude_keywords,
         updated_at = CURRENT_TIMESTAMP`,
        [userId, main_topic, include_keywords, exclude_keywords]
    );
}

async function createJob(jobId, userId, status, summaryStyle = 'paragraph') {
    await pool.query(
        'INSERT INTO jobs (id, user_id, status, summary_style) VALUES ($1, $2, $3, $4)',
        [jobId, userId, status, summaryStyle]
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

async function updateArticleSummary(articleId, summary) {
    await pool.query('UPDATE articles SET summary = $1 WHERE id = $2', [summary, articleId]);
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

async function clearDatabase() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM articles');
        await client.query('DELETE FROM jobs');
        await client.query('DELETE FROM topics');
        await client.query('DELETE FROM users');
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

init().catch(err => {
    dbLogger.error("Failed to init database on startup", err);
});

module.exports = {
    init,
    createUser,
    getUserByUsername,
    getUserById,
    updateUserLanguage,
    getTopicByUserId,
    upsertTopic,
    createJob,
    getJob,
    createJobArticle,
    getJobArticles,
    getArticle,
    updateArticleContent,
    updateArticleSummary,
    updateArticleSemanticRelevance,
    updateArticleStatus,
    updateJobStatus, // Export the new function
    clearDatabase,
};