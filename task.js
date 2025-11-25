const { retry, callGemini, Logger, EMOJIS } = require('./utils.js');

const taskLogger = new Logger('Task', 'yellow', EMOJIS.task);

const interrogateTopicTask = async ({ data: { userTopic, language = 'de' } }) => {
    taskLogger.info(`Starting topic interrogation for: "${userTopic.main_topic}"`);

    const interrogatePrompts = {
        'de': (topic) => `
            Du bist ein hilfsbereiter, brillanter Forschungsassistent. Deine Aufgabe ist es, die Absicht eines Nutzers zu verstehen und ihm zu helfen, sein Forschungsthema zu präzisieren, um die bestmöglichen Ergebnisse zu erzielen.

            **ANALYSIERE DAS FOLGENDE THEMA:**
            - **Hauptthema:** "${topic.main_topic}"
            - **Einschluss-Keywords:** "${topic.include_keywords || 'Keine'}"
            - **Ausschluss-Keywords:** "${topic.exclude_keywords || 'Keine'}"

            **DEINE AUFGABE (folge diesen Schritten):**

            1.  **BEWERTE DIE SPEZIFITÄT:** Ist das Hauptthema zu breit oder vage für eine präzise Artikelsuche?
                -   Themen wie "KI", "Gesundheit", "Unfall", "Wissenschaft" sind zu breit.
                -   Themen wie "Anwendung von neuronalen Netzen in der medizinischen Diagnostik" sind gut.

            2.  **FORMULIERE DEINE ANTWORT (wähle EINE der beiden Optionen):**

                **OPTION A: Wenn das Thema GUT und SPEZIFISCH ist:**
                -   Antworte mit einem JSON-Objekt, das anzeigt, dass keine Klärung erforderlich ist.

                **OPTION B: Wenn das Thema BREIT oder VAGE ist:**
                -   Formuliere eine freundliche, hilfreiche Frage, die dem Nutzer das Gefühl gibt, dass du ihm hilfst, nicht dass er einen Fehler gemacht hat.
                -   Generiere 2 bis 3 **konkrete, spezifischere Themenvorschläge**, die mögliche Unterbereiche des ursprünglichen Themas darstellen. Die Vorschläge sollten als vollständige, eigenständige Themen formuliert sein.
                -   **Beispiel 1:** Wenn das Thema "Unfall" ist, schlage vor: "Analyse von Verkehrsunfällen mit Fahrerflucht" oder "Prävention von Arbeitsunfällen in der Baubranche".
                -   **Beispiel 2:** Wenn das Thema "KI" ist, frage: "Das ist ein weites Feld! Interessieren Sie sich mehr für die ethischen Implikationen von KI, für die Anwendung in der Robotik oder für die neuesten Durchbrüche bei Sprachmodellen?" und biete entsprechende Vorschläge an.

            **ANTWORTE AUSSCHLIESSLICH MIT EINEM GÜLTIGEN JSON-OBJEKT:**
            -   Kein einleitender Text, kein Markdown, nur das JSON.
            -   **Format für Option A (gutes Thema):**
                \`{ "needsClarification": false, "question": null, "suggestions": [] }\`
            -   **Format für Option B (breites Thema):**
                \`{ "needsClarification": true, "question": "<Deine generierte, hilfreiche Frage>", "suggestions": ["<Vorschlag 1>", "<Vorschlag 2>", "<Vorschlag 3>"] }\`
        `,
        'en': (topic) => `
            You are a helpful, brilliant research assistant. Your job is to understand a user's intent and help them specify their research topic to get the best possible results.

            **ANALYZE THE FOLLOWING TOPIC:**
            - **Main Topic:** "${topic.main_topic}"
            - **Include Keywords:** "${topic.include_keywords || 'None'}"
            - **Exclude Keywords:** "${topic.exclude_keywords || 'None'}"

            **YOUR TASK (follow these steps):**

            1.  **EVALUATE SPECIFICITY:** Is the main topic too broad or vague for a precise article search?
                -   Topics like "AI", "Health", "Accident", "Science" are too broad.
                -   Topics like "Application of neural networks in medical diagnostics" are good.

            2.  **FORMULATE YOUR RESPONSE (choose ONE of the two options):**

                **OPTION A: If the topic is GOOD and SPECIFIC:**
                -   Respond with a JSON object indicating no clarification is needed.

                **OPTION B: If the topic is BROAD or VAGUE:**
                -   Formulate a friendly, helpful question that makes the user feel you're helping, not that they made a mistake.
                -   Generate 2 to 3 **concrete, more specific topic suggestions** that represent possible sub-areas of the original topic. The suggestions should be phrased as complete, standalone topics.
                -   **Example 1:** If the topic is "Accident", suggest: "Analysis of traffic accidents involving hit-and-run" or "Prevention of work accidents in the construction industry".
                -   **Example 2:** If the topic is "AI", ask: "That's a broad field! Are you more interested in the ethical implications of AI, its application in robotics, or the latest breakthroughs in language models?" and provide corresponding suggestions.

            **RESPOND ONLY WITH A VALID JSON OBJECT:**
            -   No introductory text, no markdown, just the JSON.
            -   **Format for Option A (good topic):**
                \`{ "needsClarification": false, "question": null, "suggestions": [] }\`
            -   **Format for Option B (broad topic):**
                \`{ "needsClarification": true, "question": "<Your generated, helpful question>", "suggestions": ["<Suggestion 1>", "<Suggestion 2>", "<Suggestion 3>"] }\`
        `
    };
    
    const getInterrogatePrompt = interrogatePrompts[language] || interrogatePrompts['de'];
    const prompt = getInterrogatePrompt(userTopic);

    try {
        const responseString = await callGemini(prompt, 'gemini-2.5-flash', 0.5);
        taskLogger.debug(`Raw AI interrogation response: ${responseString}`);

        const jsonMatch = responseString.match(/\{.*\}/s);
        if (!jsonMatch) {
            throw new Error('No JSON object found in AI response for interrogation.');
        }

        const decision = JSON.parse(jsonMatch[0]);
        taskLogger.info(`Parsed AI interrogation for "${userTopic.main_topic}": needsClarification = ${decision.needsClarification}`);
        return decision;

    } catch (error) {
        taskLogger.error(`Error during topic interrogation for "${userTopic.main_topic}"`, error);
        // Fallback to a safe response if the AI fails
        return { needsClarification: false, question: null, suggestions: [] };
    }
};

