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
		version: 1,
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

		inputs: [],

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
		};
		const enableSessionTracking = options.enableSessionTracking || false;
		const sessionsTableName = options.sessionsTableName || 'n8n_chat_sessions';

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

		// Wrap the chat history to track session metadata (non-blocking)
		if (enableSessionTracking) {
			const originalAddMessage = pgChatHistory.addMessage.bind(pgChatHistory);
			pgChatHistory.addMessage = async (message: any) => {
				// First, add the message to history (primary function - blocking)
				await originalAddMessage(message);
				
				// Then, update session metadata in background (non-blocking - fire and forget)
				const messageContent = typeof message.content === 'string' 
					? message.content 
					: JSON.stringify(message.content);
				
				// Fire and forget - don't await, don't block agent response
				updateSessionMetadata(pool, schemaName, sessionsTableName, sessionId, messageContent)
					.catch((error) => {
						this.logger.warn(`Could not update session metadata: ${error.message}`);
					});
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

		return {
			response: logWrapper(memory, this),
		};
	}
}
