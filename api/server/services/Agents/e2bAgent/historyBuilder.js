const { countTokens } = require('@librechat/api');

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__/gi;

const DEFAULTS = {
  messageWindowSize: 24,
  summaryRefreshTurns: 20,
  estimatedSystemTokens: 3000,
  currentUserTokens: 0,
  compactionSummaryMaxTokens: 1200,
};

const cleanText = (text) => (text || '').replace(UUID_PATTERN, '').replace(/\s+/g, ' ').trim();

const formatPromptHistory = (messages) =>
  messages
    .map((msg, idx) => {
      const role = msg.role === 'user' ? 'USER' : 'ASSISTANT';
      return `[${idx + 1}] ${role}: ${msg.content}`;
    })
    .join('\n\n');

const buildCompactionPrompt = ({ olderHistory, recentHistory }) => {
  const olderText = formatPromptHistory(olderHistory);
  const recentText = formatPromptHistory(recentHistory);

  return `You are compacting earlier chat history for a coding/data-analysis assistant.

Task:
- Summarize ONLY the OLDER HISTORY section into structured memory.
- Use RECENT WINDOW only as reference to avoid contradiction.
- Do NOT rewrite turn-by-turn details from RECENT WINDOW.

Output rules:
- Output plain Markdown.
- Use exactly these sections in this exact order:
  1) ## User Goal
  2) ## Completed Steps
  3) ## Key Conclusions
  4) ## Current File/Data State
  5) ## Pending Items
- Keep each section concise and actionable.
- If uncertain, write Unknown explicitly.

OLDER HISTORY:
${olderText}

RECENT WINDOW (REFERENCE ONLY):
${recentText}`;
};

const toSummaryMessage = (summaryContent) => ({
  role: 'system',
  content: `## Prior Conversation Summary (compressed)
${summaryContent}

- Keep this as compressed memory; rely on recent turns for exact details.`,
});

async function countHistoryTokens(history, model) {
  let total = 0;
  for (const msg of history) {
    total += await countTokens(msg.content || '', model);
  }
  return total;
}

