const { retry, callGemini, callGeminiChat, Logger, EMOJIS } = require('./utils.js');

const taskLogger = new Logger('Task', 'yellow', EMOJIS.task);

const headlineCheckTask = async ({ data: { articleTitle, userTopic, language = 'de' } }) => {
    taskLogger.info(`Performing headline check for title "${articleTitle}" against topic "${userTopic.substring(0, 80)}"...`);

    const headlineCheckPrompts = {
        'de': (topic, title) => `
            Du bist ein extrem schneller Nachrichten-Vorsortierer. Deine einzige Aufgabe ist es, anhand des Titels zu entscheiden, ob ein Artikel möglicherweise für das folgende Nutzerinteresse relevant ist. Sei dabei sehr großzügig; schließe nur Artikel aus, deren Titel GANZ KLAR nichts mit dem Thema zu tun hat.

            **Nutzerinteresse:** "${topic}"
            **Artikeltitel:** "${title}"

            **Deine Aufgabe:**
            Antworte mit "ja", wenn der Titel auch nur die geringste Chance hat, relevant zu sein.
            Antworte mit "nein", wenn der Titel offensichtlich und ohne Zweifel irrelevant ist.

            **ANTWORTE AUSSCHLIESSLICH MIT EINEM GÜLTIGEN JSON-OBJEKT im folgenden Format:**
            { "is_headline_relevant": <true oder false> }
        `,
        'en': (topic, title) => `
            You are an extremely fast news pre-sorter. Your only job is to decide from the title alone if an article could possibly be relevant to the following user interest. Be very generous; only exclude articles where the title is OBVIOUSLY unrelated to the topic.

            **User Interest:** "${topic}"
            **Article Title:** "${title}"

            **Your Task:**
            Respond with "yes" if the title has even the slightest chance of being relevant.
            Respond with "no" if the title is obviously and without a doubt irrelevant.
            
            **RESPOND ONLY WITH A VALID JSON OBJECT in the following format:**
            { "is_headline_relevant": <true oder false> }
        `
    };

    const prompt = (headlineCheckPrompts[language] || headlineCheckPrompts['de'])(userTopic, articleTitle);

    try {
        const responseString = await callGemini(prompt, 'gemini-2.5-flash', 0.1);
        taskLogger.debug(`Raw AI headline check response: ${responseString}`);

        const jsonMatch = responseString.match(/\{.*\}/s);
        if (!jsonMatch) {
            taskLogger.warn(`No JSON object found in AI response for headline check. Defaulting to relevant.`);
            return { is_headline_relevant: true };
        }
        
        const result = JSON.parse(jsonMatch[0]);
        if (typeof result.is_headline_relevant !== 'boolean') {
            throw new Error('Invalid JSON structure in AI response for headline check.');
        }

        taskLogger.info(`Headline check for title "${articleTitle}" complete. Potentially relevant: ${result.is_headline_relevant}`);
        return result;

    } catch (error) {
        taskLogger.error(`Error during headline check for title "${articleTitle}"`, error);
        // In case of error, default to relevant to avoid accidentally filtering out good content.
        return { is_headline_relevant: true };
    }
};

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
            3.  **WICHTIGE REGEL: Jede Anfrage darf aus maximal ZWEI Wörtern bestehen.**
            4.  Die Anfragen sollten eine Mischung aus breiteren und spezifischeren Begriffen sein, um die Wahrscheinlichkeit zu maximieren, relevante Artikel zu finden.
            5.  Die Anfragen sollten auf Deutsch sein.

            **Beispiel:**
            - **Nutzerintention:** "Ich interessiere mich für den Einsatz von KI bei der Früherkennung von Lungenkrebs, insbesondere durch die Bildanalyse von CT-Scans."
            - **Gute Suchanfragen:** ["KI Lungenkrebs", "CT-Scan Bildanalyse", "Deep Learning Krebsdiagnose", "KI Onkologie"]

            **ANTWORTE AUSSCHLIESSLICH MIT EINEM GÜLTIGEN JSON-OBJEKT:**
            - Das Objekt muss einen einzigen Schlüssel "queries" enthalten, der ein Array von Strings ist.
            - Beispiel-Format: { "queries": ["Anfrage 1", "Anfrage 2", "Anfrage 3"] }
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
            - Example Format: { "queries": ["Query 1", "Query 2", "Query 3"] }
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

