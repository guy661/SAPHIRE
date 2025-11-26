const { retry, callGemini, callGeminiChat, Logger, EMOJIS } = require('./utils.js');

const taskLogger = new Logger('Task', 'yellow', EMOJIS.task);

const orchestrateChatTask = async ({ data: { chatHistory, language = 'de' } }) => {
    taskLogger.info(`Orchestrating chat with history length: ${chatHistory.length}`);

    const tools = [
        {
            functionDeclarations: [
                {
                    name: 'save_intent',
                    description: 'Saves the user\'s final, confirmed interest profile.',
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            user_intent: {
                                type: 'STRING',
                                description: 'A detailed, self-contained paragraph describing the user\'s core interest, including any specific angles, perspectives, or things to avoid. This is the complete summary of what the user wants.'
                            }
                        },
                        required: ['user_intent']
                    }
                }
            ]
        }
    ];

    const systemPrompt = {
        'de': `Du bist ein brillanter, freundlicher und gesprächiger KI-Assistent. Deine Aufgabe ist es, einem Nutzer in einem natürlichen Gespräch dabei zu helfen, seine Interessen für einen personalisierten News-Feed zu definieren.

        DEIN ZIEL: Formuliere eine prägnante, reichhaltige Beschreibung der Kerninteressen und der Absicht des Nutzers. Diese Beschreibung sollte in einem einzigen, eigenständigen Paragraphen zusammenfassen, was der Nutzer WIRKLICH sehen möchte.
        
        DEIN VERHALTEN:
        - Sei proaktiv. Beginne locker und frage nach allgemeinen Interessen.
        - Wenn ein Thema breit ist, gib nicht auf, bis du den spezifischen Blickwinkel oder die Perspektive des Nutzers verstanden hast. Stelle klärende Fragen und mache Vorschläge, um das Thema einzugrenzen.
        - Triff eine eigene Einschätzung (eine "Prognose"), ob das Thema spezifisch genug ist. Du musst den Nutzer nicht immer explizit fragen, ob es "spezifisch genug" ist. Führe das Gespräch so, dass du die Antwort bekommst.
        - Am Ende des Gesprächs, wenn du glaubst, die Absicht vollständig erfasst zu haben, fasse sie in einem Paragraphen zusammen und frage den Nutzer explizit um Bestätigung.
        
        TOOL-NUTZUNG:
        - Rufe die Funktion 'save_intent' ERST DANN auf, wenn du die finale, zusammengefasste 'user_intent' formuliert hast UND der Nutzer diese Zusammenfassung bestätigt hat (z.B. mit "Ja, das passt so").
        - Gib in allen anderen Fällen, in denen du auf eine Antwort wartest oder eine Frage stellst, einfach nur Text zurück.`,
        'en': `You are a brilliant, friendly, and conversational AI assistant. Your task is to help a user define their interests for a personalized news feed in a natural conversation.

        YOUR GOAL: Formulate a concise, rich description of the user's core interest and intent. This description should summarize in a single, self-contained paragraph what the user REALLY wants to see.
        
        YOUR BEHAVIOR:
        - Be proactive. Start casually and ask for general interests.
        - If a topic is broad, don't give up until you understand the user's specific angle or perspective. Ask clarifying questions and make suggestions to narrow it down.
        - Make your own judgment (a "prognosis") about whether the topic is specific enough. You don't always have to explicitly ask the user if it's "specific enough." Guide the conversation to get the answer.
        - At the end of the conversation, when you believe you have fully captured the intent, summarize it in a paragraph and explicitly ask the user for confirmation.
        
        TOOL USAGE:
        - Call the 'save_intent' function ONLY after you have formulated the final, summarized 'user_intent' AND the user has confirmed that summary (e.g., with "Yes, that looks good").
        - In all other cases where you are waiting for a response or asking a question, simply return text.`
    };
    
    const getSystemPrompt = systemPrompt[language] || systemPrompt['de'];

    const fullHistory = [
        { role: 'user', parts: [{ text: getSystemPrompt }] },
        { role: 'model', parts: [{ text: "Verstanden. Ich bin bereit zu helfen. Lass uns anfangen!" }] },
        ...chatHistory
    ];

    try {
        const result = await callGeminiChat(fullHistory, tools, 'gemini-2.5-flash');
        
        if (Array.isArray(result)) { // It's a function call
            const call = result[0];
            const args = call.args;
            taskLogger.info(`AI decided to call function '${call.name}' with args:`, args);
            
            if (call.name === 'save_intent' && args.user_intent) {
                 return {
                    action: 'save',
                    data: { user_intent: args.user_intent },
                    message: 'Perfekt! Ich habe deine neuen Einstellungen gespeichert. Du kannst dieses Fenster nun schließen.'
                };
            }
            return { action: 'reply', message: "Ein interner Fehler ist aufgetreten. Die KI hat eine unbekannte Aktion versucht." };

        } else { // It's a text response
            taskLogger.info(`AI responded with text: "${result}"`);
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

const generateSearchQueriesTask = async ({ data: { user_intent, language = 'de' } }) => {
    taskLogger.info(`Generating search queries for intent: "${user_intent.substring(0, 50)}"...`);

    const genQueryPrompts = {
        'de': (intent) => `
            Du bist ein Experte für Suchmaschinenstrategie. Deine Aufgabe ist es, für eine gegebene Nutzerintention die bestmöglichen Suchanfragen für eine **nicht-semantische, keyword-basierte** Suchmaschine wie Google News zu generieren.

            **Nutzerintention:**
            "${intent}"

            **Deine Aufgabe:**
            1.  Analysiere die Kernkonzepte der Nutzerintention.
            2.  Erstelle 3 bis 5 **unterschiedliche Suchanfragen** (Strings).
            3.  Die Anfragen sollten eine Mischung aus breiteren und spezifischeren Begriffen sein, um die Wahrscheinlichkeit zu maximieren, relevante Artikel zu finden. Kombiniere Keywords auf sinnvolle Weise.
            4.  Die Anfragen sollten auf Deutsch sein.

            **Beispiel:**
            - **Nutzerintention:** "Ich interessiere mich für den Einsatz von KI bei der Früherkennung von Lungenkrebs, insbesondere durch die Bildanalyse von CT-Scans."
            - **Gute Suchanfragen:** ["KI Lungenkrebs Früherkennung", "CT-Scan Bildanalyse maschinelles Lernen", "Deep Learning medizinische Bildgebung Krebsdiagnose", "Künstliche Intelligenz Computertomographie Onkologie"]

            **ANTWORTE AUSSCHLIESSLICH MIT EINEM GÜLTIGEN JSON-OBJEKT:**
            - Das Objekt muss einen einzigen Schlüssel "queries" enthalten, der ein Array von Strings ist.
            - Beispiel-Format: \`{ "queries": ["Anfrage 1", "Anfrage 2", "Anfrage 3"] }\`
        `,
        'en': (intent) => `
            You are an expert in search engine strategy. Your task is to generate the best possible search queries for a given user intent, targeting a **non-semantic, keyword-based** search engine like Google News.

            **User Intent:**
            "${intent}"

            **Your Task:**
            1.  Analyze the core concepts of the user's intent.
            2.  Create 3 to 5 **distinct search queries** (strings).
            3.  The queries should be a mix of broader and more specific terms to maximize the chance of finding relevant articles. Combine keywords in meaningful ways.
            4.  The queries should be in English.

            **Example:**
            - **User Intent:** "I'm interested in the application of AI in the early diagnosis of lung cancer, specifically using image analysis of CT scans."
            - **Good Search Queries:** ["AI lung cancer early diagnosis", "CT scan image analysis machine learning", "deep learning medical imaging cancer detection", "artificial intelligence computed tomography oncology"]

            **RESPOND ONLY WITH A VALID JSON OBJECT:**
            - The object must contain a single key "queries" which holds an array of strings.
            - Example Format: \`{ "queries": ["Query 1", "Query 2", "Query 3"] }\`
        `
    };

    const prompt = (genQueryPrompts[language] || genQueryPrompts['de'])(user_intent);
    
    try {
        const responseString = await callGemini(prompt, 'gemini-2.5-flash', 0.5);
        taskLogger.debug(`Raw AI query generation response: ${responseString}`);
        
        const jsonMatch = responseString.match(/\{.*\}/s);
        if (!jsonMatch) throw new Error('No JSON object found in AI response for query generation.');
        
        const result = JSON.parse(jsonMatch[0]);
        if (!result.queries || !Array.isArray(result.queries)) throw new Error('Invalid JSON structure in AI response.');

        taskLogger.info(`Generated ${result.queries.length} search queries.`);
        return result.queries;

    } catch (error) {
        taskLogger.error('Error during search query generation', error);
        return [user_intent];
    }
};

const generateMetaSummaryTask = async ({ data: { articles, user_intent, language = 'de' } }) => {
    taskLogger.info(`Generating meta summary for ${articles.length} articles.`);

    const articleTexts = articles.map((a, i) => `ARTIKEL ${i + 1} (Titel: ${a.title}):\n${a.content}\n\n`).join('');

    const metaSummaryPrompts = {
        'de': (intent, content) => `
            Du bist ein hochkarätiger Analyst, der ein tägliches Briefing für einen gut informierten Kunden erstellt. Dein Ziel ist es, **ausschließlich über neue Entwicklungen und signifikante Ereignisse** zu berichten.

            **Grundregel:** Dein Kunde kennt sein Interessengebiet bereits. Wiederhole keine grundlegenden, statischen Fakten. Konzentriere dich auf das, was HEUTE neu ist.

            **Kundeninteresse:**
            "${intent}"

            **Relevante Artikel des Tages:**
            ${content}

            **Deine Aufgabe:**
            Synthetisiere aus den Artikeln eine "Entwicklungs-Zusammenfassung", die sich auf die neuesten und wichtigsten Geschehnisse konzentriert.

            **Beispiel zur Verdeutlichung:**
            - **Kundeninteresse:** "Tech-Aktien"
            - **FALSCH (zu vermeiden):** "Nvidia ist ein GPU-Hersteller, der sich auf KI konzentriert." (Dies ist bekanntes Grundwissen).
            - **RICHTIG (erwünscht):** "Nvidia hat heute seine Quartalszahlen vorgelegt und die Erwartungen übertroffen, was zu einem Anstieg des Aktienkurses führte." ODER "Nvidia kündigte die Veröffentlichung eines neuen KI-Chips, des H200, an."

            **Anweisungen für das Briefing:**
            1.  **Fokus auf Neuigkeiten:** Identifiziere die Kernaussagen der Artikel, die auf neue Ereignisse, Ankündigungen, Zahlen, oder bedeutende Veränderungen hinweisen.
            2.  **Struktur:**
                *   Beginne mit einer prägnanten, übergeordneten Überschrift, die die Top-Entwicklung des Tages zusammenfasst.
                *   Verfasse eine sehr kurze Einleitung (1-2 Sätze), die die wichtigsten neuen Erkenntnisse hervorhebt.
                *   Gliedere den Hauptteil nach den wichtigsten neuen Themen oder Ereignissen. Gib jedem Abschnitt eine klare Überschrift.
            3.  **Synthese:** Fasse die neuen Informationen zusammen und stelle Zusammenhänge her. Liste nicht nur Fakten aus den Artikeln auf, sondern baue eine Erzählung darüber, was passiert ist.
            4.  **Tonfall:** Professionell, auf den Punkt gebracht und analytisch.
            5.  **Formatierung:** Sauberes Markdown. '#' für die Hauptüberschrift, '##' für die Abschnitte.

            Erstelle jetzt das Entwicklungs-Briefing für den Kunden.
        `,
        'en': (intent, content) => `
            You are a top-tier analyst creating a daily briefing for a well-informed client. Your goal is to report **exclusively on new developments and significant events**.

            **Ground Rule:** Your client already knows their area of interest. Do not repeat basic, static facts. Focus on what is NEW today.

            **Client's Intent:**
            "${intent}"

            **Relevant Articles for the Day:**
            ${content}

            **Your Task:**
            Synthesize a "Development Summary" from the articles, focusing on the latest and most important happenings.

            **Clarifying Example:**
            - **Client's Intent:** "Tech Stocks"
            - **WRONG (to avoid):** "Nvidia is a GPU manufacturer that focuses on AI." (This is known, basic information).
            - **RIGHT (desired):** "Nvidia reported its quarterly earnings today, exceeding expectations and leading to a rise in its stock price." OR "Nvidia announced the release of a new AI chip, the H200."

            **Briefing Instructions:**
            1.  **Focus on News:** Identify the key statements in the articles that point to new events, announcements, figures, or significant changes.
            2.  **Structure:**
                *   Start with a concise, high-level headline that summarizes the top development of the day.
                *   Write a very brief introduction (1-2 sentences) highlighting the most important new findings.
                *   Structure the main body by the most important new topics or events. Give each section a clear headline.
            3.  **Synthesis:** Summarize the new information and create connections. Don't just list facts from the articles; build a narrative about what happened.
            4.  **Tone:** Professional, to-the-point, and analytical.
            5.  **Formatting:** Clean Markdown. '#' for the main headline, '##' for sections.

            Now, create the development briefing for the client.
        `
    };

    const prompt = (metaSummaryPrompts[language] || metaSummaryPrompts['de'])(user_intent, articleTexts);

    try {
        const summary = await callGemini(prompt, 'gemini-2.5-flash', 0.3);
        taskLogger.info(`Successfully generated meta summary.`);
        return summary;
    } catch (error) {
        taskLogger.error('Error generating meta summary', error);
        throw new Error(`Failed to generate meta summary: ${error.message}`);
    }
};

const semanticCheckTask = async ({ data: { article, userTopic, language = 'de' } }) => {
    taskLogger.info(`Performing semantic check for article "${article.title}" against topic "${userTopic}"`);

    const semanticCheckPrompts = {
        'de': (topic, articleTitle, articleContent) => `
            Du bist ein intelligenter und kontextbewusster Nachrichtenkurator. Deine Aufgabe ist es, zu beurteilen, ob ein Artikel für einen Nutzer basierend auf seinem Interesse relevant ist. Es geht nicht um einen reinen Keyword-Abgleich, sondern um das Verständnis der Absicht des Nutzers.

            **Nutzerinteresse:**
            "${topic}"

            **Artikel:**
            - **Titel:** "${articleTitle}"
            - **Inhalt (Auszug):** "${articleContent.substring(0, 2500)}..."

            **Deine Aufgabe:**
            1.  Verstehe die Kernabsicht und den Kontext des Nutzerinteresses. Was will der Nutzer wirklich erfahren?
            2.  Beurteile, ob der Artikel einen wertvollen Beitrag zum Interesse des Nutzers leistet. Das bedeutet, er muss nicht exakt das Thema treffen, aber er sollte für jemanden, der sich für dieses Thema interessiert, von Bedeutung sein.
            3.  **Wichtig:** Artikel, die den weiteren Kontext, Debatten oder kritische Auseinandersetzungen zu einem Thema beleuchten, sind relevant.
                *   **Beispiel:** Wenn das Nutzerinteresse "neue EU-Gesetzesvorschläge von Ursula von der Leyen" ist, dann ist ein Artikel mit dem Titel "Kritik an geplanter Chatkontrolle wächst" relevant, weil er die Debatte um einen solchen Vorschlag widerspiegelt.
            4.  Schließe nur Artikel aus, die offensichtlich irrelevant sind oder das Thema nur am Rande erwähnen.
            5.  Gib eine kurze, klare Begründung für deine Entscheidung (1-2 Sätze).

            **ANTWORTE AUSSCHLIESSLICH MIT EINEM GÜLTIGEN JSON-OBJEKT im folgenden Format:**
            \`{ "is_relevant": <true oder false>, "reason": "<deine Begründung>" }\`
        `,
        'en': (topic, articleTitle, articleContent) => `
            You are an intelligent and context-aware news curator. Your task is to judge whether an article is relevant to a user based on their interest. This is not about pure keyword matching, but about understanding the user's intent.

            **User Interest:**
            "${topic}"

            **Article:**
            - **Title:** "${articleTitle}"
            - **Content (Excerpt):** "${articleContent.substring(0, 2500)}..."

            **Your Task:**
            1.  Understand the core intent and context of the user's interest. What does the user really want to know?
            2.  Judge whether the article makes a valuable contribution to the user's interest. This means it doesn't have to match the topic exactly, but it should be significant for someone interested in that topic.
            3.  **Important:** Articles that shed light on the broader context, debates, or critical discussions on a topic are relevant.
                *   **Example:** If the user's interest is "new EU legislative proposals from Ursula von der Leyen," then an article titled "Criticism of planned 'chat control' is growing" is relevant because it reflects the debate surrounding such a proposal.
            4.  Only exclude articles that are obviously irrelevant or only mention the topic in passing.
            5.  Provide a short, clear reason for your decision (1-2 sentences).

            **RESPOND ONLY WITH A VALID JSON OBJECT in the following format:**
            \`{ "is_relevant": <true or false>, "reason": "<your reason>" }\`
        `
    };

    const prompt = (semanticCheckPrompts[language] || semanticCheckPrompts['de'])(userTopic, article.title, article.content);

    try {
        const responseString = await callGemini(prompt, 'gemini-2.5-flash', 0.2);
        taskLogger.debug(`Raw AI semantic check response: ${responseString}`);

        const jsonMatch = responseString.match(/\{.*\}/s);
        if (!jsonMatch) throw new Error('No JSON object found in AI response for semantic check.');
        
        const result = JSON.parse(jsonMatch[0]);
        if (typeof result.is_relevant !== 'boolean' || typeof result.reason !== 'string') {
            throw new Error('Invalid JSON structure in AI response for semantic check.');
        }

        taskLogger.info(`Semantic check for article "${article.title}" complete. Relevant: ${result.is_relevant}`);
        return result;

    } catch (error) {
        taskLogger.error(`Error during semantic check for article "${article.title}"`, error);
        // In case of error, default to not relevant to avoid showing bad content.
        return { is_relevant: false, reason: `Error during analysis: ${error.message}` };
    }
};

module.exports = { semanticCheckTask, orchestrateChatTask, generateSearchQueriesTask, generateMetaSummaryTask };
