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
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
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

// Create sessions table with required columns and indexes
async function createSessionsTable(
	pool: pg.Pool,
	schemaName: string,
	tableName: string,
): Promise<void> {
	const qualifiedTableName = schemaName ? `"${schemaName}"."${tableName}"` : `"${tableName}"`;

	const createTableQuery = `
		CREATE TABLE IF NOT EXISTS ${qualifiedTableName} (
			id VARCHAR(255) PRIMARY KEY,
			user_id VARCHAR(255),
			title TEXT NOT NULL,
			last_message TEXT,
			timestamp TIMESTAMPTZ DEFAULT NOW(),
			message_count INTEGER DEFAULT 0,
			working_memory JSONB DEFAULT '{}'::jsonb,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW()
		)
	`;

	await pool.query(createTableQuery);

	// Create indexes for faster queries
	const createIndexQueries = [
		`CREATE INDEX IF NOT EXISTS idx_${tableName}_timestamp ON ${qualifiedTableName}(timestamp DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_${tableName}_user_id ON ${qualifiedTableName}(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_${tableName}_user_timestamp ON ${qualifiedTableName}(user_id, timestamp DESC)`
	];

	for (const indexQuery of createIndexQueries) {
		await pool.query(indexQuery);
	}
}

// Create user memory table for persistent user data
async function createUserMemoryTable(
	pool: pg.Pool,
	schemaName: string,
	tableName: string,
): Promise<void> {
	const qualifiedTableName = schemaName ? `"${schemaName}"."${tableName}_user_memory"` : `"${tableName}_user_memory"`;

	const createTableQuery = `
		CREATE TABLE IF NOT EXISTS ${qualifiedTableName} (
			user_id VARCHAR(255) PRIMARY KEY,
			working_memory JSONB NOT NULL,
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW()
		)
	`;

	await pool.query(createTableQuery);

	// Create index for faster queries
	const createIndexQuery = `
		CREATE INDEX IF NOT EXISTS idx_${tableName}_user_memory_updated 
		ON ${qualifiedTableName}(updated_at DESC)
	`;

	await pool.query(createIndexQuery);
}

// Initialize database tables and indexes
async function initializeDatabaseStructures(
	pool: pg.Pool,
	schemaName: string,
	sessionsTableName: string,
): Promise<void> {
	try {
		await Promise.all([
			createSessionsTable(pool, schemaName, sessionsTableName),
			createUserMemoryTable(pool, schemaName, sessionsTableName),
		]);
	} catch (error) {
		console.warn('Database initialization warning:', error);
	}
}

// Set up initial working memory for new users
async function setupUserWorkingMemory(
	pool: pg.Pool,
	schemaName: string,
	tableName: string,
	userId: string,
	workingMemoryTemplate: string,
): Promise<void> {
	const qualifiedUserMemoryTable = schemaName ? `"${schemaName}"."${tableName}_user_memory"` : `"${tableName}_user_memory"`;

	try {
		// Parse the JSON template
		const parsedTemplate = typeof workingMemoryTemplate === 'string'
			? JSON.parse(workingMemoryTemplate)
			: workingMemoryTemplate;

		// Insert user memory if it doesn't exist (ON CONFLICT DO NOTHING)
		const query = `
			INSERT INTO ${qualifiedUserMemoryTable} (user_id, working_memory, created_at, updated_at)
			VALUES ($1, $2::jsonb, NOW(), NOW())
			ON CONFLICT (user_id) DO NOTHING
		`;

		await pool.query(query, [userId, JSON.stringify(parsedTemplate)]);
	} catch (error) {
		console.warn('Could not initialize user working memory:', error);
	}
}

// Update session information and metadata
async function updateSessionMetadata(
	pool: pg.Pool,
	schemaName: string,
	tableName: string,
	sessionId: string,
	lastMessage: string,
	userId?: string,
	workingMemoryTemplate?: string,
	workingMemoryScope?: 'thread' | 'user',
): Promise<void> {
	const qualifiedTableName = schemaName ? `"${schemaName}"."${tableName}"` : `"${tableName}"`;

	const title = lastMessage.substring(0, 50) + (lastMessage.length > 50 ? '...' : '');

	let workingMemoryData = null;
	if (workingMemoryTemplate && workingMemoryScope === 'thread') {
		try {
			workingMemoryData = typeof workingMemoryTemplate === 'string'
				? JSON.parse(workingMemoryTemplate)
				: workingMemoryTemplate;
		} catch (error) {
			console.warn('Invalid working memory template JSON, using empty object:', error);
			workingMemoryData = {};
		}
	}

	const upsertQuery = `
		INSERT INTO ${qualifiedTableName} (id, user_id, title, last_message, timestamp, message_count, working_memory)
		VALUES ($1, $2, $3, $4, NOW(), 1, $5)
		ON CONFLICT (id) 
		DO UPDATE SET 
			user_id = EXCLUDED.user_id,
			last_message = EXCLUDED.last_message,
			timestamp = NOW(),
			message_count = ${qualifiedTableName}.message_count + 1,
			updated_at = NOW()
	`;

	await pool.query(upsertQuery, [sessionId, userId || null, title, lastMessage, JSON.stringify(workingMemoryData)]);
}