const summarizeArticleTask = async ({ data: { article, style = 'paragraph', language = 'de' } }) => {
    taskLogger.info(`Starting summary for: ${article.link} (Style: ${style}, Lang: ${language})`);
    
    if (!article.content || typeof article.content !== 'string') {
        const error = new Error('Article content is missing or invalid.');
        taskLogger.error(`Article content is missing or not a string for article ${article.link}.`, error);
        throw error;
    }

    const summarizePrompts = {
        'de': {
            'paragraph': `Du bist ein erfahrener Redakteur. Fasse den folgenden Artikel prägnant in **zwei bis drei Sätzen** zusammen. Konzentriere dich auf die Kernaussage und die wichtigsten Schlussfolgerungen. Antworte nur mit der Zusammenfassung, ohne einleitende Floskeln.`,
            'bullets': `Du bist ein Analyst, der Informationen für ein schnelles Briefing aufbereitet. Extrahiere die **drei bis fünf wichtigsten Kernaussagen** aus dem folgenden Artikel und präsentiere sie als Stichpunkte (mit '-' am Anfang jeder Zeile). Antworte nur mit den Stichpunkten.`
        },
        'en': {
            'paragraph': `You are an expert editor. Concisely summarize the following article in **two to three sentences**. Focus on the core message and key conclusions. Respond only with the summary, without any introductory phrases.`,
            'bullets': `You are an analyst preparing information for a rapid briefing. Extract the **three to five most important key points** from the following article and present them as bullet points (using '-' at the start of each line). Respond only with the bullet points.`
        }
    };

    const langPrompts = summarizePrompts[language] || summarizePrompts['de'];
    const promptTemplate = langPrompts[style] || langPrompts['paragraph'];
    
    const fullPrompt = `${promptTemplate}\n\nARTIKELTEXT:\n"""\n${article.content.substring(0, 8000)}\n"""`;

    try {
        const summary = await callGemini(fullPrompt, 'gemini-2.5-flash', 0.2);
        taskLogger.info(`Successfully summarized: ${article.link}`);
        return { ...article, summary };
    } catch (error) {
        taskLogger.error(`Error summarizing article ${article.link}`, error);
        throw new Error(`Failed to summarize article: ${error.message}`);
    }
};

