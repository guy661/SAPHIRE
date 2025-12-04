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
        - Call the 'save_intent' function ONLY after you have formulated the final, summarized 'user_intent' AND the user has confirmed that summary (e.g., with "Yes, that's good").
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

const generateSynthesizedSummaryTask = async ({ data: { articles, user_intent, language = 'de', currentDate } }) => {
    taskLogger.info(`Generating a single synthesized summary for ${articles.length} articles.`);

    const articleTexts = articles.map((a, i) => 
        `ARTIKEL ${i + 1} (Quelle: ${new URL(a.link).hostname}, Titel: ${a.fetchedContent.title}):\n${a.fetchedContent.content}\n\n------------------\n\n`
    ).join('');

    const synthesisPrompts = {
        'de': (intent, content, date) => `
            Du bist ein brillanter Chefredakteur. Deine Aufgabe ist es, aus einem Stapel ungefilterter Artikel ein einziges, schlüssiges und prägnantes Briefing für einen sehr beschäftigten Kunden zu erstellen.

            **Kundeninteresse:** "${intent}"
            **Heutiges Datum:** ${date}

            **DEINE ANWEISUNGEN:**
            1.  **SYNTHETISIEREN, NICHT AUFLISTEN:** Deine wichtigste Aufgabe ist es, Verbindungen, Überschneidungen und Widersprüche zwischen den Artikeln zu finden. Fasse nicht jeden Artikel einzeln zusammen. Deine Aufgabe ist es, die Kernaussagen aus allen Artikeln zu einem einzigen, flüssigen Text zu verweben.
            2.  **REDUNDANZ ELIMINIEREN:** Viele Artikel werden dieselben Grundfakten wiederholen. Erwähne eine Information nur einmal. Konzentriere dich auf die Nuancen, die unterschiedlichen Perspektiven oder die einzigartigen Details, die jeder Artikel hinzufügt.
            3.  **STRUKTUR & KLARHEIT:** Gib deinem Briefing eine klare Struktur. 
                - Beginne mit einer aussagekräftigen **Hauptüberschrift**.
                - Fasse die absolut wichtigsten Erkenntnisse in einem **"Kern-Briefing"** von 2-3 Sätzen zusammen.
                - Gliedere den Rest des Textes mit **klaren Zwischenüberschriften**, die die wichtigsten Unterthemen zusammenfassen, die sich aus den Artikeln ergeben.
            4.  **FOKUS AUF RELEVANZ:** Behalte immer das Kundeninteresse im Auge. Nur Informationen, die direkt für dieses Interesse relevant sind, gehören in die Zusammenfassung.

            **VERFÜGBARE ARTIKEL:**
            ${content}

            Erstelle nun das synthetisierte Briefing.
        `,
        'en': (intent, content, date) => `
            You are a brilliant Editor-in-Chief. Your task is to create a single, cohesive, and concise briefing for a very busy client from a pile of unfiltered articles.

            **Client's Interest:** "${intent}"
            **Today's Date:** ${date}

            **YOUR INSTRUCTIONS:**
            1.  **SYNTHESIZE, DON'T LIST:** Your most important job is to find the connections, overlaps, and contradictions between the articles. Do not summarize each article individually. Your job is to weave the key takeaways from all articles into a single, fluid text.
            2.  **ELIMINATE REDUNDANCY:** Many articles will repeat the same basic facts. Mention a piece of information only once. Focus on the nuances, the different perspectives, or the unique details each article adds.
            3.  **STRUCTURE & CLARITY:** Give your briefing a clear structure. 
                - Start with a powerful **Main Headline**.
                - Summarize the absolute most critical findings in a **"Core Briefing"** of 2-3 sentences.
                - Structure the rest of the text with **clear subheadings** that group the main sub-topics emerging from the articles.
            4.  **FOCUS ON RELEVANCE:** Always keep the client's interest in mind. Only information directly relevant to this interest belongs in the summary.

            **AVAILABLE ARTICLES:**
            ${content}

            Now, create the synthesized briefing.
        `
    };

    const prompt = (synthesisPrompts[language] || synthesisPrompts['de'])(user_intent, articleTexts, currentDate);

    try {
        // Using a more capable model for this complex task might be better.
        const summary = await callGemini(prompt, 'gemini-2.5-flash', 0.4);
        taskLogger.info(`Successfully generated synthesized summary.`);
        return summary;
    } catch (error) {
        taskLogger.error('Error generating synthesized summary', error);
        throw new Error(`Failed to generate synthesized summary: ${error.message}`);
    }
};