const generateMetaSummaryTask = async ({ data: { articles, user_intent, language = 'de', currentDate } }) => {
    taskLogger.info(`Generating meta summary for ${articles.length} articles.`);

    const articleTexts = articles.map((a, i) => `ARTIKEL ${i + 1} (Veröffentlicht: ${new Date(a.published_at).toLocaleDateString('de-DE')}, Titel: ${a.title}):\n${a.content}\n\n`).join('');

    const metaSummaryPrompts = {
        'de': (intent, content, date) => `
            Du bist ein hochkarätiger, zeitbewusster Analyst, der ein tägliches Briefing für einen gut informierten Kunden erstellt.
            
            **Wichtiger Kontext:**
            - **HEUTE ist der ${date}.** Alle Zeitbezüge wie "heute", "gestern" oder "diese Woche" müssen von diesem Datum aus interpretiert werden.
            - **Kundeninteresse:** "${intent}"
            
            **Deine Aufgabe:**
            Erstelle eine "Entwicklungs-Zusammenfassung", die die neuesten und wichtigsten Geschehnisse basierend auf dem Kundeninteresse und der Zeitpräferenz synthetisiert. Deine Zusammenfassung soll nicht nur informieren, sondern eine kohärente Erzählung schaffen, die die aktuellen Entwicklungen in einen verständlichen Kontext setzt.

            **Grundregeln der Analyse:**
            1.  **Zeitliche Relevanz verstehen:** Interpretiere die Absicht des Nutzers auch im Hinblick auf die Zeit. Ein Nutzer, der nach "Bundestagswahl" fragt, will HEUTE über aktuelle Debatten informiert werden, nicht über die Ergebnisse der letzten Wahl, es sei denn, diese sind für einen aktuellen Kontext relevant.
            2.  **Fokus auf NEUE Entwicklungen:** Dein Kunde kennt sein Interessengebiet. Wiederhole keine statischen Fakten. Konzentriere dich auf das, was sich gerade entwickelt. Ältere Artikel können als Kontext dienen, um aktuelle Ereignisse zu erklären, aber die Zusammenfassung muss die neuesten Informationen priorisieren.
            3.  **Synthese statt Auflistung:** Baue eine kohärente Erzählung. Verbinde Informationen aus verschiedenen Artikeln, um ein vollständiges Bild der aktuellen Lage zu zeichnen. Zeige auf, wie ältere Ereignisse die heutigen Entwicklungen beeinflussen. Ein Beispiel: "Aufbauend auf der Entscheidung von letzter Woche, die Zinsen unverändert zu lassen, hat die Zentralbank nun signalisiert, dass zukünftige Schritte von den Inflationsdaten abhängen werden."
            4. **Personalisierung und Lernen:** Berücksichtige, dass dies eine fortlaufende Konversation ist. Die Zusammenfassungen werden von Tag zu Tag aufgebaut. Wenn ein Thema gestern bereits behandelt wurde, gib heute ein Update, anstatt das Thema neu einzuführen.

            **Struktur des Briefings:**
            1.  **Hauptüberschrift:** Eine prägnante Schlagzeile, die die Top-Entwicklung des Tages zusammenfasst.
            2.  **Einleitung (1-2 Sätze):** Die wichtigsten neuen Erkenntnisse auf den Punkt gebracht.
            3.  **Hauptteil:** Gliedere nach den wichtigsten *neuen* Themen. Jeder Abschnitt bekommt eine klare Überschrift. Nutze ältere Informationen, um Kontext zu geben (z.B. "Aufbauend auf der Entscheidung von letzter Woche, hat die Regierung nun...").

            **Relevante Artikel (sortiert von neu nach alt):**
            ${content}

            Erstelle jetzt das Entwicklungs-Briefing für den Kunden.
        `,
        'en': (intent, content, date) => `
            You are a top-tier, time-aware analyst creating a daily briefing for a well-informed client.

            **Critical Context:**
            - **TODAY is ${date}.** All temporal references like "today," "yesterday," or "this week" must be interpreted from this date.
            - **Client's Intent:** "${intent}"

            **Your Task:**
            Create a "Development Summary" that synthesizes the latest and most important happenings based on the client's interest and time preference. Your summary should not just inform, but create a coherent narrative that places current developments in an understandable context.

            **Core Principles of Analysis:**
            1.  **Understand Temporal Relevance:** Interpret the user's intent with time in mind. A user asking about "election results" TODAY wants to know about current debates, not the outcome of the last election, unless it's relevant context for a current event.
            2.  **Focus on NEW Developments:** Your client knows their field. Don't repeat static facts. Concentrate on what is evolving. Older articles can serve as context to explain current events, but the summary must prioritize the latest information.
            3.  **Synthesize, Don't List:** Build a coherent narrative. Connect information from different articles to paint a complete picture of the current situation. Show how past events influence today's developments. For example: "Building on last week's decision to leave interest rates unchanged, the central bank has now signaled that future moves will depend on inflation data."
            4. **Personalization and Learning:** Keep in mind that this is an ongoing conversation. Summaries will be built up from day to day. If a topic was already covered yesterday, provide an update today instead of re-introducing the topic.

            **Briefing Structure:**
            1.  **Main Headline:** A concise headline summarizing the top development of the day.
            2.  **Introduction (1-2 sentences):** The most critical new findings, straight to the point.
            3.  **Body:** Structure by the most important *new* topics. Each section gets a clear headline. Use older information to provide context (e.g., "Building on last week's decision, the government has now...").
            
            **Relevant Articles (sorted from new to old):**
            ${content}

            Now, create the development briefing for the client.
        `
    };

    const prompt = (metaSummaryPrompts[language] || metaSummaryPrompts['de'])(user_intent, articleTexts, currentDate);

    try {
        const summary = await callGemini(prompt, 'gemini-2.5-flash', 0.3);
        taskLogger.info(`Successfully generated meta summary.`);
        return summary;
    } catch (error) {
        taskLogger.error('Error generating meta summary', error);
        throw new Error(`Failed to generate meta summary: ${error.message}`);
    }
};