const semanticCheckTask = async ({ data: { article, userTopic, language = 'de' } }) => {
    taskLogger.info(`Starting semantic check for: ${article.link} (Lang: ${language})`);

    if (!article.content || typeof article.content !== 'string') {
        const error = new Error('Article content is missing or invalid.');
        taskLogger.error(`Article content is missing or not a string for article ${article.link}.`, error);
        throw error;
    }
    
    const semanticCheckPrompts = {
        'de': (userTopic, articleText, title) => `
            Du bist ein anspruchsvoller, intelligenter Gatekeeper für Content. Deine Aufgabe ist es, die wahre Absicht eines Nutzers zu verstehen und zu schützen. Lehne alles ab, was nicht eine direkte und zufriedenstellende Antwort auf das ist, was der Nutzer WIRKLICH wissen wollte. Sei extrem wählerisch.

            **SCHLÜSSELELEMENTE DER ANALYSE:**

            1.  **Verstehe die Nutzerintention:**
                -   **Hauptthema:** "${userTopic.main_topic}"
                -   **Spezifizierung:** "${userTopic.specification || 'Keine'}"
                -   Stell dir vor, du bist der Nutzer. Was ist die **Frage hinter der Suchanfrage**? Sucht der Nutzer nach einer Einführung, einer tiefen technischen Analyse, einer Nachrichtenmeldung, einer Meinung?
                -   Versetz dich in die Lage des Nutzers, der nach diesem Thema sucht. Wäre dieser Artikel ein Volltreffer, der die Suche beendet, oder nur ein "vielleicht interessant"? Nur Volltreffer sind relevant.

            2.  **Bewerte den Artikelinhalt KRITISCH:**
                -   **Titel:** "${title}"
                -   **Text-Ausschnitt:** "${articleText.substring(0, 3000)}..."

            3.  **SYNTHESE & ENTSCHEIDUNG (folge diesen Schritten):**

                a. **Ist das Thema des Artikels wirklich das Hauptthema des Nutzers?** Eine bloße Erwähnung von Keywords reicht nicht. Der *Kernfokus* des Artikels muss mit der *Nutzerintention* übereinstimmen. Die Spezifizierung ist hierbei ein entscheidender Hinweis.
                
                b. **Keyword-Abgleich (im Kontext der Intention):**
                   - **Muss enthalten:** "${userTopic.include_keywords || 'Keine'}". Werden diese Konzepte *zentral* und im Sinne der Nutzerintention diskutiert, oder nur am Rande erwähnt? Eine beiläufige Nennung ist wertlos.
                   - **Muss ausschließen:** "${userTopic.exclude_keywords || 'Keine'}". Das Finden eines dieser Wörter führt zur **sofortigen Irrelevanz**, es sei denn, der Kontext ist eindeutig nicht-exklusiv (z.B. "Unternehmen X, nicht zu verwechseln mit Y").

                c. **FINALES URTEIL:** Würdest du als Nutzer, nachdem du diesen Artikel gelesen hast, deine Suche als erfolgreich betrachten und beenden? Oder würdest du weiter nach besseren Ergebnissen suchen?

            **ANTWORTE AUSSCHLIESSLICH MIT EINEM GÜLTIGEN JSON-OBJEKT:**
            - Kein einleitender Text, kein Markdown, nur das JSON.
            - Format: \`{ "is_relevant": <boolean>, "reason": "<Deine prägnante Begründung, warum der Artikel aus Nutzersicht ein Volltreffer ist oder eben nicht.>" }\`
        `,
        'en': (userTopic, articleText, title) => `
            You are a sophisticated, intelligent content gatekeeper. Your mission is to understand and protect a user's true intent. Reject anything that isn't a direct and satisfying answer to what the user REALLY wanted to know. Be extremely selective.

            **KEY ELEMENTS FOR ANALYSIS:**

            1.  **Understand User Intent:**
                -   **Main Topic:** "${userTopic.main_topic}"
                -   **Specification:** "${userTopic.specification || 'None'}"
                -   Imagine you are the user. What is the **underlying question** behind this search query? Is the user looking for an introduction, a deep technical analysis, a news update, an opinion piece?
                -   Put yourself in the user's shoes. Would this article be a "bullseye" hit that ends their search, or just a "maybe interesting" tangent? Only bullseye hits are relevant.

            2.  **Critically Evaluate Article Content:**
                -   **Title:** "${title}"
                -   **Article Snippet:** "${articleText.substring(0, 3000)}..."

            3.  **SYNTHESIS & DECISION (follow these steps):**

                a. **Is the article's topic truly the user's main topic?** A mere mention of keywords is not enough. The *core focus* of the article must align with the *user's intent*. The specification is a critical clue here.

                b. **Keyword Alignment (in the context of intent):**
                   - **Must Include:** "${userTopic.include_keywords || 'None'}". Are these concepts discussed *centrally* and in line with the user's intent, or just mentioned in passing? A casual mention is worthless.
                   - **Must Exclude:** "${userTopic.exclude_keywords || 'None'}". Finding one of these words means **immediate irrelevance**, unless the context is clearly non-exclusive (e.g., "Company X, not to be confused with Y").

                c. **FINAL JUDGMENT:** As the user, after reading this article, would you consider your search successful and complete? Or would you continue looking for better results?

            **RESPOND ONLY WITH A VALID JSON OBJECT:**
            - No introductory text, no markdown, just the JSON.
            - Format: \`{ "is_relevant": <boolean>, "reason": "<Your concise reasoning explaining why the article is or is not a bullseye hit from the user's perspective.>" }\`
        `
    };

    const getSemanticPrompt = semanticCheckPrompts[language] || semanticCheckPrompts['de'];
    const prompt = getSemanticPrompt(userTopic, article.content, article.title);
    
    taskLogger.info(`Prompt created for ${article.link}.`);

    try {
        const decisionString = await retry(() => callGemini(prompt, 'gemini-2.5-flash', 0.0));
        taskLogger.debug(`Raw AI response received: ${decisionString}`);
        
        const jsonMatch = decisionString.match(/\{.*\}/s);
        if (!jsonMatch) {
            throw new Error(`No JSON object found in AI response.`);
        }

        const decision = JSON.parse(jsonMatch[0]);
        taskLogger.debug(`Extracted JSON string: ${jsonMatch[0]}`);
        taskLogger.info(`Parsed AI decision for ${article.link}: ${decision.is_relevant}.`);
        
        return { ...article, is_relevant: decision.is_relevant, reason: decision.reason };

    } catch (error) {
        taskLogger.error(`Error during semantic check for ${article.link}`, error);
        throw new Error(`Failed to perform semantic check: ${error.message}`);
    }
};


module.exports = { summarizeArticleTask, semanticCheckTask, interrogateTopicTask };