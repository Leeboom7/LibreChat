import React, { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { TMessageProps, TMessageIcon } from '~/common';
import { useMessageHelpers, useLocalize, useAttachments } from '~/hooks';
import MessageIcon from '~/components/Chat/Messages/MessageIcon';
import ContextCompressionCard from '~/components/Chat/Messages/ContextCompressionCard';
import ContentParts from './Content/ContentParts';
import { fontSizeAtom } from '~/store/fontSize';
import SiblingSwitch from './SiblingSwitch';
import MultiMessage from './MultiMessage';
import HoverButtons from './HoverButtons';
import SubRow from './SubRow';
import { cn, getMessageAriaLabel } from '~/utils';
import store from '~/store';

const labelCacheByMessageId = new Map<string, string>();

function pushLabelDebug(message: string) {
  if (typeof window === 'undefined') {
    return;
  }

  const key = '__E2BLabelDebugEvents__';
  const target = window as unknown as Record<string, unknown>;
  const list = Array.isArray(target[key]) ? (target[key] as Array<unknown>) : [];
  list.push({ ts: Date.now(), message });
  target[key] = list.slice(-200);
}

export default function Message(props: TMessageProps) {
  const localize = useLocalize();
  const { message, siblingIdx, siblingCount, setSiblingIdx, currentEditId, setCurrentEditId } =
    props;
  const { attachments, searchResults } = useAttachments({
    messageId: message?.messageId,
    attachments: message?.attachments,
  });
  const {
    edit,
    index,
    agent,
    isLast,
    enterEdit,
    assistant,
    handleScroll,
    conversation,
    isSubmitting,
    latestMessage,
    handleContinue,
    copyToClipboard,
    regenerateMessage,
  } = useMessageHelpers(props);

  const fontSize = useAtomValue(fontSizeAtom);
  const maximizeChatSpace = useRecoilValue(store.maximizeChatSpace);
  const { children, messageId = null, isCreatedByUser } = message ?? {};

  const name = useMemo(() => {
    let result = '';
    if (isCreatedByUser === true) {
      result = localize('com_user_message');
    } else if (assistant) {
      result = assistant.name ?? localize('com_ui_assistant');
    } else if (agent) {
      result = agent.name ?? localize('com_ui_agent');
    } else {
      const sender = (message?.sender ?? '').trim();
      result = sender.length > 0 ? sender : localize('com_ui_assistant');
    }

    const safeResult = (result || '').trim();
    if (messageId && safeResult.length > 0) {
      if (safeResult !== labelCacheByMessageId.get(messageId)) {
        pushLabelDebug(`[E2B UI][LabelDebug] parts-set-cache id=${messageId} label="${safeResult}"`);
      }
      labelCacheByMessageId.set(messageId, safeResult);
      return safeResult;
    }

    if (messageId) {
      const cached = labelCacheByMessageId.get(messageId);
      if (cached && cached.length > 0) {
        pushLabelDebug(
          `[E2B UI][LabelDebug] parts-use-cache id=${messageId} cached="${cached}" raw="${result ?? ''}"`,
        );
        return cached;
      }
    }

    const fallback = isCreatedByUser ? localize('com_user_message') : localize('com_ui_assistant');
    pushLabelDebug(
      `[E2B UI][LabelDebug] parts-fallback id=${messageId ?? 'unknown'} isUser=${String(isCreatedByUser)} raw="${result ?? ''}" fallback="${fallback}"`,
    );
    return fallback;
  }, [assistant, agent, isCreatedByUser, localize, message?.sender, messageId]);

  const iconData: TMessageIcon = useMemo(
    () => ({
      endpoint: message?.endpoint ?? conversation?.endpoint,
      model: message?.model ?? conversation?.model,
      iconURL: message?.iconURL ?? conversation?.iconURL,
      modelLabel: name,
      isCreatedByUser: message?.isCreatedByUser,
    }),
    [
      name,
      conversation?.endpoint,
      conversation?.iconURL,
      conversation?.model,
      message?.model,
      message?.iconURL,
      message?.endpoint,
      message?.isCreatedByUser,
    ],
  );

  if (!message) {
    return null;
  }

  const baseClasses = {
    common: 'group mx-auto flex flex-1 gap-3 transition-all duration-300 transform-gpu',
    chat: maximizeChatSpace
      ? 'w-full max-w-full md:px-5 lg:px-1 xl:px-5'
      : 'md:max-w-[47rem] xl:max-w-[55rem]',
  };

  return (
    <>
      <div
        className="w-full border-0 bg-transparent dark:border-0 dark:bg-transparent"
        onWheel={handleScroll}
        onTouchMove={handleScroll}
      >
        <div className="m-auto justify-center p-4 py-2 md:gap-6">
          <div
            id={messageId ?? ''}
            aria-label={getMessageAriaLabel(message, localize)}
            className={cn(baseClasses.common, baseClasses.chat, 'message-render')}
          >
            <div className="relative flex flex-shrink-0 flex-col items-center">
              <div className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full pt-0.5">
                <MessageIcon iconData={iconData} assistant={assistant} agent={agent} />
              </div>
            </div>
            <div
              className={cn(
                'relative flex w-11/12 flex-col',
                isCreatedByUser ? 'user-turn' : 'agent-turn',
              )}
            >
              <h2 className={cn('select-none font-semibold text-text-primary', fontSize)}>
                {name}
              </h2>
              <div className="flex flex-col gap-1">
                <div className="flex max-w-full flex-grow flex-col gap-0">
                  <ContextCompressionCard
                    messageId={message.messageId}
                    metrics={message.e2bContextMetrics as any}
                  />
                  <div className="relative flex w-full flex-col">
                    <ContentParts
                      edit={edit}
                      isLast={isLast}
                      enterEdit={enterEdit}
                      siblingIdx={siblingIdx}
                      attachments={attachments}
                      isSubmitting={isSubmitting}
                      searchResults={searchResults}
                      messageId={message.messageId}
                      setSiblingIdx={setSiblingIdx}
                      isCreatedByUser={message.isCreatedByUser}
                      conversationId={conversation?.conversationId}
                      isLatestMessage={messageId === latestMessage?.messageId}
                      content={message.content as Array<TMessageContentParts | undefined>}
                    />
                  </div>
                </div>
                {isLast && isSubmitting ? (
                  <div className="mt-1 h-[27px] bg-transparent" />
                ) : (
                  <SubRow classes="text-xs">
                    <SiblingSwitch
                      siblingIdx={siblingIdx}
                      siblingCount={siblingCount}
                      setSiblingIdx={setSiblingIdx}
                    />
                    <HoverButtons
                      index={index}
                      isEditing={edit}
                      message={message}
                      enterEdit={enterEdit}
                      isSubmitting={isSubmitting}
                      conversation={conversation ?? null}
                      regenerate={() => regenerateMessage()}
                      copyToClipboard={copyToClipboard}
                      handleContinue={handleContinue}
                      latestMessage={latestMessage}
                      isLast={isLast}
                    />
                  </SubRow>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <MultiMessage
        key={messageId}
        messageId={messageId}
        conversation={conversation}
        messagesTree={children ?? []}
        currentEditId={currentEditId}
        setCurrentEditId={setCurrentEditId}
      />
    </>
  );
}
