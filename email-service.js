const nodemailer = require('nodemailer');
const { Logger, EMOJIS } = require('./utils');

const emailLogger = new Logger('Email-Service', 'blue', EMOJIS.info);

// SMTP Configuration from .env
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

/**
 * Sends a single immediate alert for a "Kill-Keyword" match.
 */
async function sendImmediateAlert(userEmail, article, dashboardName, matchedKeyword) {
    if (!userEmail) return;

    const fromAddress = process.env.EMAIL_FROM || process.env.SMTP_USER;

    const mailOptions = {
        from: `"SAPHIRE B2B Alarm" <${fromAddress}>`,
        to: userEmail,
        subject: `🚨 SOFORT-ALARM: "${matchedKeyword}" in ${dashboardName} gefunden!`,
        // ... rest of the html remains the same
        html: `
            <div style="font-family: sans-serif; max-width: 600px; border: 1px solid #eee; padding: 20px;">
                <h2 style="color: #d32f2f;">Kritischer Treffer gefunden</h2>
                <p>Hallo,</p>
                <p>wir haben soeben einen Artikel gefunden, der eines deiner <b>Kill-Keywords</b> (${matchedKeyword}) enthält:</p>
                
                <div style="background: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
                    <h3 style="margin-top: 0;">${article.title}</h3>
                    <p style="color: #666;">${article.contentSnippet || article.snippet || 'Keine Vorschau verfügbar'}</p>
                    <a href="${article.link}" style="display: inline-block; padding: 10px 20px; background: #1976d2; color: white; text-decoration: none; border-radius: 5px;">Zum Artikel</a>
                </div>
                
                <p style="font-size: 0.8em; color: #999;">Dashboard: ${dashboardName}</p>
                <hr>
                <p style="font-size: 0.8em; color: #999;">Dies ist eine automatisierte Benachrichtigung von SAPHIRE B2B.</p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        emailLogger.info(`Immediate alert sent to ${userEmail} for "${article.title}"`);
    } catch (error) {
        emailLogger.error(`Failed to send immediate alert to ${userEmail}:`, error);
    }
}

/**
 * Sends a daily briefing with multiple articles grouped by dashboard.
 */
async function sendDailyBriefing(userEmail, articlesByDashboard) {
    if (!userEmail || Object.keys(articlesByDashboard).length === 0) return;

    const fromAddress = process.env.EMAIL_FROM || process.env.SMTP_USER;

    let articlesHtml = '';
    // ... rest of the logic
    
    const mailOptions = {
        from: `"SAPHIRE B2B Briefing" <${fromAddress}>`,
        to: userEmail,
        subject: `☕ Dein Morning Briefing: ${new Date().toLocaleDateString('de-DE')}`,
        html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
                <div style="text-align: center; padding: 20px; background: #f5f5f5;">
                    <h1 style="margin: 0; color: #1976d2;">SAPHIRE B2B</h1>
                    <p style="margin: 5px 0; color: #666;">Guten Morgen! Hier sind deine News von heute.</p>
                </div>
                
                <div style="padding: 20px;">
                    ${articlesHtml}
                </div>
                
                <div style="padding: 20px; text-align: center; background: #f5f5f5; font-size: 0.8em; color: #999;">
                    <p>Du erhältst diese E-Mail, weil du tägliche Zusammenfassungen aktiviert hast.</p>
                    <p>&copy; 2026 SAPHIRE B2B Intelligence</p>
                </div>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        emailLogger.info(`Daily briefing sent to ${userEmail}`);
    } catch (error) {
        emailLogger.error(`Failed to send daily briefing to ${userEmail}:`, error);
    }
}

module.exports = { sendImmediateAlert, sendDailyBriefing };