const generateFollowUpAnswerTask = async ({ data: { question, chatHistory, summary, language = 'de' } }) => {
    taskLogger.info(`Generating follow-up answer for question: "${question.substring(0, 50)}"...`);

    // Clean the history to be safe.
    const cleanedHistory = (chatHistory || []).filter(entry =>
        entry.parts && entry.parts.length > 0 && typeof entry.parts[0].text === 'string' && entry.parts[0].text.trim() !== ''
    );

    // Format the history into a simple string for inclusion in the prompt.
    const historyString = cleanedHistory.map(h => {
        const prefix = h.role === 'user' ? 'Frage des Kunden' : 'Ihre Antwort';
        return `${prefix}: ${h.parts.map(p => p.text).join('')}`;
    }).join('\n\n');

    const answerPrompts = {
        'de': (question, history, summary) => `
            Sie sind ein professioneller und hilfsbereiter KI-Analyst.
            Ihre Aufgabe ist es, Folgefragen eines Kunden zu einem von Ihnen zuvor erstellten Briefing zu beantworten.

            **Das ursprüngliche Briefing, das Sie bereitgestellt haben:**
            ---
            ${summary}
            ---

            **Bisheriger Gesprächsverlauf zu diesem Briefing (falls vorhanden):**
            ---
            ${history || 'Keine früheren Fragen in diesem Gespräch.'}
            ---

            **NEUE FRAGE DES KUNDEN:**
            "${question}"

            **IHRE ANWEISUNGEN:**
            1.  Beantworten Sie die neue Frage des Kunden präzise und hilfreich.
            2.  **Beziehen Sie sich explizit auf Informationen aus dem "ursprünglichen Briefing", wenn die Antwort dort zu finden ist.**
            3.  Wenn das Briefing die Antwort nicht enthält, nutzen Sie Ihr breiteres Wissen, um die Frage bestmöglich zu beantworten.
            4.  Antworten Sie auf Deutsch.
        `,
        'en': (question, history, summary) => `
            You are a professional and helpful AI analyst.
            Your task is to answer follow-up questions from a client about a briefing you previously provided.

            **The original briefing you provided:**
            ---
            ${summary}
            ---

            **Previous conversation about this briefing (if any):**
            ---
            ${history || 'No prior questions in this conversation.'}
            ---

            **CLIENT'S NEW QUESTION:**
            "${question}"

            **YOUR INSTRUCTIONS:**
            1.  Answer the client's new question accurately and helpfully.
            2.  **Explicitly reference information from the "original briefing" if the answer can be found there.**
            3.  If the briefing does not contain the answer, use your broader knowledge to answer the question as best as possible.
            4.  Respond in English.
        `
    };

    const prompt = (answerPrompts[language] || answerPrompts['de'])(question, historyString, summary);

    try {
        // Use the simple, robust callGemini function, following the pattern of working tasks.
        const answer = await callGemini(prompt, 'gemini-2.5-flash', 0.5);
        taskLogger.info(`Successfully generated follow-up answer.`);
        return answer;
    } catch (error) {
        taskLogger.error('Error generating follow-up answer', error);
        throw new Error(`Failed to generate follow-up answer: ${error.message}`);
    }
};

module.exports = { orchestrateChatTask, generateSearchQueriesTask, generateSynthesizedSummaryTask, generateFollowUpAnswerTask };