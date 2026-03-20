import { useCallback, useMemo } from 'react';
import { ContentTypes } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';

import type {
  Text,
  TMessage,
  ImageFile,
  ContentPart,
  PartMetadata,
  TContentData,
  EventSubmission,
  TMessageContentParts,
} from 'librechat-data-provider';
import { addFileToCache } from '~/utils';

const pickFirstNonEmptyString = (...values: Array<string | null | undefined>) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
};

type TUseContentHandler = {
  setMessages: (messages: TMessage[]) => void;
  getMessages: () => TMessage[] | undefined;
};

type TContentHandler = {
  data: TContentData;
  submission: EventSubmission;
};

export default function useContentHandler({ setMessages, getMessages }: TUseContentHandler) {
  const queryClient = useQueryClient();
  const messageMap = useMemo(() => new Map<string, TMessage>(), []);
  return useCallback(
    ({ data, submission }: TContentHandler) => {
      const { type, messageId, thread_id, conversationId, index } = data;

      const _messages = getMessages();
      const existingResponse = _messages?.find((m) => m.messageId === messageId);
      const initialResponseMessageId = submission.initialResponse?.messageId;
      const existingInitialResponse = _messages?.find((m) => m.messageId === initialResponseMessageId);
      const preservedMetrics =
        (existingResponse as (TMessage & { e2bContextMetrics?: unknown }) | undefined)?.e2bContextMetrics ??
        (existingInitialResponse as (TMessage & { e2bContextMetrics?: unknown }) | undefined)
          ?.e2bContextMetrics ??
        (submission.initialResponse as (TMessage & { e2bContextMetrics?: unknown }) | undefined)
          ?.e2bContextMetrics;
      const messages =
        _messages?.filter((m) => m.messageId !== messageId).map((msg) => ({ ...msg, thread_id })) ??
        [];
      const userMessage = messages[messages.length - 1] as TMessage | undefined;

      const { initialResponse } = submission;

      let response = messageMap.get(messageId);
      if (!response) {
        const sender = pickFirstNonEmptyString(existingResponse?.sender, initialResponse?.sender);
        const model = pickFirstNonEmptyString(existingResponse?.model, initialResponse?.model);
        const iconURL = pickFirstNonEmptyString(existingResponse?.iconURL, initialResponse?.iconURL);

        response = {
          ...(initialResponse as TMessage),
          ...(existingResponse ?? {}),
          ...(preservedMetrics != null ? { e2bContextMetrics: preservedMetrics } : {}),
          ...(sender != null ? { sender } : {}),
          ...(model != null ? { model } : {}),
          ...(iconURL != null ? { iconURL } : {}),
          parentMessageId: userMessage?.messageId ?? '',
          conversationId,
          messageId,
          thread_id,
        };
        messageMap.set(messageId, response);
      } else if ((response as TMessage & { e2bContextMetrics?: unknown }).e2bContextMetrics == null && preservedMetrics != null) {
        response = {
          ...response,
          e2bContextMetrics: preservedMetrics,
        } as TMessage;
        messageMap.set(messageId, response);
      }

      const sender = pickFirstNonEmptyString(response.sender, existingResponse?.sender, initialResponse?.sender);
      const model = pickFirstNonEmptyString(response.model, existingResponse?.model, initialResponse?.model);
      const iconURL = pickFirstNonEmptyString(response.iconURL, existingResponse?.iconURL, initialResponse?.iconURL);
      if (sender !== response.sender || model !== response.model || iconURL !== response.iconURL) {
        response = {
          ...response,
          ...(sender != null ? { sender } : {}),
          ...(model != null ? { model } : {}),
          ...(iconURL != null ? { iconURL } : {}),
        };
        messageMap.set(messageId, response);
      }

      // TODO: handle streaming for non-text
      const textPart: Text | string | undefined = data[ContentTypes.TEXT];
      const part: ContentPart =
        textPart != null && typeof textPart === 'string' ? { value: textPart } : data[type];

      if (type === ContentTypes.IMAGE_FILE) {
        addFileToCache(queryClient, part as ImageFile & PartMetadata);
      }

      /* spreading the content array to avoid mutation */
      response.content = [...(response.content ?? [])];

      response.content[index] = { type, [type]: part } as TMessageContentParts;

      const lastContentPart = response.content[response.content.length - 1];
      const initialContentPart = initialResponse.content?.[0];
      if (
        type !== ContentTypes.TEXT &&
        initialContentPart != null &&
        lastContentPart != null &&
        ((lastContentPart.type === ContentTypes.TOOL_CALL &&
          lastContentPart[ContentTypes.TOOL_CALL]?.progress === 1) ||
          lastContentPart.type === ContentTypes.IMAGE_FILE)
      ) {
        response.content.push(initialContentPart);
      }

      setMessages([...messages, response]);
    },
    [queryClient, getMessages, messageMap, setMessages],
  );
}
