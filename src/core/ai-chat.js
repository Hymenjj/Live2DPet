/**
 * Simplified AI Chat for Desktop Pet
 * Supports OpenAI-compatible APIs (Grok, Claude proxy, Deepseek, etc.)
 */
class AIChatClient {
    constructor() {
        this.apiKey = '';
        this.baseURL = 'https://openrouter.ai/api/v1';
        this.modelName = 'x-ai/grok-4.1-fast';
        this.conversationHistory = [];
        this.maxHistoryPairs = 3;
        this.isLoading = false;
        this.maxTokensMultiplier = 1.0;

        // Token usage statistics
        this._tokenStats = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            requestCount: 0,
            startTime: Date.now()
        };
    }

    async init() {
        await this.loadConfig();
        console.log('[AIChatClient] Initialized:', this.baseURL, this.modelName);
    }

    async loadConfig() {
        try {
            if (window.electronAPI && window.electronAPI.loadConfig) {
                const config = await window.electronAPI.loadConfig();
                if (config.apiKey) this.apiKey = config.apiKey;
                if (config.baseURL) this.baseURL = config.baseURL;
                if (config.modelName) this.modelName = config.modelName;
                if (config.maxTokensMultiplier) this.maxTokensMultiplier = Math.min(4.0, Math.max(0.5, config.maxTokensMultiplier));
            }
        } catch (e) {
            console.warn('[AIChatClient] Failed to load config:', e);
        }
    }

    saveConfig(config) {
        if (config.apiKey !== undefined) this.apiKey = config.apiKey;
        if (config.baseURL !== undefined) this.baseURL = config.baseURL;
        if (config.modelName !== undefined) this.modelName = config.modelName;
        if (config.maxTokensMultiplier !== undefined) this.maxTokensMultiplier = Math.min(4.0, Math.max(0.5, config.maxTokensMultiplier));
        if (window.electronAPI && window.electronAPI.saveConfig) {
            window.electronAPI.saveConfig({
                apiKey: this.apiKey,
                baseURL: this.baseURL,
                modelName: this.modelName,
                maxTokensMultiplier: this.maxTokensMultiplier
            });
        }
    }

    getConfig() {
        return { apiKey: this.apiKey, baseURL: this.baseURL, modelName: this.modelName, maxTokensMultiplier: this.maxTokensMultiplier };
    }

    isConfigured() {
        return !!(this.apiKey && this.baseURL && this.modelName);
    }

    /**
     * Send messages directly to the API (for vision/screenshot requests)
     * @param {Array} messages - Full messages array [{role, content}]
     * @returns {string} AI response text
     */
    async callAPI(messages) {
        if (!this.isConfigured()) throw new Error('API not configured');

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);

        try {
            const maxTokens = Math.round(2048 * this.maxTokensMultiplier);
            console.log(`[AIChatClient] Requesting with max_tokens: ${maxTokens}`);
            const response = await fetch(`${this.baseURL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: this.modelName,
                    messages: messages,
                    max_tokens: maxTokens,
                    temperature: 0.86,
                    stream: false
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API error ${response.status}: ${errorText}`);
            }

            // Read response as text first to handle both JSON and SSE formats
            const responseText = await response.text();
            let data;

            try {
                // Try parsing as regular JSON first
                data = JSON.parse(responseText);
            } catch (jsonError) {
                // If JSON parsing fails, try parsing as SSE stream
                if (responseText.startsWith('data:') || responseText.includes('\ndata:')) {
                    console.log('[AIChatClient] Detected SSE stream response, parsing chunks...');
                    data = this._parseSSEResponse(responseText);
                } else {
                    throw new Error(`Invalid API response: ${responseText.substring(0, 200)}`);
                }
            }

            if (!data.choices?.[0]?.message?.content) {
                throw new Error('Empty API response');
            }

            // Track token usage
            this._trackUsage(data.usage);

            return this.cleanResponse(data.choices[0].message.content.trim());
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') throw new Error('API request timeout (120s)');
            throw error;
        }
    }

    /**
     * Parse SSE (Server-Sent Events) stream response into a single completion object
     * @param {string} text - Raw SSE response text
     * @returns {object} Parsed completion object matching OpenAI format
     */
    _parseSSEResponse(text) {
        const lines = text.split('\n');
        let fullContent = '';
        let model = '';
        let id = '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            const jsonStr = trimmed.slice(5).trim();
            if (jsonStr === '[DONE]') break;
            try {
                const chunk = JSON.parse(jsonStr);
                if (chunk.id) id = chunk.id;
                if (chunk.model) model = chunk.model;
                const delta = chunk.choices?.[0]?.delta;
                if (delta?.content) fullContent += delta.content;
            } catch (e) {
                // Skip unparseable chunks
            }
        }

        return {
            id, model,
            choices: [{ message: { role: 'assistant', content: fullContent } }]
        };
    }

    cleanResponse(content) {
        if (!content) return content;
        return content
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
            .replace(/<think>[\s\S]*$/gi, '')
            .replace(/\n\s*\n\s*\n/g, '\n\n')
            .trim();
    }

    async testConnection() {
        try {
            const response = await this.callAPI([
                { role: 'system', content: 'Reply OK.' },
                { role: 'user', content: 'test' }
            ]);
            return { success: true, response };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Track token usage from API response
     */
    _trackUsage(usage) {
        if (!usage) return;
        this._tokenStats.requestCount++;
        this._tokenStats.promptTokens += (usage.prompt_tokens || 0);
        this._tokenStats.completionTokens += (usage.completion_tokens || 0);
        this._tokenStats.totalTokens += (usage.total_tokens || usage.prompt_tokens + usage.completion_tokens || 0);
        console.log(`[AIChatClient] Token usage: +${usage.total_tokens || 0} (total: ${this._tokenStats.totalTokens})`);
    }

    /**
     * Get accumulated token statistics
     */
    getTokenStats() {
        const elapsed = Date.now() - this._tokenStats.startTime;
        const minutes = Math.max(1, elapsed / 60000);
        return {
            ...this._tokenStats,
            elapsedMs: elapsed,
            tokensPerMinute: Math.round(this._tokenStats.totalTokens / minutes * 10) / 10
        };
    }

    /**
     * Reset token statistics
     */
    resetTokenStats() {
        this._tokenStats = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            requestCount: 0,
            startTime: Date.now()
        };
    }
}

window.AIChatClient = AIChatClient;
