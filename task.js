const { callLocalAI, callLocalAIChat, Logger, EMOJIS } = require('./utils.js');

const taskLogger = new Logger('Task', 'yellow', EMOJIS.task);

// Helper to clean Markdown code blocks from JSON strings
function cleanJsonString(str) {
    if (!str) return '';
    // Remove ```json ... ``` or just ``` ... ``` wrappers
    let cleaned = str.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/```$/, '');
    return cleaned.trim();
}

const orchestrateChatTask = async ({ data: { chatHistory, language = 'de' } }) => {
    const systemPrompt = {
        'de': `You are Saphire, a helpful assistant. You are currently acting as a news assistant for a German user.

### GOAL
Help the user define a news topic they want to read about.

### INSTRUCTIONS
1. **Language:** Speak ONLY German.
2. **Openness:** Be creative and open-minded. Do NOT force the user into specific sub-categories immediately. If the user gives a broad topic (e.g. "Australia"), accept it or ask broadly what interests them about it, without limiting choices.
3. **Small Talk:** If the user says "Hi", "Wie gehts?", or jokes, answer politely but gently steer back to news topics.
4. **Save Rule:** If the user explicitly confirms a REAL news topic (e.g. "Tech", "Australia", "Politics") with "Ja" or "Das passt", do NOT speak. Instead, output ONLY a JSON object to save the topic.

### TOOL USAGE (JSON FORMAT)
To save the topic, output exactly this JSON structure (no other text):
\`\`\`json
{
  "tool": "save_intent",
  "parameters": {
    "user_intent": "A detailed summary of the user's interest (e.g. 'News about Artificial Intelligence in the workplace')."
  }
}
\`\`\`

### DIALOGUE EXAMPLES

[Example 1: Broad Topic]
User: Ich interessiere mich für Australien.
Assistant: Spannend! Möchtest du einfach allgemeine Nachrichten aus Australien, oder gibt es bestimmte Bereiche wie Politik, Natur oder Kultur, die dich besonders interessieren?
User: Einfach allgemein was da so abgeht.
Assistant: Alles klar. Also ein allgemeiner Nachrichtenüberblick für "Australien". Passt das so?
User: Ja.
Assistant: \`\`\`json
{
  "tool": "save_intent",
  "parameters": { "user_intent": "Allgemeine Nachrichten und aktuelle Ereignisse aus Australien." }
}
\`\`\`

[Example 2: Specific Topic]
User: Ich mag Tech.
Assistant: Das ist ein weites Feld! Was fasziniert dich daran am meisten?
User: KI und Arbeit.
Assistant: Verstanden. Also News zu "Einfluss von KI auf die Arbeitswelt". Passt das so?
User: Ja.
Assistant: \`\`\`json
{
  "tool": "save_intent",
  "parameters": { "user_intent": "Einfluss von künstlicher Intelligenz auf die Arbeitswelt und Jobs." }
}
\`\`\`

[Example 3: Tricky User]
User: Ich will Pizza essen.
Assistant: Lecker! Aber ich kann dir leider keine Pizza bestellen. Ich kann dir aber Nachrichten über "Kulinarik" oder "Gastronomie-Trends" suchen. Wäre das was?`,
        'en': `You are Saphire, a helpful assistant. You are currently acting as a news assistant.

### GOAL
Help the user define a specific news topic.

### INSTRUCTIONS
1. **Language:** English.
2. **Small Talk:** Handle chat normally. Do NOT save small talk as a topic.
3. **Save Rule:** If the user confirms a topic, output ONLY the JSON tool call.

### TOOL USAGE (JSON FORMAT)
\`\`\`json
{
  "tool": "save_intent",
  "parameters": { "user_intent": "Topic summary" }
}
\`\`\`

### EXAMPLES
User: How are you?
Assistant: I'm good! What news topic are you interested in?
User: Tech news.
Assistant: \`\`\`json
{
  "tool": "save_intent",
  "parameters": { "user_intent": "Technology news" }
}
\`\`\`
`
    };
    
    const getSystemPrompt = systemPrompt[language] || systemPrompt['de'];

    const fullHistory = [
        { role: 'system', parts: [{ text: getSystemPrompt }] },
        ...chatHistory
    ];

    try {
        const result = await callLocalAIChat(fullHistory, [], 0.7);
        
        let toolCall = null;
        try {
            const cleanResult = cleanJsonString(result);
            const jsonMatch = cleanResult.match(/\{.*\}/s);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.tool === 'save_intent' && parsed.parameters && parsed.parameters.user_intent) {
                    toolCall = {
                        name: 'save_intent',
                        args: parsed.parameters
                    };
                }
            }
        } catch (e) {
            // Ignore parsing errors, assume it's just text
        }

        if (toolCall) { 
            const args = toolCall.args;
            taskLogger.info(`AI (Manual JSON) decided to call function '${toolCall.name}' with args:`, args);
            
            return {
                action: 'save',
                data: { user_intent: args.user_intent },
                message: 'Perfekt! Ich habe deine neuen Einstellungen gespeichert. Du kannst dieses Fenster nun schließen.'
            };
        } else {
            return {
                action: 'reply',
                message: result
            };
        }
    } catch (error) {
        taskLogger.error('Error during chat orchestration', error);
        return {
            action: 'error',
            message: 'Entschuldigung, es gab einen Fehler im Denkprozess. Lass es uns kurz noch einmal versuchen.'
        };
    }
};

