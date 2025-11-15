const puppeteer = require('puppeteer');

(async () => {
  try {
    console.log('Launching Puppeteer...');
    const browser = await puppeteer.launch({ headless: "new" });
    console.log('Puppeteer launched successfully.');
    await browser.close();
    console.log('Browser closed.');
  } catch (error) {
    console.error('Error launching Puppeteer:', error);
    process.exit(1);
  }
})();