async function buildE2BHistory({
  dbMessages,
  currentUserMessageId,
  model,
  config = {},
  summarizeOlderHistory,
}) {
  const opts = {
    ...DEFAULTS,
    ...config,
  };

  const normalized = dbMessages
    .filter((msg) => msg.messageId !== currentUserMessageId)
    .map((msg) => ({
      role: msg.isCreatedByUser ? 'user' : 'assistant',
      content: cleanText(msg.text),
      createdAt: msg.createdAt,
    }))
    .filter((msg) => msg.content.length > 0);

  const rawHistory = normalized.map(({ role, content }) => ({ role, content }));
  const rawTokenEstimate = await countHistoryTokens(rawHistory, model);
  const turnCount = Math.floor(rawHistory.length / 2);
  const estimatedPromptTokensRaw =
    rawTokenEstimate + Number(opts.estimatedSystemTokens || 0) + Number(opts.currentUserTokens || 0);
  const cadenceTurns =
    Math.max(1, Number(opts.summaryRefreshTurns)) || DEFAULTS.summaryRefreshTurns;
  const triggerByCadence = turnCount >= cadenceTurns && turnCount % cadenceTurns === 0;
  const shouldCompress = triggerByCadence;

  const getCompressionReason = (reason) => reason;

  if (!shouldCompress) {
    return {
      history: rawHistory,
      stats: {
        rawMessages: rawHistory.length,
        outputMessages: rawHistory.length,
        rawTokens: rawTokenEstimate,
        outputTokens: rawTokenEstimate,
        savedTokens: 0,
        savedPercent: 0,
        turnCount,
        estimatedPromptTokensRaw,
        estimatedPromptTokensUsed: estimatedPromptTokensRaw,
        summaryRefreshTurns: cadenceTurns,
        messageWindowSize: opts.messageWindowSize,
        compressionReason: getCompressionReason('below-threshold'),
        compressed: false,
        summaryInserted: false,
      },
    };
  }

  const tail = normalized.slice(-opts.messageWindowSize).map(({ role, content }) => ({ role, content }));
  const cutoffIndex = Math.max(0, normalized.length - opts.messageWindowSize);
  const older = normalized.slice(0, cutoffIndex).map(({ role, content }) => ({ role, content }));

  if (older.length === 0) {
    return {
      history: rawHistory,
      stats: {
        rawMessages: rawHistory.length,
        outputMessages: rawHistory.length,
        rawTokens: rawTokenEstimate,
        outputTokens: rawTokenEstimate,
        savedTokens: 0,
        savedPercent: 0,
        turnCount,
        estimatedPromptTokensRaw,
        estimatedPromptTokensUsed: estimatedPromptTokensRaw,
        summaryRefreshTurns: cadenceTurns,
        messageWindowSize: opts.messageWindowSize,
        compressionReason: getCompressionReason('no-older-history'),
        compressed: false,
        summaryInserted: false,
      },
    };
  }

  let summaryContent = '';
  if (typeof summarizeOlderHistory === 'function') {
    summaryContent =
      (await summarizeOlderHistory({
        olderHistory: older,
        recentHistory: tail,
        model,
        maxTokens: Number(opts.compactionSummaryMaxTokens) || DEFAULTS.compactionSummaryMaxTokens,
        prompt: buildCompactionPrompt({ olderHistory: older, recentHistory: tail }),
      })) || '';
  }

  const normalizedSummary = summaryContent.trim();
  if (!normalizedSummary) {
    return {
      history: rawHistory,
      stats: {
        rawMessages: rawHistory.length,
        outputMessages: rawHistory.length,
        rawTokens: rawTokenEstimate,
        outputTokens: rawTokenEstimate,
        savedTokens: 0,
        savedPercent: 0,
        turnCount,
        estimatedPromptTokensRaw,
        estimatedPromptTokensUsed: estimatedPromptTokensRaw,
        summaryRefreshTurns: cadenceTurns,
        messageWindowSize: opts.messageWindowSize,
        compressionReason: getCompressionReason('summary-unavailable'),
        compressed: false,
        summaryInserted: false,
      },
    };
  }

  const summaryMessage = toSummaryMessage(normalizedSummary);
  const output = [summaryMessage, ...tail];
  const outputTokens = await countHistoryTokens(output, model);

  if (outputTokens >= rawTokenEstimate) {
    return {
      history: rawHistory,
      stats: {
        rawMessages: rawHistory.length,
        outputMessages: rawHistory.length,
        rawTokens: rawTokenEstimate,
        outputTokens: rawTokenEstimate,
        savedTokens: 0,
        savedPercent: 0,
        turnCount,
        estimatedPromptTokensRaw,
        estimatedPromptTokensUsed: estimatedPromptTokensRaw,
        summaryRefreshTurns: cadenceTurns,
        messageWindowSize: opts.messageWindowSize,
        compressionReason: getCompressionReason('no-token-savings'),
        compressed: false,
        summaryInserted: false,
      },
    };
  }

  const estimatedPromptTokensUsed =
    outputTokens + Number(opts.estimatedSystemTokens || 0) + Number(opts.currentUserTokens || 0);

  return {
    history: output,
    stats: {
      rawMessages: rawHistory.length,
      outputMessages: output.length,
      rawTokens: rawTokenEstimate,
      outputTokens,
      savedTokens: Math.max(0, rawTokenEstimate - outputTokens),
      savedPercent:
        rawTokenEstimate > 0
          ? Number((((rawTokenEstimate - outputTokens) / rawTokenEstimate) * 100).toFixed(2))
          : 0,
      turnCount,
      estimatedPromptTokensRaw,
      estimatedPromptTokensUsed,
      summaryRefreshTurns: cadenceTurns,
      messageWindowSize: opts.messageWindowSize,
      compressionReason: getCompressionReason('cadence'),
      compressed: true,
      summaryInserted: true,
    },
  };
}

module.exports = {
  buildE2BHistory,
};
