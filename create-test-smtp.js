const nodemailer = require('nodemailer');

async function createTestAccount() {
    console.log('--- Temporären SMTP-Testaccount erstellen ---');
    
    try {
        // Erstellt einen Test-Account bei ethereal.email
        const testAccount = await nodemailer.createTestAccount();

        console.log('\n✅ Account erfolgreich erstellt!');
        console.log('\nKopiere diese Werte in deine .env Datei:\n');
        console.log(`SMTP_HOST=${testAccount.smtp.host}`);
        console.log(`SMTP_PORT=${testAccount.smtp.port}`);
        console.log(`SMTP_USER=${testAccount.user}`);
        console.log(`SMTP_PASS=${testAccount.pass}`);
        console.log(`SMTP_SECURE=false`);
        
        console.log('\n--- INFO ---');
        console.log('Die gesendeten E-Mails kommen nicht in deinem echten Postfach an.');
        console.log('Du kannst sie stattdessen hier online ansehen:');
        console.log(`URL: https://ethereal.email/messages`);
        console.log('Dort einfach mit dem oben genannten User und Passwort einloggen.');
        
    } catch (error) {
        console.error('Fehler beim Erstellen des Test-Accounts:', error);
    }
}

createTestAccount();
