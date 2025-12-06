const { retry, callGemini, callGeminiChat, Logger, EMOJIS } = require('./utils.js');

const taskLogger = new Logger('Task', 'yellow', EMOJIS.task);

const orchestrateChatTask = async ({ data: { chatHistory, language = 'de' } }) => {
    // taskLogger.info(`Orchestrating chat with history length: ${chatHistory.length}`);

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
            // taskLogger.info(`AI responded with text: "${result}"`);
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
    // taskLogger.info(`Generating search queries for intent: "${user_intent.substring(0, 50)}"...`);

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
        // taskLogger.debug(`Raw AI query generation response: ${responseString}`);
        
        const jsonMatch = responseString.match(/\{.*\}/s);
        if (!jsonMatch) throw new Error('No JSON object found in AI response for query generation.');
        
        const result = JSON.parse(jsonMatch[0]);
        if (!result.queries || !Array.isArray(result.queries)) throw new Error('Invalid JSON structure in AI response.');

        // taskLogger.info(`Generated ${result.queries.length} search queries.`);
        return result.queries;

    } catch (error) {
        taskLogger.error('Error during search query generation', error);
        return [user_intent];
    }
};

const db = require('./database-postgres.js'); // Import database functions

// ... (other functions remain the same)

const generateSynthesizedSummaryTask = async ({ data }) => {
    const { articles, user_intent, language = 'de', currentDate, userContext } = data;
    // taskLogger.info(`Generating a new CONTEXT-AWARE synthesized summary for ${articles.length} articles.`);

    // --- 1. Enrich Context ---
    const [likedTopics, dislikedTopics, previousTopics] = await Promise.all([
        db.getClusterTitlesByIds(userContext.likedClusterIds || []),
        db.getClusterTitlesByIds(userContext.dislikedClusterIds || []),
        db.getClusterTitlesByIds(userContext.previousClusterIds || [])
    ]);
    
    const likedTopicTitles = likedTopics.map(t => t.representative_title);
    const dislikedTopicTitles = dislikedTopics.map(t => t.representative_title);
    const previousTopicIds = userContext.previousClusterIds || [];

    // --- 2. Prepare Today's Topics ---
    const todayTopics = articles.map(a => ({
        id: a.clusterId,
        title: a.fetchedContent.title,
        summary: a.fetchedContent.content
    }));

    const continuingTopics = todayTopics.filter(t => previousTopicIds.includes(t.id));
    const newTopics = todayTopics.filter(t => !previousTopicIds.includes(t.id));

    // --- 3. Build Prompt Components ---
    const formatTopics = (topicArray) => topicArray.length > 0 ? topicArray.map(t => `- "${t.title}": ${t.summary}`).join('\n') : 'Keine.';
    
    const likedTopicsString = likedTopicTitles.length > 0 ? likedTopicTitles.map(t => `- ${t}`).join('\n') : 'Keine bekannt.';
    const dislikedTopicsString = dislikedTopicTitles.length > 0 ? dislikedTopicTitles.map(t => `- ${t}`).join('\n') : 'Keine bekannt.';
    const continuingTopicsString = formatTopics(continuingTopics);
    const newTopicsString = formatTopics(newTopics);

    const synthesisPrompts = {
        'de': `
            Du bist ein persönlicher Nachrichten-Chefanalyst. Deine Aufgabe ist es, für einen sehr beschäftigten Kunden ein extrem relevantes, aufbauendes und personalisiertes Briefing zu erstellen. Der Kunde hasst Redundanz und will nur wissen, was wirklich neu und für ihn wichtig ist.

            **KUNDEN-PROFIL:**
            - **Allgemeines Interesse:** "${user_intent}"
            - **Bevorzugte Themen (Likes):**\n${likedTopicsString}
            - **Ignorierte Themen (Dislikes):**\n${dislikedTopicsString}

            **HEUTIGES DATUM:** ${currentDate}

            **VERFÜGBARE INFORMATIONEN FÜR HEUTE:**
            
            **1. Fortgeführte Themen (Updates zu gestern):**
            ${continuingTopicsString}

            **2. Völlig neue Themen für heute:**
            ${newTopicsString}
            
            **DEINE ANWEISUNGEN - Folge diesen Regeln strikt:**
            1.  **BEGINNE MIT UPDATES:** Starte das Briefing, indem du die fortgeführten Themen behandelst. Sage explizit, dass dies Updates sind. Fasse **nur die neuen Entwicklungen** zusammen. Wiederhole unter keinen Umständen Informationen, die der Kunde wahrscheinlich schon kennt. Beispiel: "Anknüpfend an die gestrige Berichterstattung über [Thema], gibt es heute folgende neue Entwicklung: ..."
            2.  **PRÄSENTIERE NEUE THEMEN:** Behandle danach die völlig neuen Themen. Leite diesen Abschnitt klar ein. Beispiel: "Zusätzlich gibt es heute einige neue, wichtige Themen:"
            3.  **PERSONALISIEREN & PRIORISIEREN:**
                - Themen, die den "Likes" des Kunden ähneln, sollten prominenter und ausführlicher behandelt werden. Hebe sie hervor.
                - Themen, die den "Dislikes" ähneln, sollten nur kurz erwähnt oder ganz weggelassen werden, es sei denn, sie sind von überragender allgemeiner Bedeutung.
            4.  **SYNTHETISIEREN, NICHT AUFLISTEN:** Webe alle Informationen zu einem einzigen, flüssigen und gut lesbaren Text zusammen. Erstelle keine simple Liste von Zusammenfassungen. Finde Verbindungen, auch zwischen neuen und alten Themen.
            5.  **FAKTENCHECK & NEUTRALITÄT (WICHTIG):** Wenn du innerhalb eines Themas widersprüchliche Informationen aus verschiedenen Quellen findest, stelle diesen Widerspruch explizit dar. Formuliere neutral. Beispiel: "Während Quelle A berichtet, dass X passiert ist, deutet Quelle B darauf hin, dass Y der Fall sein könnte." Stelle Meinungen nicht als Fakten dar.
            6.  **STRUKTUR:** Gib dem Briefing eine starke Hauptüberschrift und ein "Kern-Briefing" (2-3 Sätze) am Anfang, das die absolut wichtigsten neuen Erkenntnisse des Tages zusammenfasst. Gliedere den Rest mit klaren Zwischenüberschriften.

            Erstelle nun das persönliche, aufbauende Briefing für den Kunden auf Deutsch.
        `,
        'en': `
            You are a personal Chief News Analyst. Your task is to create an extremely relevant, evolving, and personalized briefing for a very busy client. The client hates redundancy and only wants to know what is truly new and important to them.

            **CLIENT PROFILE:**
            - **General Interest:** "${user_intent}"
            - **Preferred Topics (Likes):**\n${likedTopicsString}
            - **Ignored Topics (Dislikes):**\n${dislikedTopicsString}

            **TODAY'S DATE:** ${currentDate}

            **AVAILABLE INFORMATION FOR TODAY:**
            
            **1. Continuing Topics (Updates from yesterday):**
            ${continuingTopicsString}

            **2. Completely New Topics for today:**
            ${newTopicsString}
            
            **YOUR INSTRUCTIONS - Follow these rules strictly:**
            1.  **START WITH UPDATES:** Begin the briefing by addressing the continuing topics. Explicitly state that these are updates. Summarize **only the new developments**. Do not repeat information the client likely already knows. Example: "Following up on yesterday's reporting on [Topic], today brings a new development: ..."
            2.  **PRESENT NEW TOPICS:** After that, cover the completely new topics. Clearly introduce this section. Example: "In addition, there are several new, important topics today:"
            3.  **PERSONALIZE & PRIORITIZE:**
                - Topics similar to the client's "Likes" should be featured more prominently and in more detail. Highlight them.
                - Topics similar to the "Dislikes" should be mentioned briefly or omitted entirely, unless they are of overwhelming general importance.
            4.  **SYNTHESIZE, DON'T LIST:** Weave all information into a single, fluid, and easy-to-read text. Do not create a simple list of summaries. Find connections, even between new and old topics.
            5.  **FACT-CHECK & NEUTRALITY (IMPORTANT):** If you find conflicting information from different sources within a topic, explicitly state this conflict. Use neutral language. Example: "While source A reports that X happened, source B suggests that Y might be the case." Do not present opinions as facts.
            6.  **STRUCTURE:** Give the briefing a strong main headline and a "Core Briefing" (2-3 sentences) at the top that summarizes the absolute most important new findings of the day. Structure the rest with clear subheadings.

            Now, create the personal, evolving briefing for the client in English.
        `
    };

    const prompt = (synthesisPrompts[language] || synthesisPrompts['de']);

    try {
        // Using a more capable model for this complex task is recommended. E.g. gemini-1.5-pro
        const summary = await callGemini(prompt, 'gemini-2.5-flash', 0.4);
        taskLogger.info(`Successfully generated CONTEXT-AWARE synthesized summary.`);
        return summary;
    } catch (error) {
        taskLogger.error('Error generating context-aware synthesized summary', error);
        throw new Error(`Failed to generate context-aware synthesized summary: ${error.message}`);
    }
};

