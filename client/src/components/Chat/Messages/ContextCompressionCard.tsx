import { memo } from 'react';

type TE2BContextMetrics = {
  compressed?: boolean;
};

type Props = {
  messageId?: string;
  metrics?: TE2BContextMetrics;
};

const metricsByMessageId = new Map<string, TE2BContextMetrics>();

const ContextCompressionCard = memo(({ messageId, metrics }: Props) => {
  const cachedMetrics = messageId ? metricsByMessageId.get(messageId) : undefined;

  if (messageId && metrics != null) {
    // Merge with cache so transient partial frames do not erase known fields.
    const merged = {
      ...(cachedMetrics ?? {}),
      ...metrics,
    };
    metricsByMessageId.set(messageId, merged);
  }

  const effectiveMetrics =
    (messageId ? metricsByMessageId.get(messageId) : undefined) ?? metrics;

  if (!effectiveMetrics || effectiveMetrics.compressed !== true) {
    return null;
  }
  const badgeClass =
    'border-emerald-600/50 bg-emerald-100 text-emerald-800 dark:border-emerald-500/50 dark:bg-emerald-900/30 dark:text-emerald-200';

  return (
    <div className="mb-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full border px-2 py-0.5 font-medium ${badgeClass}`}>
          Context Compressed
        </span>
      </div>
    </div>
  );
});

ContextCompressionCard.displayName = 'ContextCompressionCard';

export default ContextCompressionCard;
