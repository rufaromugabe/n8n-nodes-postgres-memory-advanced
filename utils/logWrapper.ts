import type { BaseChatMemory } from 'langchain/memory';
import type { BaseChatMessageHistory } from '@langchain/core/chat_history';
import type { InputValues, MemoryVariables, OutputValues } from '@langchain/core/memory';
import type { BaseMessage } from '@langchain/core/messages';
import type {
	IDataObject,
	IExecuteFunctions,
	ISupplyDataFunctions,
	NodeConnectionType,
} from 'n8n-workflow';
import {
	NodeOperationError,
	NodeConnectionTypes,
	parseErrorMetadata,
	jsonStringify,
} from 'n8n-workflow';

// Helper type checkers
function hasMethods<T>(obj: unknown, ...methodNames: Array<string | symbol>): obj is T {
	return methodNames.every(
		(methodName) =>
			typeof obj === 'object' &&
			obj !== null &&
			methodName in obj &&
			typeof (obj as Record<string | symbol, unknown>)[methodName] === 'function',
	);
}

function isBaseChatMemory(obj: unknown): obj is BaseChatMemory {
	return hasMethods<BaseChatMemory>(obj, 'loadMemoryVariables', 'saveContext');
}

function isBaseChatMessageHistory(obj: unknown): obj is BaseChatMessageHistory {
	return hasMethods<BaseChatMessageHistory>(obj, 'getMessages', 'addMessage');
}

function logAiEvent(
	executeFunctions: IExecuteFunctions | ISupplyDataFunctions,
	event: string,
	data?: IDataObject,
) {
	try {
		executeFunctions.logAiEvent(event as any, data ? jsonStringify(data) : undefined);
	} catch (error) {
		executeFunctions.logger.debug(`Error logging AI event: ${event}`);
	}
}

async function callMethodAsync<T>(
	this: T,
	parameters: {
		executeFunctions: IExecuteFunctions | ISupplyDataFunctions;
		connectionType: NodeConnectionType;
		currentNodeRunIndex: number;
		method: (...args: any[]) => Promise<unknown>;
		arguments: unknown[];
	},
): Promise<unknown> {
	try {
		return await parameters.method.call(this, ...parameters.arguments);
	} catch (e) {
		const connectedNode = parameters.executeFunctions.getNode();

		const error = new NodeOperationError(connectedNode, e, {
			functionality: 'configuration-node',
		});

		const metadata = parseErrorMetadata(error);
		parameters.executeFunctions.addOutputData(
			parameters.connectionType,
			parameters.currentNodeRunIndex,
			error,
			metadata,
		);

		if (error.message) {
			if (!error.description) {
				error.description = error.message;
			}
			throw error;
		}

		throw new NodeOperationError(
			connectedNode,
			`Error on node "${connectedNode.name}" which is connected via input "${parameters.connectionType}"`,
			{ functionality: 'configuration-node' },
		);
	}
}

export function logWrapper<T extends BaseChatMemory | BaseChatMessageHistory>(
	originalInstance: T,
	executeFunctions: IExecuteFunctions | ISupplyDataFunctions,
): T {
	return new Proxy(originalInstance, {
		get: (target, prop) => {
			let connectionType: NodeConnectionType | undefined;
			
			// ========== BaseChatMemory ==========
			if (isBaseChatMemory(originalInstance)) {
				if (prop === 'loadMemoryVariables' && 'loadMemoryVariables' in target) {
					return async (values: InputValues): Promise<MemoryVariables> => {
						connectionType = NodeConnectionTypes.AiMemory;

						const { index } = executeFunctions.addInputData(connectionType, [
							[{ json: { action: 'loadMemoryVariables', values } }],
						]);

						const response = (await callMethodAsync.call(target, {
							executeFunctions,
							connectionType,
							currentNodeRunIndex: index,
							method: target[prop],
							arguments: [values],
						})) as MemoryVariables;

						const chatHistory = (response?.chat_history as BaseMessage[]) ?? response;

						executeFunctions.addOutputData(connectionType, index, [
							[{ json: { action: 'loadMemoryVariables', chatHistory } }],
						]);
						return response;
					};
				} else if (prop === 'saveContext' && 'saveContext' in target) {
					return async (input: InputValues, output: OutputValues): Promise<MemoryVariables> => {
						connectionType = NodeConnectionTypes.AiMemory;

						const { index } = executeFunctions.addInputData(connectionType, [
							[{ json: { action: 'saveContext', input, output } }],
						]);

						const response = (await callMethodAsync.call(target, {
							executeFunctions,
							connectionType,
							currentNodeRunIndex: index,
							method: target[prop],
							arguments: [input, output],
						})) as MemoryVariables;

						const chatHistory = await target.chatHistory.getMessages();

						executeFunctions.addOutputData(connectionType, index, [
							[{ json: { action: 'saveContext', chatHistory } }],
						]);

						return response;
					};
				}
			}

			// ========== BaseChatMessageHistory ==========
			if (isBaseChatMessageHistory(originalInstance)) {
				if (prop === 'getMessages' && 'getMessages' in target) {
					return async (): Promise<BaseMessage[]> => {
						connectionType = NodeConnectionTypes.AiMemory;
						const { index } = executeFunctions.addInputData(connectionType, [
							[{ json: { action: 'getMessages' } }],
						]);

						const response = (await callMethodAsync.call(target, {
							executeFunctions,
							connectionType,
							currentNodeRunIndex: index,
							method: target[prop],
							arguments: [],
						})) as BaseMessage[];

						const payload = { action: 'getMessages', response };
						executeFunctions.addOutputData(connectionType, index, [[{ json: payload }]]);

						logAiEvent(executeFunctions, 'ai-messages-retrieved-from-memory', { response });
						return response;
					};
				} else if (prop === 'addMessage' && 'addMessage' in target) {
					return async (message: BaseMessage): Promise<void> => {
						connectionType = NodeConnectionTypes.AiMemory;
						const payload = { action: 'addMessage', message };
						const { index } = executeFunctions.addInputData(connectionType, [[{ json: payload }]]);

						await callMethodAsync.call(target, {
							executeFunctions,
							connectionType,
							currentNodeRunIndex: index,
							method: target[prop],
							arguments: [message],
						});

						logAiEvent(executeFunctions, 'ai-message-added-to-memory', { message });
						executeFunctions.addOutputData(connectionType, index, [[{ json: payload }]]);
					};
				}
			}

			return (target as any)[prop];
		},
	});
}
