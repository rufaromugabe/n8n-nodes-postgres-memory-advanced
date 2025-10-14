import { PostgresChatMessageHistory } from '@langchain/community/stores/message/postgres';
import { BufferMemory, BufferWindowMemory } from 'langchain/memory';
import type {
	ISupplyDataFunctions,
	INodeType,
	INodeTypeDescription,
	SupplyData,
	INodeCredentialTestResult,
	ICredentialTestFunctions,
	ICredentialsDecrypted,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import pg from 'pg';

import { getSessionId } from '../../utils/helpers';
import { logWrapper } from '../../utils/logWrapper';
import { getConnectionHintNoticeField } from '../../utils/sharedFields';

import {
	sessionIdOption,
	sessionKeyProperty,
	contextWindowLengthProperty,
	expressionSessionKeyProperty,
} from './descriptions';

// Postgres credentials interface matching n8n's built-in type
interface PostgresNodeCredentials {
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	ssl?: 'disable' | 'allow' | 'require' | 'verify' | 'verify-full';
	sslCertificateAuthorityCa?: string;
	sslCertificate?: string;
	sslKey?: string;
	sslRejection?: boolean;
}

// Helper function to configure Postgres pool
async function configurePostgresPool(credentials: PostgresNodeCredentials): Promise<pg.Pool> {
	const pg = await import('pg');
	
	const config: pg.PoolConfig = {
		host: credentials.host,
		port: credentials.port,
		database: credentials.database,
		user: credentials.user,
		password: credentials.password,
	};

	// Handle SSL configuration
	if (credentials.ssl && credentials.ssl !== 'disable') {
		const sslConfig: any = {
			rejectUnauthorized: credentials.sslRejection !== false,
		};

		if (credentials.sslCertificateAuthorityCa) {
			sslConfig.ca = credentials.sslCertificateAuthorityCa;
		}
		if (credentials.sslCertificate) {
			sslConfig.cert = credentials.sslCertificate;
		}
		if (credentials.sslKey) {
			sslConfig.key = credentials.sslKey;
		}

		config.ssl = sslConfig;
	}

	return new pg.Pool(config);
}

// Helper function to create sessions table
async function ensureSessionsTableExists(
	pool: pg.Pool,
	schemaName: string,
	tableName: string,
): Promise<void> {
	const qualifiedTableName = schemaName ? `"${schemaName}"."${tableName}"` : `"${tableName}"`;
	
	const createTableQuery = `
		CREATE TABLE IF NOT EXISTS ${qualifiedTableName} (
			id VARCHAR(255) PRIMARY KEY,
			title TEXT NOT NULL,
			last_message TEXT,
			timestamp TIMESTAMPTZ DEFAULT NOW(),
			message_count INTEGER DEFAULT 0,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW()
		)
	`;
	
	await pool.query(createTableQuery);
	
	// Create index for faster queries
	const createIndexQuery = `
		CREATE INDEX IF NOT EXISTS idx_${tableName}_timestamp 
		ON ${qualifiedTableName}(timestamp DESC)
	`;
	
	await pool.query(createIndexQuery);
}

// Helper function to update session metadata
async function updateSessionMetadata(
	pool: pg.Pool,
	schemaName: string,
	tableName: string,
	sessionId: string,
	lastMessage: string,
): Promise<void> {
	const qualifiedTableName = schemaName ? `"${schemaName}"."${tableName}"` : `"${tableName}"`;
	
	// Generate title from first 50 characters of the first message (if new session)
	const title = lastMessage.substring(0, 50) + (lastMessage.length > 50 ? '...' : '');
	
	const upsertQuery = `
		INSERT INTO ${qualifiedTableName} (id, title, last_message, timestamp, message_count)
		VALUES ($1, $2, $3, NOW(), 1)
		ON CONFLICT (id) 
		DO UPDATE SET 
			last_message = $3,
			timestamp = NOW(),
			message_count = ${qualifiedTableName}.message_count + 1,
			updated_at = NOW()
	`;
	
	await pool.query(upsertQuery, [sessionId, title, lastMessage]);
}

export class MemoryPostgresAdvanced implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Postgres Memory+',
		name: 'memoryPostgresAdvanced',
		icon: 'file:postgresql.svg',
		group: ['transform'],
		version: 2,
		description: 'Stores the chat history in Postgres table with schema support.',
		defaults: {
			name: 'Postgres Memory+',
		},
		   credentials: [
			   {
				   name: 'postgres',
				   required: true,
				   testedBy: 'postgresConnectionTest',
				   // n8n built-in Postgres credential type is referenced by name only
			   },
		   ],
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Memory'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.memorypostgreschat/',
					},
				],
			},
		},

		inputs: [
			{
				displayName: 'Embeddings',
				type: NodeConnectionTypes.AiEmbedding,
				required: false,
			},
			{
				displayName: 'Vector Store',
				type: NodeConnectionTypes.AiVectorStore,
				required: false,
			},
		] as any,

		outputs: [NodeConnectionTypes.AiMemory] as any,
		outputNames: ['Memory'],
		properties: [
			getConnectionHintNoticeField([NodeConnectionTypes.AiAgent] as any),
			sessionIdOption,
			expressionSessionKeyProperty(1.2),
			sessionKeyProperty,
			{
				displayName: 'Schema Name',
				name: 'schemaName',
				type: 'string',
				default: 'public',
				description: 'The schema name where the table is located. Schema will be auto-created if it doesn\'t exist (requires CREATE SCHEMA permission).',
				placeholder: 'public',
			},
			{
				displayName: 'Table Name',
				name: 'tableName',
				type: 'string',
				default: 'n8n_chat_histories',
				description:
					'The table name to store the chat history in. If table does not exist, it will be created.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Enable Session Tracking',
						name: 'enableSessionTracking',
						type: 'boolean',
						default: false,
						description: 'Whether to track sessions in a separate table for easy loading as threads',
					},
					{
						displayName: 'Sessions Table Name',
						name: 'sessionsTableName',
						type: 'string',
						default: 'n8n_chat_sessions',
						description: 'The table name to store session metadata',
						displayOptions: {
							show: {
								enableSessionTracking: [true],
							},
						},
					},
					{
						displayName: 'Enable Semantic Search',
						name: 'enableSemanticSearch',
						type: 'boolean',
						default: false,
						description: 'Whether to enable semantic search using embeddings and vector store (requires Embeddings and Vector Store inputs to be connected)',
					},
					{
						displayName: 'Top K Results',
						name: 'topK',
						type: 'number',
						default: 3,
						description: 'Number of semantically similar messages to retrieve',
						displayOptions: {
							show: {
								enableSemanticSearch: [true],
							},
						},
					},
					{
						displayName: 'Message Range',
						name: 'messageRange',
						type: 'number',
						default: 2,
						description: 'Number of messages before and after each match to include for context',
						displayOptions: {
							show: {
								enableSemanticSearch: [true],
							},
						},
					},
				],
			},
			{
				...contextWindowLengthProperty,
				displayOptions: { hide: { '@version': [{ _cnd: { lt: 1.1 } }] } },
			},
		],
	};

	methods = {
		credentialTest: {
			async postgresConnectionTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const credentials = credential.data as unknown as PostgresNodeCredentials;
				
				try {
					const pool = await configurePostgresPool(credentials);
					const client = await pool.connect();
					await client.query('SELECT 1');
					client.release();
					await pool.end();

					return {
						status: 'OK',
						message: 'Connection successful',
					};
				} catch (error) {
					return {
						status: 'Error',
						message: error.message,
					};
				}
			},
		},
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await this.getCredentials<PostgresNodeCredentials>('postgres');
		const schemaName = this.getNodeParameter('schemaName', itemIndex, 'public') as string;
		const tableName = this.getNodeParameter('tableName', itemIndex, 'n8n_chat_histories') as string;
		const sessionId = getSessionId(this, itemIndex);
		
		// Get options
		const options = this.getNodeParameter('options', itemIndex, {}) as {
			enableSessionTracking?: boolean;
			sessionsTableName?: string;
			enableSemanticSearch?: boolean;
			topK?: number;
			messageRange?: number;
		};
		const enableSessionTracking = options.enableSessionTracking || false;
		const sessionsTableName = options.sessionsTableName || 'n8n_chat_sessions';
		const enableSemanticSearch = options.enableSemanticSearch || false;
		const topK = options.topK || 3;
		const messageRange = options.messageRange || 2;

		// Get connected nodes for semantic search
		let embeddings: any = null;
		let vectorStore: any = null;
		
		if (enableSemanticSearch) {
			this.logger.info('Semantic search enabled - checking for connected inputs...');
			const embeddingsInput = (await this.getInputConnectionData(NodeConnectionTypes.AiEmbedding, 0)) as any;
			const vectorStoreInput = (await this.getInputConnectionData(NodeConnectionTypes.AiVectorStore, 0)) as any;
			
			this.logger.info(`Embeddings input: ${embeddingsInput ? 'CONNECTED' : 'NOT CONNECTED'}`);
			this.logger.info(`Vector Store input: ${vectorStoreInput ? 'CONNECTED' : 'NOT CONNECTED'}`);
			
			// n8n returns connections as arrays - extract the first element
			if (embeddingsInput) {
				// If it's an array, get the first element, otherwise use as-is
				embeddings = Array.isArray(embeddingsInput) ? embeddingsInput[0] : embeddingsInput;
				this.logger.info('Embeddings instance obtained');
				this.logger.info(`Embeddings type: ${typeof embeddings}, constructor: ${embeddings?.constructor?.name}`);
				if (embeddings && typeof embeddings === 'object') {
					this.logger.info(`Embeddings methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(embeddings)).join(', ')}`);
				}
			}
			if (vectorStoreInput) {
				// If it's an array, get the first element, otherwise use as-is
				vectorStore = Array.isArray(vectorStoreInput) ? vectorStoreInput[0] : vectorStoreInput;
				this.logger.info('Vector Store instance obtained');
				this.logger.info(`Vector Store type: ${typeof vectorStore}, constructor: ${vectorStore?.constructor?.name}`);
				if (vectorStore && typeof vectorStore === 'object') {
					this.logger.info(`Vector Store methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(vectorStore)).join(', ')}`);
				}
			}
			
			if (enableSemanticSearch && (!embeddings || !vectorStore)) {
				throw new Error('Semantic search is enabled but Embeddings or Vector Store input is not connected. Please connect both or disable semantic search.');
			}
			
			this.logger.info('✅ Semantic search fully configured with embeddings and vector store');
		} else {
			this.logger.info('Semantic search is DISABLED');
		}

		// Configure Postgres connection pool using helper function
		const pool = await configurePostgresPool(credentials);

		// Auto-create schema if it doesn't exist (only for non-public schemas)
		if (schemaName && schemaName.toLowerCase() !== 'public') {
			try {
				const client = await pool.connect();
				try {
					// Check if schema exists, create if not
					await client.query(`CREATE SCHEMA IF NOT EXISTS ${pg.escapeIdentifier(schemaName)}`);
				} finally {
					client.release();
				}
			} catch (error) {
				// Log but don't fail - user might not have CREATE SCHEMA permissions
				this.logger.warn(`Could not create schema ${schemaName}: ${error.message}`);
			}
		}

		// Create sessions table if session tracking is enabled
		if (enableSessionTracking) {
			try {
				await ensureSessionsTableExists(pool, schemaName, sessionsTableName);
			} catch (error) {
				this.logger.warn(`Could not create sessions table: ${error.message}`);
			}
		}

		// Create the fully qualified table name with schema
		const qualifiedTableName = schemaName ? `${schemaName}.${tableName}` : tableName;

		const pgChatHistory = new PostgresChatMessageHistory({
			pool,
			sessionId,
			tableName: qualifiedTableName,
		});

		// Wrap the chat history to track session metadata and/or semantic search (non-blocking)
		if (enableSessionTracking || enableSemanticSearch) {
			const originalAddMessage = pgChatHistory.addMessage.bind(pgChatHistory);
			pgChatHistory.addMessage = async (message: any) => {
				// First, add the message to history (primary function - blocking)
				await originalAddMessage(message);
				
				const messageContent = typeof message.content === 'string' 
					? message.content 
					: JSON.stringify(message.content);
				
				// Update session metadata (non-blocking - fire and forget)
				if (enableSessionTracking) {
					updateSessionMetadata(pool, schemaName, sessionsTableName, sessionId, messageContent)
						.catch((error) => {
							this.logger.warn(`Could not update session metadata: ${error.message}`);
						});
				}
				
				// Store embedding in vector store (non-blocking - fire and forget)
				if (enableSemanticSearch && embeddings && vectorStore) {
					(async () => {
						try {
							// Store in vector store with metadata using LangChain VectorStore API
							// The vector store will handle embedding generation internally
							await vectorStore.addDocuments([
								{
									pageContent: messageContent,
									metadata: {
										sessionId,
										messageType: message._getType(),
										timestamp: new Date().toISOString(),
									}
								}
							]);
						} catch (error: any) {
							this.logger.warn(`Could not store message embedding: ${error.message}`);
						}
					})();
				}
			};
		}

		const memClass = this.getNode().typeVersion < 1.1 ? BufferMemory : BufferWindowMemory;
		const kOptions =
			this.getNode().typeVersion < 1.1
				? {}
				: { k: this.getNodeParameter('contextWindowLength', itemIndex) };

		const memory = new memClass({
			memoryKey: 'chat_history',
			chatHistory: pgChatHistory,
			returnMessages: true,
			inputKey: 'input',
			outputKey: 'output',
			...kOptions,
		});

		// Extend memory with semantic search if enabled
		if (enableSemanticSearch && embeddings && vectorStore) {
			this.logger.info('Semantic search is ENABLED - extending memory with semantic retrieval');
			const originalLoadMemoryVariables = memory.loadMemoryVariables.bind(memory);
			
			memory.loadMemoryVariables = async (values: any) => {
				this.logger.info(`loadMemoryVariables called with values: ${JSON.stringify(values)}`);
				
				// Get regular memory (recent messages)
				const regularMemory = await originalLoadMemoryVariables(values);
				this.logger.info(`Regular memory loaded: ${JSON.stringify(regularMemory)}`);
				
				// Perform semantic search if there's an input query
				const inputText = values.input || values.question || '';
				this.logger.info(`Input text for semantic search: "${inputText}"`);
				
				if (inputText && typeof inputText === 'string') {
					try {
						// Generate embedding for the query
						const queryEmbedding = await embeddings.embedQuery(inputText);
						
						// Search for similar messages in this session
						// Note: MemoryVectorStore doesn't support filtering, so we search all and filter results
						const allResults = await vectorStore.similaritySearchVectorWithScore(
							queryEmbedding,
							topK * 3 // Get more results to filter by session
						);
						
						// Filter results by sessionId and take top K
						const results = allResults
							.filter((result: any) => result[0].metadata?.sessionId === sessionId)
							.slice(0, topK);
						
						// Log semantic search results for debugging
						this.logger.info(`Semantic search found ${results.length} similar messages (from ${allResults.length} total)`);
						if (results.length > 0) {
							this.logger.info(`Top match: "${results[0][0].pageContent.substring(0, 50)}..." (score: ${results[0][1]})`);
						}
						
						// Retrieve context messages if messageRange is set
						if (results.length > 0 && messageRange > 0) {
							// Get all messages from chat history to find context
							const allMessages = await pgChatHistory.getMessages();
							
							// Build enriched context with surrounding messages
							const enrichedContexts: string[] = [];
							
							for (const result of results) {
								const matchedContent = result[0].pageContent;
								const score = result[1];
								
								// Find the index of this message in the full history
								const matchIndex = allMessages.findIndex(
									(msg: any) => {
										const content = typeof msg.content === 'string' 
											? msg.content 
											: JSON.stringify(msg.content);
										return content === matchedContent;
									}
								);
								
								if (matchIndex !== -1) {
									// Calculate the range boundaries
									const startIdx = Math.max(0, matchIndex - messageRange);
									const endIdx = Math.min(allMessages.length - 1, matchIndex + messageRange);
									
									// Extract context messages
									const contextMessages = allMessages.slice(startIdx, endIdx + 1);
									const contextText = contextMessages.map((msg: any, idx: number) => {
										const content = typeof msg.content === 'string' 
											? msg.content 
											: JSON.stringify(msg.content);
										const role = msg._getType ? msg._getType() : 'unknown';
										const marker = (startIdx + idx) === matchIndex ? '→ ' : '  ';
										return `${marker}[${role}]: ${content}`;
									}).join('\n');
									
									enrichedContexts.push(
										`[Relevant context (score: ${score.toFixed(3)})]:\n${contextText}`
									);
								} else {
									// Fallback if message not found in history
									enrichedContexts.push(`[Relevant context]: ${matchedContent}`);
								}
							}
							
							const semanticContext = enrichedContexts.join('\n\n---\n\n');
							this.logger.info(`Generated enriched semantic context: ${semanticContext.substring(0, 200)}...`);
							
							// Inject semantic context as a system message at the beginning
							if (regularMemory.chat_history && Array.isArray(regularMemory.chat_history)) {
								const { SystemMessage } = await import('@langchain/core/messages');
								const contextMessage = new SystemMessage(
									`RELEVANT CONTEXT FROM PAST CONVERSATIONS:\n\n${semanticContext}\n\nUse this context to inform your response.`
								);
								regularMemory.chat_history.unshift(contextMessage);
								this.logger.info('✅ Semantic context injected as system message');
							}
						} else if (results.length > 0) {
							// No message range, just return the matched messages
							const semanticContext = results
								.map((result: any) => `[Relevant context]: ${result[0].pageContent}`)
								.join('\n');
							
							this.logger.info(`Generated simple semantic context: ${semanticContext.substring(0, 200)}...`);
							
							// Inject semantic context as a system message at the beginning
							if (regularMemory.chat_history && Array.isArray(regularMemory.chat_history)) {
								const { SystemMessage } = await import('@langchain/core/messages');
								const contextMessage = new SystemMessage(
									`RELEVANT CONTEXT FROM PAST CONVERSATIONS:\n\n${semanticContext}\n\nUse this context to inform your response.`
								);
								regularMemory.chat_history.unshift(contextMessage);
								this.logger.info('✅ Semantic context injected as system message');
							}
						} else {
							this.logger.info('No semantic results found - skipping context injection');
						}
					} catch (error: any) {
						this.logger.warn(`Semantic search failed: ${error.message}`);
					}
				} else {
					this.logger.info('No input text provided - skipping semantic search');
				}
				
				return regularMemory;
			};
		}

		return {
			response: logWrapper(memory, this),
		};
	}
}