// Retrieve working memory for a session or user
async function getWorkingMemory(
	pool: pg.Pool,
	schemaName: string,
	tableName: string,
	sessionId: string,
	scope: 'thread' | 'user' = 'thread',
	userId?: string,
): Promise<any | null> {
	if (scope === 'user' && userId) {
		// User-scoped: Get working memory from dedicated user memory table
		const qualifiedUserMemoryTable = schemaName ? `"${schemaName}"."${tableName}_user_memory"` : `"${tableName}_user_memory"`;
		const query = `
			SELECT working_memory
			FROM ${qualifiedUserMemoryTable}
			WHERE user_id = $1
			LIMIT 1
		`;
		const result = await pool.query(query, [userId]);
		return result.rows[0]?.working_memory || null;
	} else {
		// Thread-scoped: Get working memory for specific session
		const qualifiedTableName = schemaName ? `"${schemaName}"."${tableName}"` : `"${tableName}"`;
		const query = `
			SELECT working_memory
			FROM ${qualifiedTableName}
			WHERE id = $1
			LIMIT 1
		`;
		const result = await pool.query(query, [sessionId]);
		return result.rows[0]?.working_memory || null;
	}
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

		inputs: `={{ (() => {
			const options = $parameter.options || {};
			const enableSemanticSearch = options.enableSemanticSearch || false;
			
			if (!enableSemanticSearch) {
				return [];
			}
			
			return [
				{
					displayName: 'Vector Store',
					type: '${NodeConnectionTypes.AiVectorStore}',
					required: true,
					maxConnections: 1,
				},
			];
		})() }}` as any,

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
					{
						displayName: 'Semantic Search',
						name: 'enableSemanticSearch',
						type: 'boolean',
						default: false,
						description: 'Whether to enable semantic search using embeddings and vector store (requires Vector Store input to be connected)',
					},
					{
						displayName: 'Session Tracking',
						name: 'enableSessionTracking',
						type: 'boolean',
						default: false,
						description: 'Whether to track sessions in a separate table for easy loading as threads. NOTE: This is purely for UI purposes (sessions list). Disable if not needed to improve performance. Working Memory requires this to be enabled.',
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
						displayName: 'User ID',
						name: 'userId',
						type: 'string',
						default: '={{ $json.userId }}',
						description: 'Optional user identifier for session tracking and working memory scoping. Leave empty if not needed.',
						displayOptions: {
							show: {
								enableSessionTracking: [true],
							},
						},
					},
					{
						displayName: 'Working Memory',
						name: 'enableWorkingMemory',
						type: 'boolean',
						default: false,
						description: 'Whether to enable working memory - persistent user information that the agent can update',
						displayOptions: {
							show: {
								enableSessionTracking: [true],
							},
						},
					},
					{
						displayName: 'Working Memory Scope',
						name: 'workingMemoryScope',
						type: 'options',
						options: [
							{
								name: 'Thread-Scoped',
								value: 'thread',
								description: 'Working memory is isolated per conversation thread',
							},
							{
								name: 'User-Scoped',
								value: 'user',
								description: 'Working memory persists across all threads for the same user (requires User ID)',
							},
						],
						default: 'thread',
						description: 'Choose how working memory is scoped - per thread or per user',
						displayOptions: {
							show: {
								enableWorkingMemory: [true],
							},
						},
					},
					{
						displayName: 'Working Memory Template',
						name: 'workingMemoryTemplate',
						type: 'json',
						typeOptions: {
							rows: 10,
						},
						default: `{
  "name": "",
  "location": "",
  "occupation": "",
  "interests": [],
  "goals": [],
  "events": [],
  "facts": [],
  "projects": [],
  "preferences": {}
}`,
						description: 'JSON template for working memory base structure. Agent can extend this with additional fields (surname, gender, age, etc.) as needed. Provides structured foundation with extensibility.',
						displayOptions: {
							show: {
								enableWorkingMemory: [true],
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
			userId?: string;
			enableSemanticSearch?: boolean;
			topK?: number;
			messageRange?: number;
			enableWorkingMemory?: boolean;
			workingMemoryScope?: 'thread' | 'user';
			workingMemoryTemplate?: string;
		};
		const enableSessionTracking = options.enableSessionTracking || false;
		const sessionsTableName = options.sessionsTableName || 'n8n_chat_sessions';
		const userId = enableSessionTracking ? (options.userId || '') : '';
		const enableSemanticSearch = options.enableSemanticSearch || false;
		const topK = options.topK || 3;
		const messageRange = options.messageRange || 2;
		const enableWorkingMemory = options.enableWorkingMemory || false;
		const workingMemoryScope = options.workingMemoryScope || 'thread';
		const workingMemoryTemplate = options.workingMemoryTemplate || `{
  "name": "",
  "location": "",
  "occupation": "",
  "interests": [],
  "goals": [],
  "events": [],
  "facts": [],
  "projects": [],
  "preferences": {}
}`;

		// Get connected vector store for semantic search
		let vectorStore: any = null;

		if (enableSemanticSearch) {
			this.logger.info('Semantic search enabled - checking for connected inputs...');
			const vectorStoreInput = (await this.getInputConnectionData(NodeConnectionTypes.AiVectorStore, 0)) as any;

			this.logger.info(`Vector Store input: ${vectorStoreInput ? 'CONNECTED' : 'NOT CONNECTED'}`);

			// Validate that vector store is connected when semantic search is enabled
			if (!vectorStoreInput) {
				throw new NodeOperationError(
					this.getNode(),
					'Semantic search is enabled but Vector Store input is not connected. Please connect a Vector Store or disable semantic search.'
				);
			}

			// Extract vector store
			vectorStore = Array.isArray(vectorStoreInput) ? vectorStoreInput[0] : vectorStoreInput;
			this.logger.info('Vector Store instance obtained');
			this.logger.info(`Vector Store type: ${typeof vectorStore}, constructor: ${vectorStore?.constructor?.name}`);
			if (vectorStore && typeof vectorStore === 'object') {
				this.logger.info(`Vector Store methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(vectorStore)).join(', ')}`);
			}

			this.logger.info('✅ Semantic search configured - using vector store\'s internal embedding model');
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
				await initializeDatabaseStructures(pool, schemaName, sessionsTableName);
				this.logger.info('✅ Database structures initialized');
			} catch (error) {
				this.logger.warn(`Could not create database structures: ${error.message}`);
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
				const messageContent = typeof message.content === 'string'
					? message.content
					: JSON.stringify(message.content);

				// Add the message to history
				await originalAddMessage(message);

				// Update session information in background
				if (enableSessionTracking) {
					setImmediate(() => {
						updateSessionMetadata(pool, schemaName, sessionsTableName, sessionId, messageContent,
							userId || undefined, enableWorkingMemory ? workingMemoryTemplate : undefined, workingMemoryScope)
							.catch((error) => {
								this.logger.warn(`Could not update session metadata: ${error.message}`);
							});
					});

					// Set up working memory for new users
					if (enableWorkingMemory && workingMemoryScope === 'user' && userId) {
						setImmediate(() => {
							setupUserWorkingMemory(pool, schemaName, sessionsTableName, userId, workingMemoryTemplate)
								.catch((error) => {
									this.logger.warn(`Could not set up user working memory: ${error.message}`);
								});
						});
					}
				}

				// Store message embeddings for semantic search
				if (enableSemanticSearch && vectorStore) {
					(async () => {
						try {
							await vectorStore.addDocuments([{
								pageContent: messageContent,
								metadata: {
									sessionId,
									messageType: message._getType(),
									timestamp: new Date().toISOString(),
								}
							}]);
							this.logger.info(`✅ Message embedded and stored in vector store`);
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

		// Extend memory with working memory and/or semantic search if enabled
		if (enableWorkingMemory || enableSemanticSearch) {
			const originalLoadMemoryVariables = memory.loadMemoryVariables.bind(memory);
			const contextWindowLength = this.getNode().typeVersion < 1.1 ? Infinity : (kOptions.k as number);

			memory.loadMemoryVariables = async (values: any) => {
				this.logger.info(`loadMemoryVariables called with values: ${JSON.stringify(values)}`);

				// Load chat history and working memory in parallel
				const loadPromises: Promise<any>[] = [
					originalLoadMemoryVariables(values),
				];

				if (enableWorkingMemory && enableSessionTracking) {
					loadPromises.push(
						getWorkingMemory(pool, schemaName, sessionsTableName, sessionId, workingMemoryScope, userId || undefined)
					);
				}

				const results = await Promise.all(loadPromises);
				const regularMemory = results[0];
				const workingMemory = enableWorkingMemory && enableSessionTracking ? results[1] : null;

				this.logger.info(`✅ Memory loaded successfully`);

				// Inject working memory at the beginning (if enabled and session tracking is enabled)
				if (enableWorkingMemory && enableSessionTracking && regularMemory.chat_history && Array.isArray(regularMemory.chat_history)) {
					try {
						// Use template if no existing working memory
						let workingMemoryData = workingMemory;
						if (!workingMemoryData) {
							// Parse the template as JSON
							try {
								workingMemoryData = typeof workingMemoryTemplate === 'string'
									? JSON.parse(workingMemoryTemplate)
									: workingMemoryTemplate;
							} catch (error) {
								this.logger.warn('Invalid working memory template JSON, using empty object');
								workingMemoryData = {};
							}
						}

						const { SystemMessage } = await import('@langchain/core/messages');

						// Create system message with working memory as structured JSON
						// Note: Update instructions are provided by the Working Memory Tool node
						const scopeDescription = workingMemoryScope === 'user'
							? `across ALL conversations for user ${userId || 'current user'}`
							: 'for this conversation thread';

						const workingMemoryContent = `WORKING_MEMORY: Persistent user information ${scopeDescription}.

Current Memory (JSON format):
\`\`\`json
${JSON.stringify(workingMemoryData, null, 2)}
\`\`\`

UPDATE INSTRUCTIONS:
When user shares personal information, use Working Memory Tool with this EXACT approach:

1. START with the current memory object above
2. UPDATE existing fields with new data (keep empty "" if no data)
3. ADD new fields for any additional information (surname, gender, age, etc.)
4. SEND the complete merged object

EXAMPLE - If user says "My name is John Smith and I'm male":
- Keep ALL existing fields from current memory
- Update "name": "John" 
- ADD "surname": "Smith"
- ADD "gender": "male"
- Send complete object with ALL original fields + new fields

CRITICAL RULES:
✅ ALWAYS include ALL fields from current memory
✅ ADD new fields for additional info (surname, gender, age, phone, etc.)
✅ Keep empty values ("", []) until real data is available
❌ NEVER remove or omit existing fields
❌ NEVER send partial objects

The goal is EXTENSIBLE SCHEMA: structured base + dynamic field addition as users share more information.`;

						const workingMemoryMessage = new SystemMessage(workingMemoryContent);

						// Inject at the beginning of chat history
						regularMemory.chat_history.unshift(workingMemoryMessage);
						this.logger.info('✅ Working memory injected into context as structured JSON');
					} catch (error: any) {
						this.logger.warn(`Could not load working memory: ${error.message}`);
					}
				}

				// Perform semantic search if enabled
				if (enableSemanticSearch && vectorStore) {
					// Check if context window is full by looking at loaded messages
					// If we have fewer messages than the window size, no need for semantic search
					const loadedMessages = regularMemory.chat_history || [];
					const loadedCount = Array.isArray(loadedMessages) ? loadedMessages.length : 0;
					const isWindowFull = loadedCount >= contextWindowLength;

					this.logger.info(`Loaded messages: ${loadedCount}, Context window: ${contextWindowLength}, Window full: ${isWindowFull}`);

					// Only perform semantic search if context window is full (meaning there are older messages not in recent context)
					if (isWindowFull) {
						// Perform semantic search if there's an input query
						const inputText = values.input || values.question || '';
						this.logger.info(`Input text for semantic search: "${inputText}"`);

						if (inputText && typeof inputText === 'string') {
							try {
								// Use the vector store's internal similarity search and embedding model
								this.logger.info('Using vector store\'s internal embedding model for query');
								const allResults = await vectorStore.similaritySearchWithScore(
									inputText,
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

								// Retrieve and inject relevant messages directly into chat history
								if (results.length > 0 && regularMemory.chat_history && Array.isArray(regularMemory.chat_history)) {
									// Get all messages from chat history
									const allMessages = await pgChatHistory.getMessages();
									const retrievedMessages: any[] = [];
									const seenIndices = new Set<number>();

									for (const result of results) {
										const matchedContent = result[0].pageContent;

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

											// Collect messages in range, avoiding duplicates
											for (let i = startIdx; i <= endIdx; i++) {
												if (!seenIndices.has(i)) {
													seenIndices.add(i);
													retrievedMessages.push(allMessages[i]);
												}
											}
										}
									}

									// Sort by original order and inject at the beginning with clear demarcation
									if (retrievedMessages.length > 0) {
										const { SystemMessage } = await import('@langchain/core/messages');
										const startMarker = new SystemMessage('=== Relevant Context from Earlier Conversation ===');
										const endMarker = new SystemMessage('=== Current Conversation ===');
										regularMemory.chat_history.unshift(startMarker, ...retrievedMessages, endMarker);
										this.logger.info(`✅ Injected ${retrievedMessages.length} context messages`);
									} else {
										this.logger.info('No semantic results found - skipping context injection');
									}
								}
							} catch (error: any) {
								this.logger.warn(`Semantic search failed: ${error.message}`);
							}
						} else {
							this.logger.info('No input text provided - skipping semantic search');
						}
					} else {
						this.logger.info('Context window not full - skipping semantic search for better performance');
					}
				}

				return regularMemory;
			};
		}

		return {
			response: logWrapper(memory, this),
		};
	}
}
