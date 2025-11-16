const puppeteer = require('puppeteer');

async function setup() {
    console.log('Starte das Browser-Setup. Eine kompatible Version von Chromium wird heruntergeladen.');
    console.log('Dies ist ein einmaliger Vorgang und kann bei einer langsamen Verbindung 15-30 Minuten dauern.');
    console.log('Bitte haben Sie Geduld und lassen Sie dieses Skript vollständig durchlaufen.');

    try {
        const browser = await puppeteer.launch();
        console.log('Browser erfolgreich gestartet. Wird jetzt geschlossen.');
        await browser.close();
        console.log('✅ Setup abgeschlossen! Chromium ist heruntergeladen und bereit.');
        console.log('Sie können den Server jetzt mit "node server.js" starten.');
    } catch (error) {
        console.error('‼️ Ein Fehler ist während des Setups aufgetreten:', error);
        console.error('Bitte überprüfen Sie Ihre Internetverbindung und versuchen Sie erneut, "node setup.js" auszuführen.');
    }
}

setup();
