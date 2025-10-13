import type { ISupplyDataFunctions, IWebhookFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

/**
 * Get session ID from the context, supporting multiple input methods
 * Based on n8n's built-in memory helper implementation
 */
export function getSessionId(
	ctx: ISupplyDataFunctions | IWebhookFunctions,
	itemIndex: number,
	selectorKey = 'sessionIdType',
	autoSelect = 'fromInput',
	customKey = 'sessionKey',
): string {
	let sessionId = '';
	const selectorType = ctx.getNodeParameter(selectorKey, itemIndex) as string;

	if (selectorType === autoSelect) {
		// If memory node is used in webhook like node(like chat trigger node), it doesn't have access to evaluateExpression
		// so we try to extract sessionId from the bodyData
		if ('getBodyData' in ctx) {
			const bodyData = ctx.getBodyData() ?? {};
			sessionId = bodyData.sessionId as string;
		} else {
			sessionId = ctx.evaluateExpression('{{ $json.sessionId }}', itemIndex) as string;

			// try to get sessionId from chat trigger
			if (!sessionId || sessionId === undefined) {
				try {
					const chatTrigger = ctx.getChatTrigger();

					if (chatTrigger) {
						sessionId = ctx.evaluateExpression(
							`{{ $('${chatTrigger.name}').first().json.sessionId }}`,
							itemIndex,
						) as string;
					}
				} catch (error) {
					// Ignore error if chat trigger is not available
				}
			}
		}

		if (sessionId === '' || sessionId === undefined) {
			throw new NodeOperationError(ctx.getNode(), 'No session ID found', {
				description:
					"Expected to find the session ID in an input field called 'sessionId' (this is what the chat trigger node outputs). To use something else, change the 'Session ID' parameter",
				itemIndex,
			});
		}
	} else {
		sessionId = ctx.getNodeParameter(customKey, itemIndex, '') as string;
		if (sessionId === '' || sessionId === undefined) {
			throw new NodeOperationError(ctx.getNode(), 'Key parameter is empty', {
				description:
					"Provide a key to use as session ID in the 'Key' parameter or use the 'Connected Chat Trigger Node' option to use the session ID from your Chat Trigger",
				itemIndex,
			});
		}
	}

	return sessionId;
}