const semanticCheckTask = async ({ data: { article, userTopic, language = 'de', currentDate } }) => {
    taskLogger.info(`Performing semantic check for article "${article.title}" against topic "${userTopic.substring(0, 80)}"...`);

    const semanticCheckPrompts = {
        'de': (topic, articleTitle, articleContent, date, article) => `
            Du bist ein intelligenter Nachrichtenkurator. Deine Aufgabe ist es, mit Augenmaß zu beurteilen, ob ein Artikel für einen Nutzer basierend auf seinem Interesse relevant ist.
            
            **Nutzerinteresse:** "${topic}"

            **Artikel:**
            - **Titel:** "${articleTitle}"
            - **Veröffentlicht am:** "${new Date(article.published_at).toLocaleDateString('de-DE')}"
            - **Inhalt (Auszug):** "${articleContent.substring(0, 3000)}..."

            **Deine Aufgabe:**
            1.  **Kernrelevanz prüfen:** Verstehe die Kernabsicht des Nutzerinteresses. Leistet der Artikel einen wertvollen Beitrag zum Thema? Beleuchtet er Hintergründe, Debatten oder wichtige Zusammenhänge?
            2.  **Kontext über Aktualität:** Ein Artikel muss nicht brandaktuell sein, um relevant zu sein. Ältere Artikel, die grundlegendes Wissen oder wichtigen, schwer zu findenden Kontext für aktuelle oder wiederkehrende Themen liefern, sind SEHR WERTVOLL.
                *   **Beispiel:** Wenn das Interesse "Spannungen im Südchinesischen Meer" ist, ist ein detaillierter Analyse-Artikel von vor 6 Monaten, der die historischen Ansprüche erklärt, wahrscheinlich relevant.
            3.  **FINALE ENTSCHEIDUNG:** Sei großzügig. Schließe einen Artikel NUR DANN aus, wenn er ZWEIFELSFREI und OFFENSICHTLICH irrelevant ist (z.B. völlig anderes Thema, eine reine Randnotiz, oder ein Event-Bericht, der durch neuere Ereignisse komplett überholt ist). Im Zweifel gilt der Artikel als relevant.
            4.  **Begründung:** Gib eine kurze, klare Begründung für deine Entscheidung (1-2 Sätze).

            **ANTWORTE AUSSCHLIESSLICH MIT EINEM GÜLTIGEN JSON-OBJEKT im folgenden Format:**
            { "is_relevant": <true oder false>, "reason": "<deine Begründung>" }
        `,
        'en': (topic, articleTitle, articleContent, date, article) => `
            You are an intelligent news curator. Your task is to judge with good judgment whether an article is relevant to a user based on their interest.

            **User Interest:** "${topic}"

            **Article:**
            - **Title:** "${articleTitle}"
            - **Published on:** "${new Date(article.published_at).toLocaleDateString('en-US')}"
            - **Content (Excerpt):** "${articleContent.substring(0, 3000)}..."

            **Your Task:**
            1.  **Check Core Relevance:** Understand the core intent of the user's interest. Does the article make a valuable contribution to the topic? Does it illuminate background, debates, or important context?
            2.  **Context Over Recency:** An article does not have to be brand new to be relevant. Older articles that provide foundational knowledge or important, hard-to-find context for current or recurring topics are VERY VALUABLE.
                *   **Example:** If the interest is "tensions in the South China Sea," a detailed analysis article from 6 months ago explaining the historical claims is likely relevant.
            3.  **FINAL DECISION:** Be generous. Exclude an article ONLY IF it is UNDOUBTEDLY and OBVIOUSLY irrelevant (e.g., a completely different topic, a mere side note, or an event report that is completely superseded by newer events). When in doubt, the article is considered relevant.
            4.  **Reasoning:** Provide a short, clear reason for your decision (1-2 sentences).

            **RESPOND ONLY WITH A VALID JSON OBJECT in the following format:**
            { "is_relevant": <true oder false>, "reason": "<your reason>" }
        `
    };

    const prompt = (semanticCheckPrompts[language] || semanticCheckPrompts['de'])(userTopic, article.title, article.content, currentDate, article);

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

module.exports = { headlineCheckTask, semanticCheckTask, orchestrateChatTask, generateSearchQueriesTask, generateMetaSummaryTask };