const selectCategoriesTask = async ({ data: { user_intent, categories, language = 'de' } }) => {
    // categories is an object where keys are IDs and values have names/descriptions
    const categoryList = Object.entries(categories).map(([key, cat]) => {
        return `- ID: "${key}"\n  NAME: ${cat.name}\n  INHALT: ${cat.description || 'Keine Beschreibung'}`;
    }).join('\n\n');

    const prompt = `
### ROLE
Strikter News-Filter.

### INPUT
Interest: "${user_intent}"
Categories:
${categoryList}

### TASK
Wähle NUR Kategorien, die **exakt** zum Interest passen.
- Ausschlussprinzip: Wenn unsicher, NICHT wählen.
- Vermeide Rauschen (z.B. kein "Sport" für "Tech-News").

### OUTPUT FORMAT (JSON ONLY)
{
  "selected_category_ids": ["id1", "id2"]
}
    `;

    try {
        const responseString = await callLocalAI(prompt, 0.0, true); // Low temp for precision
        const jsonString = cleanJsonString(responseString);
        const jsonMatch = jsonString.match(/\{.*\}/s);
        if (!jsonMatch) throw new Error("No JSON found");
        
        const result = JSON.parse(jsonMatch[0]);
        return result.selected_category_ids || [];
    } catch (error) {
        taskLogger.error('Error selecting categories', error);
        return [];
    }
};

const generateGeneralKeywordsTask = async ({ data: { user_intent, language = 'de' } }) => {
    const prompt = `
### ROLE
Such-Experte.

### INPUT
Intent: "${user_intent}"

### TASK
Generiere 5-8 breite Keywords (max 2 Wörter) als Vorfilter.
- Deutsch (de) UND Englisch (en).
- Breit genug für alle Aspekte ("US-Wahl" statt "Wahlergebnis Pennsylvania").

### OUTPUT FORMAT (JSON ONLY)
{
  "de": ["Begriff1", "Begriff2"],
  "en": ["Term1", "Term2"]
}
    `;

    try {
        const responseString = await callLocalAI(prompt, 0.3, true);
        const jsonMatch = responseString.match(/\{.*\}/s);
        if (!jsonMatch) throw new Error("No JSON found");
        
        const result = JSON.parse(jsonMatch[0]);
        return {
            de: Array.isArray(result.de) ? result.de : [],
            en: Array.isArray(result.en) ? result.en : []
        };
    } catch (error) {
        taskLogger.error('Error generating general keywords', error);
        return { de: [], en: [] };
    }
};

const generateMicroSummaryTask = async ({ data: { article, user_intent, language = 'de' } }) => {
    const prompt = `
### ROLLE
Du bist ein präziser News-Kurator.

### INPUT
Artikel-Titel: "${article.title}"
Artikel-Snippet: "${article.contentSnippet || article.snippet || ''}"
User-Interesse: "${user_intent}"

### AUFGABE
Schreibe eine "Micro-Zusammenfassung" (max. 3 sehr kurze Bulletpoints) für diesen Artikel.
Erkläre kurz, **warum** dieser Artikel relevant für das User-Interesse ist und was die Kernaussage ist.

### FORMAT
- Punkt 1
- Punkt 2
- Punkt 3

Antworte NUR mit den Bulletpoints auf Deutsch. Kein Intro, kein Outro.
    `;

    try {
        const summary = await callLocalAI(prompt, 0.3);
        return summary.trim();
    } catch (error) {
        taskLogger.error('Error generating micro-summary', error);
        return '- Zusammenfassung konnte nicht generiert werden.';
    }
};

module.exports = { orchestrateChatTask, selectCategoriesTask, generateGeneralKeywordsTask, generateMicroSummaryTask };