// ... (the rest of the file, generateFollowUpAnswerTask etc., remains the same)


const generateFollowUpAnswerTask = async ({ data: { question, chatHistory, summary, language = 'de' } }) => {
    // taskLogger.info(`Generating follow-up answer for question: "${question.substring(0, 50)}"...`);

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
        // taskLogger.info(`Successfully generated follow-up answer.`);
        return answer;
    } catch (error) {
        taskLogger.error('Error generating follow-up answer', error);
        throw new Error(`Failed to generate follow-up answer: ${error.message}`);
    }
};

const generateClusterAnalysisTask = async ({ data: { articles, user_intent, language = 'de' } }) => {
    // taskLogger.info(`Generating analysis for a cluster of ${articles.length} articles.`);

    const articleTexts = articles.map((a, i) => 
        `ARTIKEL ${i + 1} (Quelle: ${a.sourceName || 'Unbekannt'}, Titel: ${a.fetchedContent.title}):\n${a.fetchedContent.content}\n\n---\n\n`
    ).join('');

    const analysisPrompts = {
        'de': (intent, content) => `
            Sie sind ein präziser und unparteiischer Nachrichtenanalyst. Ihre Aufgabe ist es, eine Gruppe von Artikeln zu einem einzigen Thema zu analysieren und eine strukturierte Zusammenfassung zu erstellen.

            **Kundeninteresse:** "${intent}"

            **ARTIKEL ZUM THEMA:**
            ${content}

            **IHRE AUFGABE:**
            Analysieren Sie die bereitgestellten Artikel und geben Sie **AUSSCHLIESSLICH ein einziges, gültiges JSON-Objekt** zurück, ohne einleitenden Text. Das JSON-Objekt muss die folgende Struktur haben:
            {
              "summary": "Eine kurze, prägnante Zusammenfassung der wichtigsten Informationen aus den Artikeln in 2-4 Sätzen. Synthetisieren Sie die Kernaussagen, listen Sie nicht nur Fakten auf.",
              "sentiment": "Beschreiben Sie die allgemeine Stimmung oder den Ton der Berichterstattung. Wählen Sie EINEN der folgenden Werte: 'Positiv', 'Negativ', 'Neutral'.",
              "focus": "Identifizieren Sie den primären Fokus der Artikel. Wählen Sie EINEN der folgenden Werte: 'Politik', 'Wirtschaft', 'Technologie', 'Gesellschaft', 'Wissenschaft', 'Gesundheit', 'Sport', 'Kultur', 'Sonstiges'.",
              "bias": "Bewerten Sie die wahrgenommene politische Tendenz der Berichterstattung. Seien Sie konservativ in Ihrer Einschätzung. Wählen Sie EINEN der folgenden Werte: 'Links-orientiert', 'Rechts-orientiert', 'Mitte/Neutral'."
            }
        `,
        'en': (intent, content) => `
            You are a precise and impartial news analyst. Your task is to analyze a group of articles on a single topic and provide a structured summary.

            **Client's Interest:** "${intent}"

            **ARTICLES ON THE TOPIC:**
            ${content}

            **YOUR TASK:**
            Analyze the provided articles and return **ONLY a single, valid JSON object** with no introductory text. The JSON object must have the following structure:
            {
              "summary": "A short, concise summary of the key information from the articles in 2-4 sentences. Synthesize the core findings, don't just list facts.",
              "sentiment": "Describe the overall sentiment or tone of the reporting. Choose ONE of the following: 'Positive', 'Negative', 'Neutral'.",
              "focus": "Identify the primary focus of the articles. Choose ONE of the following: 'Politics', 'Business', 'Technology', 'Society', 'Science', 'Health', 'Sports', 'Culture', 'Other'.",
              "bias": "Assess the perceived political bias of the reporting. Be conservative in your assessment. Choose ONE of the following: 'Left-leaning', 'Right-leaning', 'Center/Neutral'."
            }
        `
    };

    const prompt = (analysisPrompts[language] || analysisPrompts['de'])(user_intent, articleTexts);

    try {
        const responseString = await callGemini(prompt, 'gemini-2.5-flash', 0.2);
        // taskLogger.debug(`Raw AI cluster analysis response: ${responseString}`);
        
        const jsonMatch = responseString.match(/\{.*\}/s);
        if (!jsonMatch) throw new Error('No JSON object found in AI response for cluster analysis.');
        
        const result = JSON.parse(jsonMatch[0]);
        // Basic validation
        if (!result.summary || !result.sentiment || !result.focus || !result.bias) {
            throw new Error('Invalid JSON structure in AI response for cluster analysis.');
        }

        // taskLogger.info(`Successfully generated analysis for cluster.`);
        return result;

    } catch (error) {
        taskLogger.error('Error generating cluster analysis', error);
        // Return a default error structure
        return {
            summary: "Die Analyse für diese Artikelgruppe ist fehlgeschlagen.",
            sentiment: "Unbekannt",
            focus: "Unbekannt",
            bias: "Unbekannt"
        };
    }
};

const semanticClusteringTask = async ({ data: { articles, user_intent, language = 'de' } }) => {
    // articles expects array of { id, title, content }
    
    // Limit content per article to save tokens, title is most important for clustering often
    const articlesText = articles.map((a, index) => 
        `[ID: ${index}] TITEL: ${a.fetchedContent.title}\nTEASER: ${a.fetchedContent.content.substring(0, 200)}...`
    ).join('\n\n');

    const prompt = `
        Du bist ein intelligenter News-Editor. Deine Aufgabe ist es, eine Liste von Artikeln zu analysieren, irrelevante auszusortieren und die relevanten in logische Themen-Cluster zu gruppieren.

        **User-Interesse:** "${user_intent}"

        **Artikel-Liste:**
        ${articlesText}

        **Anweisungen:**
        1.  **Filterung:** Ignoriere Artikel, die nichts mit dem User-Interesse zu tun haben, Werbung sind oder keinen echten Inhalt haben.
        2.  **Clustering:** Gruppiere die verbleibenden, relevanten Artikel in thematische Cluster. Artikel, die über dasselbe Ereignis oder Thema berichten, gehören in einen Cluster.
        3.  Gib jedem Cluster einen prägnanten Titel.

        **Antworte AUSSCHLIESSLICH mit diesem JSON-Format:**
        {
            "clusters": [
                {
                    "title": "Titel des Themas (z.B. 'Neuer KI-Durchbruch')",
                    "article_ids": [0, 5, 12] // IDs der Artikel in diesem Cluster
                },
                {
                    "title": "Weiteres Thema",
                    "article_ids": [1, 4]
                }
            ]
        }
    `;

    try {
        // Use a slightly higher temperature for creative grouping
        const responseString = await callGemini(prompt, 'gemini-2.5-flash', 0.3);
        const jsonMatch = responseString.match(/\{.*\}/s);
        if (!jsonMatch) throw new Error("No JSON found");
        
        const result = JSON.parse(jsonMatch[0]);
        return result.clusters || [];

    } catch (error) {
        taskLogger.error('Error in semantic clustering', error);
        return [];
    }
};

module.exports = { orchestrateChatTask, generateSearchQueriesTask, generateSynthesizedSummaryTask, generateFollowUpAnswerTask, generateClusterAnalysisTask, semanticClusteringTask };